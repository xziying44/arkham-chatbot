/**
 * 默认排班：把分好类的 OrganizedDeck 映射成默认 DeckPlan（5 个分类槽位），
 * 再交由 planDeck 编译成带坐标的布局。
 *
 * autoLayout 返回 DeckLayout（向后兼容旧调用方）；autoPlan 返回完整结果（含每卡位置）。
 * 智能体可直接用 buildDefaultPlan 生成默认 plan，再自由改槽位名/归组/顺序。
 */
import type { CardRef, DeckLayout } from "../types.ts";
import { DEFAULT_PROMO, DEFAULT_WIDTH } from "../theme.ts";
import type { OrganizedCard, OrganizedDeck } from "./organize.ts";
import { expandCards } from "./organize.ts";
import { planDeck } from "../plan.ts";
import type { DeckPlan, PlanResult, PlanSlot } from "../plan.ts";

export interface AutoLayoutOptions {
	/** 卡组名（覆盖 deck.name）。 */
	title?: string;
	/** 右上宣传语行；传 [] 关闭。 */
	promo?: string[];
	/** 自定义画布宽。 */
	width?: number;
}

/** OrganizedCard[] → CardRef[]（按 count 展开成重复卡牌）。 */
function toCardRefs(cards: ReadonlyArray<OrganizedCard>): CardRef[] {
	return expandCards(cards).map((c) => ({ code: c.code, label: c.label }));
}

/**
 * 把分好类的卡组映射成默认 DeckPlan（永久支援/支援/事件/技能/升级备卡 5 个槽位，
 * 空类别自动省略）。
 */
export function buildDefaultPlan(deck: OrganizedDeck, opts: AutoLayoutOptions = {}): DeckPlan {
	const signature = expandCards(deck.investigator.cards).map((c) => c.code);
	const slots: PlanSlot[] = [
		{ name: "永久支援卡", cards: toCardRefs(deck.permanentAsset) },
		{ name: "支援卡", cards: toCardRefs(deck.asset) },
		{ name: "事件卡", cards: toCardRefs(deck.event) },
		{ name: "技能卡", cards: toCardRefs(deck.skill) },
		{ name: "升级备卡", cards: toCardRefs(deck.sideCards) },
	].filter((s) => s.cards.length > 0);

	return {
		width: opts.width,
		title: opts.title,
		investigator: deck.investigator.code,
		signature,
		faction: deck.investigator.faction,
		promo: opts.promo === undefined ? DEFAULT_PROMO : opts.promo,
		slots,
	};
}

/** 默认排班 → 带坐标 DeckLayout（向后兼容）。 */
export function autoLayout(deck: OrganizedDeck, opts: AutoLayoutOptions = {}): DeckLayout {
	return planDeck(buildDefaultPlan(deck, opts)).layout;
}

/** 默认排班 → 完整结果（含每卡位置 + 槽位摘要）。 */
export function autoPlan(deck: OrganizedDeck, opts: AutoLayoutOptions = {}): PlanResult {
	return planDeck(buildDefaultPlan(deck, opts));
}

/** 向后兼容：旧版布局参数（信息性；新代码用 plan.DEFAULT_PLAN）。 */
export const DEFAULT_LAYOUT_PARAMS = {
	width: DEFAULT_WIDTH,
	marginX: 50,
	cardSize: [368, 532] as const,
	gap: 8,
	cols: 7,
	titleHeight: 70,
	investigatorSize: [490, 350] as const,
	headerTop: 110,
	titleY: 35,
	sectionGap: 30,
};
