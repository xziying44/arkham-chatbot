import { type Static, Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	loadCardIndex,
	searchCards,
	type IndexedCard,
	type SearchResult,
} from "./search-cards-index.ts";

/**
 * search_cards 工具：检索卡牌数据库，按多维度筛选，返回最接近的 ≤5 张卡。
 *
 * 数据来自 arkham-card-database（3556 张卡），索引在 BotManager 启动时加载一次，
 * 所有 scope 共享。工具只读索引、不落盘、不发图——返回文字结果 + 图片路径，
 * 由 agent 据此多轮/并行查询，最终用 send_image 发想要的卡图。
 *
 * 返回数量 ≤5，不硬凑：过滤后不足 5 张就返回实际数量。
 * 多张候选时 agent 应先发文字列表让用户选，确定后再 send_image 发指定那张，
 * 避免一次发多张图刷屏。
 */

const searchCardsSchema = Type.Object({
	query: Type.Optional(Type.String({
		description: "卡牌名字模糊搜索（最常用）。比如 \"罗兰\"、\"38手枪\"。支持包含/部分匹配/错别字容忍。",
	})),
	type: Type.Optional(Type.String({
		description: "卡牌类型精确匹配。可选值：调查员/支援卡/事件卡/技能卡/敌人卡/地点卡/诡计卡/密谋卡/场景卡/故事卡/密钥卡。",
	})),
	class: Type.Optional(Type.String({
		description: "职业或阵营精确匹配。可选值：守护者/探求者/流浪者/潜修者/生存者/中立/遭遇/弱点/多职阶。",
	})),
	category: Type.Optional(Type.String({
		description: "卡牌大类。可选值：玩家卡/剧本卡/重返卡。",
	})),
	trait: Type.Optional(Type.String({
		description: "单个特性，包含匹配。如：道具/法术/盟友/武器/ ritual(仪式)/天赋 等（共 258 种）。",
	})),
	traits_all: Type.Optional(Type.Array(Type.String(), {
		description: "多个特性 AND（卡牌需同时含有全部）。如 [\"道具\",\"武器\"]。",
	})),
	traits_any: Type.Optional(Type.Array(Type.String(), {
		description: "多个特性 OR（含任一即可）。",
	})),
	cost_min: Type.Optional(Type.Number({ description: "费用下限（含）。注意 -1 表示无费用。" })),
	cost_max: Type.Optional(Type.Number({ description: "费用上限（含）。" })),
	level_min: Type.Optional(Type.Number({ description: "等级下限（含）。" })),
	level_max: Type.Optional(Type.Number({ description: "等级上限（含）。" })),
	level_exact: Type.Optional(Type.Number({
		description: "精确等级（0-5）。-1 表示「无等级」（基础弱点等）。设了它就忽略 level_min/max。",
	})),
	health_min: Type.Optional(Type.Number({ description: "生命下限（含）。敌人卡用 enemy_health，其它卡用 health。" })),
	horror_min: Type.Optional(Type.Number({ description: "理智下限（含）。" })),
	attack_min: Type.Optional(Type.Number({ description: "敌人攻击力下限（含）。" })),
	evade_min: Type.Optional(Type.Number({ description: "敌人闪避值下限（含）。" })),
	victory_min: Type.Optional(Type.Number({ description: "胜利点下限（含）。" })),
	investigator_only: Type.Optional(Type.Boolean({
		description: "true → 只查调查员（等价 type=调查员）。",
	})),
	weakness_only: Type.Optional(Type.Boolean({
		description: "true → 只查弱点卡（class=弱点）。",
	})),
	limit: Type.Optional(Type.Number({
		description: "返回数量上限，默认 5，最大 5。",
	})),
});

export type SearchCardsInput = Static<typeof searchCardsSchema>;

export interface CreateSearchCardsToolOptions {
	/**
	 * 卡牌数据库根目录（宿主机绝对路径，含 json/ + card_images/）。
	 * 工具首次执行时从这里懒加载索引并进程级缓存。
	 */
	readonly databaseDir: string;
	/**
	 * 沙箱内图片路径前缀。图片路径会拼成 `<prefix>/card_images/01001_a.jpg`，
	 * agent 拿到后直接传给 send_image。默认 "cards-db"（与 readOnlyBinds 挂载点一致）。
	 */
	readonly sandboxImagePrefix?: string;
}

/**
 * 创建 search_cards 工具。
 * 索引懒加载：第一次 execute 时才读 JSON（~100ms），之后纯内存匹配（<5ms）。
 */
export function createSearchCardsTool(opts: CreateSearchCardsToolOptions): AgentTool<typeof searchCardsSchema, undefined> {
	const prefix = opts.sandboxImagePrefix ?? "cards-db";
	let indexPromise: Promise<IndexedCard[]> | undefined;

	const getIndex = (): Promise<IndexedCard[]> => {
		if (!indexPromise) {
			indexPromise = loadCardIndex(opts.databaseDir, prefix);
		}
		return indexPromise;
	};

	return {
		name: "search_cards",
		label: "search_cards",
		description:
			"检索官方卡牌数据库（3556 张阿卡姆恐怖 LCG 卡牌），按类型/职业/特性/费用/等级等多维度筛选，返回最接近的最多 5 张卡。" +
			"返回每张卡的 id、名字、关键字段和图片路径（cards-db/card_images/xxx_a.jpg）。" +
			"用法：①用户问「有没有/帮我找/查一下某卡」时用这个工具；②多维度组合用 AND 语义一次查清；" +
			"③结果只有 1 张可直接 send_image 发它的图片路径；多张候选时先用 send_message 发文字列表让用户选，确定后再发图，避免刷屏。" +
			"注意：不硬凑——筛选后不足 5 张就返回实际数量；条件太严查空时会自动按名字模糊回退。",
		parameters: searchCardsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate) {
			try {
				const index = await getIndex();
				const results = searchCards(index, params);
				const text = formatResults(results, params, index.length);
				return { content: [{ type: "text", text }], details: undefined };
			} catch (error) {
				const msg = (error as Error).message;
				return {
					content: [{ type: "text", text: `卡牌查询失败：${msg}` }],
					details: undefined,
				};
			}
		},
	};
}

/** 格式化搜索结果为 agent 可读的文字。 */
function formatResults(results: SearchResult[], params: SearchCardsInput, total: number): string {
	if (results.length === 0) {
		const hasQuery = !!params.query?.trim();
		const hints: string[] = [];
		if (hasQuery) hints.push(`没有名字含「${params.query}」的卡。`);
		hints.push("可尝试：放宽条件、换关键词、用 ask_user 问用户更具体的特征。");
		return `未找到匹配的卡牌（数据库共 ${total} 张）。\n${hints.join("\n")}`;
	}

	const lines: string[] = [];
	lines.push(`找到 ${results.length} 张卡（数据库共 ${total} 张，最多显示 5 张）：`);
	lines.push("");
	for (const r of results) {
		const c = r.card;
		lines.push(formatCard(c, r.score));
		lines.push("");
	}

	lines.push("—— 发图提示 ——");
	if (results.length === 1) {
		lines.push("只有 1 张匹配，可以直接 send_image 发它的正面图片路径。");
	} else {
		lines.push("有多张候选：先用 send_message 把上面的列表发给用户让其选择，确定后 send_image 发指定那张的图片路径（避免一次发多图刷屏）。");
	}
	lines.push("要看背面把图片路径里的 _a 换成 _b（如 cards-db/card_images/01006_b.jpg）。");
	return lines.join("\n");
}

/** 格式化单张卡。 */
function formatCard(c: IndexedCard, score: number): string {
	const lines: string[] = [];
	lines.push(`【${c.arkhamdb_id}】${c.name_zh}`);

	const meta: string[] = [];
	if (c.type) meta.push(`类型:${c.type}`);
	if (c.class) meta.push(`职业:${c.class}`);
	if (c.subclass) meta.push(`副职:${c.subclass}`);
	if (c.level !== undefined && c.level >= 0) meta.push(`等级:${c.level}`);
	if (c.cost !== undefined && c.cost >= 0) meta.push(`费用:${c.cost}`);
	if (c.health !== undefined && c.health > 0) meta.push(`生命:${c.health}`);
	if (c.horror !== undefined && c.horror > 0) meta.push(`理智:${c.horror}`);
	if (c.attack) meta.push(`攻击:${c.attack}`);
	if (c.evade) meta.push(`闪避:${c.evade}`);
	if (c.shroud) meta.push(`迷雾:${c.shroud}`);
	if (c.clues) meta.push(`线索:${c.clues}`);
	if (c.victory) meta.push(`胜利点:${c.victory}`);
	if (c.weakness_type) meta.push(c.weakness_type);
	if (meta.length > 0) lines.push(`  ${meta.join(" | ")}`);

	if (c.traits.length > 0) lines.push(`  特性: ${c.traits.join("·")}`);
	if (c.submit_icon.length > 0) lines.push(`  图标: ${c.submit_icon.join("·")}`);

	// 图片路径（a 面为主；有 b/a-c 面也列出来）。
	const imgs = c.faces.map((f) => f.imageFile);
	lines.push(`  图片: ${imgs[0]}`);
	if (imgs.length > 1) {
		lines.push(`  其它面: ${imgs.slice(1).join(" / ")}`);
	}

	if (score > 0) lines.push(`  (匹配度 ${score})`);
	return lines.join("\n");
}
