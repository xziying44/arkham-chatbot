import { type Static, Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * generate_image 工具：MiniMax 文生图（诡镇奇谭卡牌插画专用提示词模板）。
 *
 * 模板与调参规则来自《诡镇奇谭卡牌插画 · MiniMax 生图方案 v1.0》
 * （卡牌勘误工程/生图方案.md，已经 6 轮实机校验）：
 * - 四类模板（人物/场景/怪物/物品）：通用前缀 + 类型追加 + 统一尾约束；
 * - 人物类必须关 prompt_optimizer（否则跑偏动漫脸）；其余开启；
 * - 不用 -s 画风参数（四种画风都不匹配卡牌插画风格），风格全靠提示词；
 * - 比例仅 1:1/16:9/9:16/4:3/3:4（image-01-live 不支持 21:9/3:2/2:3）。
 *
 * 安全性：本工具在**宿主机进程**内执行（同 search_cards），API key 由 server
 * 以构造参数注入，只在进程内存中——不写沙箱文件、不进沙箱环境变量、
 * 不出现在工具参数/返回值里。沙箱内 agent 只能看到生成结果图片。
 */

// ---- 提示词模板（生图方案 §3） ----

/** 通用前缀（所有类型共享）。注意：不要写「克苏鲁/洛夫克拉夫特」——模型一看到就无脑画章鱼触手怪。
 * 诡镇奇谭的油画风格 + 神秘氛围足够定调，怪物形态交给用户描述主导。 */
const COMMON_PREFIX =
	"欧美写实油画，诡镇奇谭卡牌插画风格，厚涂油画笔触，低饱和暗沉色调，" +
	"戏剧性明暗对比，神秘阴郁的悬疑氛围，非动漫非卡通非二次元";

/** 统一尾约束（拼接在用户描述之后）。含反章鱼刻板印象的负面约束。
 * 注意：不要写「触手」「眼球触须」等词——文生图审核高敏，会整张图判失败。用「章鱼/乌贼形态」足够表达。 */
const TAIL_CONSTRAINT = "，画面中不出现任何文字、字母、水印、边框；严格按描述的主体作画，主体不是海洋生物时不要画成章鱼或乌贼的形态（除非描述明确要求）";

type CardArtType = "character" | "scene" | "monster" | "item";

interface TypeTemplate {
	/** 默认画幅比例（可被参数覆盖）。 */
	readonly ratio: string;
	/** prompt_optimizer 开关：人物必须关，其余开。 */
	readonly optimize: boolean;
	/** 在通用前缀上追加的类型词。 */
	readonly extra: string;
}

const TYPE_TEMPLATES: Record<CardArtType, TypeTemplate> = {
	// 人物：调查员/NPC/剧情角色。伦勃朗光 + 油画布纹理压动漫脸。
	character: {
		ratio: "3:4",
		optimize: false,
		extra: "1920年代美国复古设定，粗糙油画布纹理，写实面部，皮肤纹理细节，伦勃朗式明暗用光",
	},
	// 场景：地点/事件/遭遇。
	scene: {
		ratio: "4:3",
		optimize: true,
		extra: "1920年代美国复古设定，雾气与氛围纵深，电影感构图",
	},
	// 怪物：敌人/异象。去掉 1920s 时代词，强调写实生物质感，严格按描述形态（别默认章鱼触手）。
	monster: {
		ratio: "1:1",
		optimize: true,
		extra: "写实生物质感，严格按描述的怪物形态作画",
	},
	// 物品：支援/道具静物。
	item: {
		ratio: "1:1",
		optimize: true,
		extra: "1920年代美国复古设定，静物特写，深色背景，顶部聚光",
	},
};

const ALLOWED_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4"]);

/**
 * 组装完整提示词（纯函数，便于单测）：
 * 通用前缀 + 类型追加 + "：" + 用户描述 + 尾约束。
 */
export function buildArtPrompt(type: CardArtType, description: string): string {
	const tpl = TYPE_TEMPLATES[type];
	return `${COMMON_PREFIX}，${tpl.extra}：${description.trim()}${TAIL_CONSTRAINT}`;
}

/** 类型的默认比例 / optimizer 开关（纯函数，便于单测）。 */
export function typeDefaults(type: CardArtType): { ratio: string; optimize: boolean } {
	const tpl = TYPE_TEMPLATES[type];
	return { ratio: tpl.ratio, optimize: tpl.optimize };
}

// ---- 工具定义 ----

const generateImageSchema = Type.Object({
	description: Type.String({
		description:
			"画面描述（中文一句话）。公式：[主体+外观/服装]+[动作/状态]+[环境]+[光源]+[情绪]。" +
			"必须指定唯一光源（提灯/月光/窗口）；人物年龄状态写明确（中年/疲惫/沧桑），不要写「年轻美丽」；" +
			"只写画面主体，风格词不用写（模板已带）。",
	}),
	type: Type.Union(
		[
			Type.Literal("character"),
			Type.Literal("scene"),
			Type.Literal("monster"),
			Type.Literal("item"),
		],
		{
			description:
				"画面类型：character=人物（调查员/NPC）；scene=场景（地点/事件）；monster=怪物（敌人/异象）；item=物品（支援/道具静物）。",
		},
	),
	ratio: Type.Optional(
		Type.String({
			description: "画幅比例覆盖：1:1/16:9/9:16/4:3/3:4。不传则按类型用默认值（人物3:4 场景4:3 怪物/物品1:1）。",
		}),
	),
	n: Type.Optional(
		Type.Number({
			description: "生成张数 1-4，默认 1。用户对插画不满意时可以设 2 生成备选。",
			minimum: 1,
			maximum: 4,
		}),
	),
});

export type GenerateImageInput = Static<typeof generateImageSchema>;

export interface CreateGenerateImageToolOptions {
	/** MiniMax API key（仅存在于宿主机进程内存，绝不写入沙箱）。 */
	readonly apiKey: string;
	/** MiniMax API base，默认 https://api.minimaxi.com。 */
	readonly apiBase?: string;
	/**
	 * 当前 scope 沙箱工作目录的**宿主机绝对路径**。
	 * 生成图下载到 `<workspaceDir>/generated/`，沙箱内可见为 `generated/`，
	 * agent 拿到返回的相对路径后直接传给 send_image 发送。
	 */
	readonly workspaceDir: string;
	/** 单张生成请求超时（毫秒），默认 180s。 */
	readonly timeoutMs?: number;
}

interface MinimaxImageResponse {
	data?: { image_urls?: string[] };
	metadata?: { failed_count?: string; success_count?: string };
	base_resp?: { status_code?: number; status_msg?: string };
}

/**
 * 创建 generate_image 工具。
 * 调用 MiniMax image_generation（image-01-live），下载结果到 workspace/generated/。
 */
export function createGenerateImageTool(
	opts: CreateGenerateImageToolOptions,
): AgentTool<typeof generateImageSchema, undefined> {
	const apiBase = (opts.apiBase ?? "https://api.minimaxi.com").replace(/\/+$/, "");
	const timeoutMs = opts.timeoutMs ?? 180_000;

	return {
		name: "generate_image",
		label: "generate_image",
		description:
			"生成诡镇奇谭风格的卡牌插画（MiniMax 文生图，欧美写实油画/克苏鲁氛围）。" +
			"用户想「画一张…/配个插画/来张图」时调用：先按公式把用户需求改写成画面描述，选好类型。" +
			"生成后的处理按当前任务上下文走：用户直接求画 → 用 send_image 把图发给用户；" +
			"制卡场景 → 按 diy-card 技能指引用作卡图插画（不直接发原图）。" +
			"用户对结果不满意要重画时，按反馈调整画面描述后再调（如太亮→追加「夜色，唯一光源是××」）。",
		parameters: generateImageSchema,
		async execute(_toolCallId, params, signal, _onUpdate) {
			const type = params.type as CardArtType;
			const tpl = TYPE_TEMPLATES[type];
			const ratio = params.ratio ?? tpl.ratio;
			if (!ALLOWED_RATIOS.has(ratio)) {
				return {
					content: [{ type: "text", text: `错误：比例 ${ratio} 不支持，可选 1:1/16:9/9:16/4:3/3:4` }],
					details: undefined,
				};
			}
			const n = Math.min(Math.max(Math.floor(params.n ?? 1), 1), 4);
			const prompt = buildArtPrompt(type, params.description);

			let response: MinimaxImageResponse;
			try {
				response = await requestImageGeneration(apiBase, opts.apiKey, {
					prompt,
					ratio,
					n,
					optimize: tpl.optimize,
					timeoutMs,
					signal,
				});
			} catch (error) {
				return {
					content: [{ type: "text", text: `生图请求失败：${(error as Error).message}` }],
					details: undefined,
				};
			}
			const baseResp = response.base_resp ?? {};
			if (baseResp.status_code !== 0) {
				return {
					content: [{ type: "text", text: `生图失败：${baseResp.status_msg ?? "未知错误"}（code ${baseResp.status_code}）` }],
					details: undefined,
				};
			}
			const urls = response.data?.image_urls ?? [];
			if (urls.length === 0) {
				return {
					content: [{ type: "text", text: "生图失败：API 返回成功但没有图片 URL，请重试。" }],
					details: undefined,
				};
			}

			// 下载到 workspace/generated/（沙箱内可见为 generated/）。
			const outDir = join(opts.workspaceDir, "generated");
			await mkdir(outDir, { recursive: true });
			// 时间戳到毫秒 + 序号，同一秒多次调用不互相覆盖。
			const now = new Date();
			const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14) + String(now.getMilliseconds()).padStart(3, "0");
			const saved: string[] = [];
			for (let i = 0; i < urls.length; i++) {
				try {
					const buf = await download(urls[i], timeoutMs, signal);
					const filename = `art-${stamp}-${i + 1}.jpg`;
					await writeFile(join(outDir, filename), buf);
					saved.push(`generated/${filename}`);
				} catch (error) {
					console.warn(`[generate_image] 下载第 ${i + 1} 张失败: ${(error as Error).message}`);
				}
			}
			if (saved.length === 0) {
				return {
					content: [{ type: "text", text: "图片已生成但下载失败（临时 URL 拉取异常），请重试。" }],
					details: undefined,
				};
			}
			const text =
				`已生成 ${saved.length} 张图（类型 ${type}，比例 ${ratio}）：\n` +
				saved.map((p) => `- ${p}`).join("\n") +
				"\n请用 send_image 把这些图片发给用户（可多张一起发，让用户挑喜欢的）。";
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}

/** 调 MiniMax image_generation 接口。 */
async function requestImageGeneration(
	apiBase: string,
	apiKey: string,
	req: { prompt: string; ratio: string; n: number; optimize: boolean; timeoutMs: number; signal?: AbortSignal },
): Promise<MinimaxImageResponse> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`请求超时（${req.timeoutMs / 1000}s）`)), req.timeoutMs);
	// 外部 abort（agent 中断）联动。
	req.signal?.addEventListener("abort", () => controller.abort(req.signal?.reason), { once: true });
	try {
		const resp = await fetch(`${apiBase}/v1/image_generation`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "image-01-live",
				prompt: req.prompt,
				aspect_ratio: req.ratio,
				response_format: "url",
				n: req.n,
				prompt_optimizer: req.optimize,
			}),
			signal: controller.signal,
		});
		if (!resp.ok) {
			const body = await resp.text().catch(() => "");
			throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
		}
		return (await resp.json()) as MinimaxImageResponse;
	} finally {
		clearTimeout(timer);
	}
}

/** 单张图下载上限（防御性：异常响应不撑爆内存）。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 下载临时 URL 的图片内容。 */
async function download(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("下载超时")), timeoutMs);
	signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
	try {
		const resp = await fetch(url, { signal: controller.signal });
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const contentType = resp.headers.get("content-type") ?? "";
		if (!contentType.startsWith("image/")) throw new Error(`响应不是图片（Content-Type: ${contentType || "未知"}）`);
		const declared = Number(resp.headers.get("content-length") ?? 0);
		if (declared > MAX_IMAGE_BYTES) throw new Error(`图片过大（${Math.round(declared / 1024 / 1024)}MB）`);
		const buf = Buffer.from(await resp.arrayBuffer());
		if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片过大（${Math.round(buf.length / 1024 / 1024)}MB）`);
		return buf;
	} finally {
		clearTimeout(timer);
	}
}
