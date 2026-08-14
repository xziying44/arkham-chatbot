/**
 * 卡组分类排序（Layer 3）：等价移植旧 create_deck.py 的 organize_deck + asset_slot_weight。
 *
 * 输入 ArkhamDB deck JSON + 合并元数据，输出按类别分好、排好序的 OrganizedDeck。
 * 卡牌库没有的卡（meta 查不到）记入 warnings，不中断。
 *
 * 分类规则（与旧版一致）：
 * - restrictions 含 "investigator:" → 调查员专属卡（签名卡）
 * - type_code=asset 且 permanent → 永久支援
 * - type_code=asset/event/skill → 对应块
 * - 其它 type（location/enemy/treachery/...）跳过（旧版同款行为）
 *
 * 排序规则（与旧版一致）：
 * - 永久支援：(xp, cost)
 * - 支援：(slotWeight, xp, cost)
 * - 事件：(cost, xp)
 * - 技能：(xp,)
 * - 副卡：(xp, cost)
 */
import type { ArkhamDeck } from "./fetch-deck.ts";
import type { CardMeta } from "../data/card-metadata.ts";
import { factionColor } from "../theme.ts";

/** 一张分好类的卡（保留 count，展开由 auto-layout 做）。 */
export interface OrganizedCard {
	/** 用于取图的 code；taboo 命中时带 -t 后缀（resolver 会回退原图）。 */
	code: string;
	/** 原始 code（去 -t）。 */
	baseCode: string;
	name: string;
	count: number;
	xp: number;
	cost: number;
	slot?: string;
	slotWeight?: number;
}

export interface OrganizedDeck {
	investigator: { code: string; name: string; faction: string; cards: OrganizedCard[] };
	/** 阵营边框色 hex。 */
	borderColor: string;
	tabooId: number | null;
	permanentAsset: OrganizedCard[];
	asset: OrganizedCard[];
	event: OrganizedCard[];
	skill: OrganizedCard[];
	sideCards: OrganizedCard[];
	/** 主卡组总张数（含重复，= slots value 之和，仅含可分类卡）。 */
	totalCards: number;
	/** 未识别卡的 code 列表（meta 查不到）。 */
	warnings: string[];
}

/**
 * 资产部位权重（移植 asset_slot_weight）。
 * 同时兼容英文（标准 ArkhamDB）与中文 slot 值。
 */
export function assetSlotWeight(slot?: string): number {
	if (!slot) return 8;
	const s = slot.toLowerCase();
	if (s.includes("hand x2") || s.includes("手部 x2")) return 2;
	if (s.includes("hand") || s.includes("手部")) return 1;
	if (s.includes("body") || s.includes("服装")) return 3;
	if (s.includes("accessory") || s.includes("饰品")) return 4;
	if (s.includes("arcane") || s.includes("法术")) return 5;
	if (s.includes("ally") || s.includes("盟友")) return 6;
	if (s.includes("tarot") || s.includes("塔罗")) return 7;
	return 8;
}

/** 判断是否为调查员专属卡（签名卡）。标准格式 restrictions 是字符串 "investigator:xxxx"。 */
function isInvestigatorRestricted(restrictions?: string): boolean {
	return !!restrictions && restrictions.includes("investigator:");
}

/** 排序键生成器：按类别返回比较数组。 */
function sortKey(category: "permanent" | "asset" | "event" | "skill" | "side"): (c: OrganizedCard) => number[] {
	switch (category) {
		case "permanent":
			return (c) => [c.xp, c.cost];
		case "asset":
			return (c) => [c.slotWeight ?? 8, c.xp, c.cost];
		case "event":
			return (c) => [c.cost, c.xp];
		case "skill":
			return (c) => [c.xp];
		case "side":
			return (c) => [c.xp, c.cost];
	}
}

function sortCards(cards: OrganizedCard[], category: "permanent" | "asset" | "event" | "skill" | "side"): OrganizedCard[] {
	return [...cards].sort((a, b) => {
		const ka = sortKey(category)(a);
		const kb = sortKey(category)(b);
		for (let i = 0; i < ka.length; i++) {
			if (ka[i] !== kb[i]) return ka[i] - kb[i];
		}
		return a.code.localeCompare(b.code);
	});
}

export interface OrganizeOptions {
	/** 当前生效禁忌表涉及的卡 code 集合（命中则取图 code 加 -t）。不传则不处理 taboo。 */
	tabooCodes?: Set<string>;
}

/**
 * 分类排序一份卡组。
 * @param deck ArkhamDB deck JSON
 * @param meta  合并元数据 Map
 */
export function organizeDeck(deck: ArkhamDeck, meta: Map<string, CardMeta>, opts: OrganizeOptions = {}): OrganizedDeck {
	const tabooId = deck.taboo_id ?? null;
	const useTaboo = tabooId !== null && opts.tabooCodes !== undefined;

	const investigatorCode = deck.investigator_code;
	const invMeta = meta.get(investigatorCode);
	const faction = invMeta?.faction_code ?? "neutral";
	const borderColor = factionColor(faction);

	const result: OrganizedDeck = {
		investigator: {
			code: investigatorCode,
			name: invMeta?.name ?? deck.investigator_name ?? investigatorCode,
			faction,
			cards: [],
		},
		borderColor,
		tabooId,
		permanentAsset: [],
		asset: [],
		event: [],
		skill: [],
		sideCards: [],
		totalCards: 0,
		warnings: [],
	};

	/** 把一条 slot 分类进对应数组。 */
	function classify(code: string, count: number, intoSide: boolean): void {
		const m = meta.get(code);
		if (!m) {
			if (!result.warnings.includes(code)) result.warnings.push(code);
			return;
		}
		// taboo -t 后缀（仅当命中当前禁忌表）
		const imageCode = useTaboo && opts.tabooCodes!.has(code) ? `${code}-t` : code;
		const card: OrganizedCard = {
			code: imageCode,
			baseCode: code,
			name: m.name,
			count,
			xp: m.xp,
			cost: m.cost,
			slot: m.slot,
			slotWeight: m.type_code === "asset" ? assetSlotWeight(m.slot) : undefined,
		};

		if (intoSide) {
			result.sideCards.push(card);
			return;
		}
		// 调查员专属
		if (isInvestigatorRestricted(m.restrictions)) {
			result.investigator.cards.push(card);
			return;
		}
		const t = m.type_code;
		if (t === "asset") {
			if (m.permanent) result.permanentAsset.push(card);
			else result.asset.push(card);
		} else if (t === "event") {
			result.event.push(card);
		} else if (t === "skill") {
			result.skill.push(card);
		}
		// 其它 type（location/enemy/treachery/story/...）跳过——旧版同款行为
	}

	// 主卡组
	for (const [code, count] of Object.entries(deck.slots ?? {})) {
		if (code === investigatorCode) continue; // 调查员卡本身不计入
		classify(code, count, false);
		result.totalCards += count;
	}
	// 副卡（升级备卡）
	for (const [code, count] of Object.entries(deck.sideSlots ?? {})) {
		classify(code, count, true);
	}

	// 排序
	result.permanentAsset = sortCards(result.permanentAsset, "permanent");
	result.asset = sortCards(result.asset, "asset");
	result.event = sortCards(result.event, "event");
	result.skill = sortCards(result.skill, "skill");
	result.sideCards = sortCards(result.sideCards, "side");

	return result;
}

/** 把 OrganizedCard 列表按 count 展开成重复的 code 序列（auto-layout 用来铺卡牌槽位）。 */
export function expandCards(cards: ReadonlyArray<OrganizedCard>): { code: string; label: string }[] {
	const out: { code: string; label: string }[] = [];
	for (const c of cards) {
		for (let i = 0; i < c.count; i++) out.push({ code: c.code, label: c.name });
	}
	return out;
}

/** 各块张数统计（展开后）。 */
export function expandedCounts(d: OrganizedDeck): Record<string, number> {
	return {
		永久支援卡: d.permanentAsset.reduce((s, c) => s + c.count, 0),
		支援卡: d.asset.reduce((s, c) => s + c.count, 0),
		事件卡: d.event.reduce((s, c) => s + c.count, 0),
		技能卡: d.skill.reduce((s, c) => s + c.count, 0),
		升级备卡: d.sideCards.reduce((s, c) => s + c.count, 0),
		专属卡: d.investigator.cards.reduce((s, c) => s + c.count, 0),
	};
}
