import { type Static, Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	registerFonts,
	loadCardMetadata,
	fetchDeck,
	fetchArkhamBuildDeck,
	parseArkhamBuildShareId,
	organizeDeck,
	expandedCounts,
	buildDefaultPlan,
	planDeck,
	describePositions,
	renderDeck,
	createImageCache,
	createCardImageResolver,
	validateDeckPlan,
	formatValidation,
} from "@arkham/deck-renderer";
import type { ArkhamDeck } from "@arkham/deck-renderer";
import type { DeckPlan } from "@arkham/deck-renderer";

/**
 * 卡组分享工具（import_deck + render_deck），渲染引擎是 @arkham/deck-renderer。
 *
 * 分工（引擎的设计契约）：
 * - agent 管「逻辑排版」：把卡分进槽位、命名槽位、排槽内顺序、增减槽位（DeckPlan，零坐标）
 * - 程序管「几何排版」：紧凑左对齐/顶部对齐铺排，槽位纵向堆叠；画布宽固定（手机端）
 * - render_deck 回传每张卡的位置文字，agent 靠它感知布局
 *
 * 数据源：ArkhamDB 数字 id 和 arkham.build 分享链接/ID（两者格式同构）。
 * 工具在宿主机进程执行（读本地卡图/字体/元数据，元数据进程级缓存），
 * 产物写 workspace/decks/，agent 用 send_image 发送。
 */

// ---- 进程级共享状态（所有会话复用：元数据 / 卡图解码缓存 / 字体注册） ----
let metadataPromise: Promise<Map<string, import("@arkham/deck-renderer").CardMeta>> | null = null;
let imageCache: ReturnType<typeof createImageCache> | null = null;

function sharedImageCache() {
	if (!imageCache) imageCache = createImageCache(80);
	return imageCache;
}

export interface DeckToolContext {
	/** 社区数据库 arkhamdb-json-data 根目录（标准字段：type_code/permanent/slot/restrictions）。 */
	arkhamdbDataDir: string;
	/** card-database 根目录（中文名 + card_images/ 卡图）。 */
	cardDatabaseDir: string;
	/** 中文字体目录（思源黑体/汉仪小隶书简）。 */
	fontsDir: string;
}

function getMetadata(ctx: DeckToolContext) {
	if (!metadataPromise) metadataPromise = loadCardMetadata(ctx.arkhamdbDataDir, ctx.cardDatabaseDir);
	return metadataPromise;
}

/** 拉取卡组：数字 → ArkhamDB；URL/混合大小写短串 → arkham.build 分享。 */
async function fetchAnyDeck(input: string): Promise<ArkhamDeck> {
	const s = input.trim();
	if (/^\d+$/.test(s)) return fetchDeck(s);
	const shareId = parseArkhamBuildShareId(s);
	if (shareId) return fetchArkhamBuildDeck(shareId);
	throw new Error(`无法识别的卡组标识：${input}（支持 ArkhamDB 数字 id 或 arkham.build 分享链接）`);
}

// ---------------------------------------------------------------------------
// import_deck：拉取 + 分类 + 生成默认槽位 plan（agent 可编辑）
// ---------------------------------------------------------------------------

const importDeckSchema = Type.Object({
	deck: Type.String({
		description:
			"卡组标识：ArkhamDB 数字 id（如 4689495）、arkham.build 分享链接（如 https://arkham.build/deck/view/EaXFKGBAR7i9hob）或其短 ID。",
	}),
});

export type ImportDeckInput = Static<typeof importDeckSchema>;

export interface ImportDeckDetails {
	planPath: string;
	plan: DeckPlan;
}

export function createImportDeckTool(opts: CreateDeckToolsOptions): AgentTool<typeof importDeckSchema, ImportDeckDetails | undefined> {
	return {
		name: "import_deck",
		label: "import_deck",
		description:
			"导入一份卡组（ArkhamDB id 或 arkham.build 分享链接），自动按类别（永久支援/支援/事件/技能/升级备卡）分槽生成默认排班计划 plan，保存到 decks/ 目录。返回卡组摘要 + plan 内容 + 缺图警告。之后可把 plan 改动（改槽位名/归组/顺序）后调 render_deck 渲染成分享图。",
		parameters: importDeckSchema,
		async execute(_toolCallId, params) {
			try {
				const deck = await fetchAnyDeck(params.deck);
				const meta = await getMetadata(opts.deck);
				const organized = organizeDeck(deck, meta);
				const plan = buildDefaultPlan(organized, { title: deck.name });
				// plan 落盘（agent 可 read/edit，render_deck 可按路径引用）
				const decksDir = join(opts.workspaceDir, "decks");
				await mkdir(decksDir, { recursive: true });
				const planName = `plan-${deck.id}.json`;
				const planPath = join(decksDir, planName);
				await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");

				const counts = expandedCounts(organized);
				const lines: string[] = [];
				lines.push(`✓ 已导入「${deck.name}」（调查员 ${deck.investigator_name ?? deck.investigator_code}，阵营 ${organized.investigator.faction}）`);
				lines.push(`plan 已保存：decks/${planName}`);
				lines.push("");
				lines.push("=== 分类摘要（展开张数）===");
				for (const [k, v] of Object.entries(counts)) if (v > 0) lines.push(`  ${k}: ${v}张`);
				if (organized.warnings.length > 0) lines.push(`  ⚠ 卡牌库未识别的卡：${organized.warnings.join(", ")}`);
				lines.push("");
				lines.push("=== plan（槽位结构，可编辑）===");
				for (const s of plan.slots) {
					lines.push(`  槽位「${s.name}」${s.cards.length}张: ${s.cards.map((c) => `${c.label ?? c.code}(${c.code})`).join(" ")}`);
				}
				// 缺图校验（agent 提前知道哪些卡没图、可改 ID）
				const report = await validateDeckPlan(plan, join(opts.deck.cardDatabaseDir, "card_images"));
				lines.push("");
				lines.push(formatValidation(report));
				return { content: [{ type: "text", text: lines.join("\n") }], details: { planPath, plan } };
			} catch (error) {
				return { content: [{ type: "text", text: `导入卡组失败：${(error as Error).message}` }], details: undefined };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// render_deck：plan → 渲染分享图（回传位置 + 缺图警告）
// ---------------------------------------------------------------------------

const renderDeckSchema = Type.Object({
	planJson: Type.Optional(Type.String({
		description:
			"完整的 plan JSON 字符串（import_deck 返回的 plan，可编辑槽位名/归组/顺序后传入）。与 planPath 二选一。",
	})),
	planPath: Type.Optional(Type.String({
		description: "plan 文件路径（workspace 内，如 decks/plan-4689495.json）。与 planJson 二选一。",
	})),
});

export type RenderDeckInput = Static<typeof renderDeckSchema>;

export interface RenderDeckDetails {
	imagePath: string;
}

export function createRenderDeckTool(opts: CreateDeckToolsOptions): AgentTool<typeof renderDeckSchema, RenderDeckDetails | undefined> {
	return {
		name: "render_deck",
		label: "render_deck",
		description:
			"把卡组排班计划 plan 渲染成分享图（紧凑左对齐网格、槽位纵向堆叠、阵营色块），保存为 decks/ 下的 jpg 并返回路径（用 send_image 发送）。同时返回每张卡的排列位置文字（槽位/行/列），便于检查和继续调整槽位。支持传 planJson（编辑后）或 planPath（import_deck 保存的文件）。",
		parameters: renderDeckSchema,
		async execute(_toolCallId, params) {
			try {
				// plan 来源：JSON 字符串或 workspace 内文件
				let planRaw: string;
				if (params.planJson) {
					planRaw = params.planJson;
				} else if (params.planPath) {
					const abs = resolve(opts.workspaceDir, params.planPath);
					if (!abs.startsWith(resolve(opts.workspaceDir))) {
						return { content: [{ type: "text", text: `错误：planPath 必须在工作目录内` }], details: undefined };
					}
					planRaw = await readFile(abs, "utf8");
				} else {
					return { content: [{ type: "text", text: "错误：planJson 和 planPath 至少传一个" }], details: undefined };
				}
				let plan: DeckPlan;
				try {
					plan = JSON.parse(planRaw) as DeckPlan;
				} catch {
					return { content: [{ type: "text", text: "错误：planJson 不是有效的 JSON" }], details: undefined };
				}
				if (!Array.isArray(plan.slots) || plan.slots.length === 0) {
					return { content: [{ type: "text", text: "错误：plan.slots 为空（至少要有一个槽位）" }], details: undefined };
				}

				// 缺图校验（渲染前，让 agent 知道哪些卡没图）
				const report = await validateDeckPlan(plan, join(opts.deck.cardDatabaseDir, "card_images"));

				// 渲染
				registerFonts(opts.deck.fontsDir);
				const result = planDeck(plan);
				const resolver = createCardImageResolver({ cardDatabaseDir: opts.deck.cardDatabaseDir });
				const buf = await renderDeck(result.layout, { resolver, imageCache: sharedImageCache(), format: "jpeg", quality: 0.9 });

				const decksDir = join(opts.workspaceDir, "decks");
				await mkdir(decksDir, { recursive: true });
				const imageName = `deck-${Date.now()}.jpg`;
				const imagePath = join(decksDir, imageName);
				await writeFile(imagePath, buf);

				const lines: string[] = [];
				lines.push(`✓ 已渲染 → decks/${imageName}（${result.width}×${result.height}px，${(buf.byteLength / 1024).toFixed(0)}KB）。用 send_image 发送 decks/${imageName}。`);
				lines.push("");
				lines.push("=== 卡牌位置（槽位/行/列，供感知布局）===");
				lines.push(describePositions(result));
				lines.push("");
				lines.push(formatValidation(report));
				return { content: [{ type: "text", text: lines.join("\n") }], details: { imagePath } };
			} catch (error) {
				return { content: [{ type: "text", text: `渲染卡组失败：${(error as Error).message}` }], details: undefined };
			}
		},
	};
}

export interface CreateDeckToolsOptions {
	/** 沙箱工作目录绝对路径（产物写 <workspaceDir>/decks/）。 */
	readonly workspaceDir: string;
	/** 引擎数据源/字体路径。 */
	readonly deck: DeckToolContext;
}

/** 一次装配两个卡组工具。 */
export function createDeckTools(opts: CreateDeckToolsOptions): AgentTool[] {
	return [createImportDeckTool(opts), createRenderDeckTool(opts)];
}
