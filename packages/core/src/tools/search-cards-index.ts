/**
 * 卡牌数据库索引 + 搜索匹配（纯函数，可单测）。
 *
 * 数据源：arkham-card-database 的 `json/全部卡牌.json`（~9MB，3556 张卡）。
 * 进程级懒加载 + 缓存：BotManager 启动时加载一次，所有 scope 共享同一份索引，
 * 避免每个会话重复读 9MB 文件。
 *
 * 索引只抽取搜索/展示所需的关键字段（从 a 面为主），不保留完整 body，
 * 既省内存又让匹配逻辑简单稳定。完整正文 agent 不需要——查询返回关键字段 + 图片路径即可。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** 一张卡在内存里的索引条目。 */
export interface IndexedCard {
	readonly arkhamdb_id: string;
	readonly name_zh: string;
	/** 玩家卡/剧本卡/重返卡。 */
	readonly category: string;
	/** 所属周期，如 01_基础游戏。 */
	readonly cycle: string;
	/** 卡牌类型（取自 a 面 content.type），如 支援卡/事件卡/调查员。 */
	readonly type?: string;
	/** 职业/阵营（a 面 content.class），如 守护者/中立/遭遇。 */
	readonly class?: string;
	/** 子职阶（调查员卡背的副职业）。 */
	readonly subclass?: string;
	/** 特性列表（a 面 content.traits）。 */
	readonly traits: readonly string[];
	/** 费用（-1 表示无费用，如技能卡/弱点）。 */
	readonly cost?: number;
	/** 等级（-1 表示无等级，如基础弱点）。 */
	readonly level?: number;
	readonly health?: number;
	readonly horror?: number;
	/** 敌人攻击力（字符串，可能是 "4" 或 "X"）。 */
	readonly attack?: string;
	/** 敌人闪避值（字符串）。 */
	readonly evade?: string;
	readonly enemy_damage?: number;
	readonly shroud?: string;
	readonly clues?: string;
	readonly victory?: number;
	/** 技能图标（a 面 content.submit_icon）。 */
	readonly submit_icon: readonly string[];
	readonly weakness_type?: string;
	/**
	 * 各面的图片信息。face 为 "a"/"b"/"a-c"，imageFile 为沙箱内相对路径
	 * （如 cards-db/card_images/01006_a.jpg）。
	 */
	readonly faces: ReadonlyArray<{ face: string; imageFile: string; type?: string }>;
}

/** 搜索参数（全部可选，AND 语义）。 */
export interface SearchParams {
	/** 名字模糊匹配（包含/词元重叠/编辑距离综合）。最常用。 */
	query?: string;
	/** 卡牌类型精确匹配（支援卡/事件卡/技能卡/敌人卡/...）。 */
	type?: string;
	/** 职业/阵营精确匹配（守护者/探求者/.../中立/遭遇/弱点）。 */
	class?: string;
	/** 玩家卡/剧本卡/重返卡。 */
	category?: string;
	/** 单个特性包含匹配。 */
	trait?: string;
	/** 多特性 AND（卡牌需同时含全部）。 */
	traits_all?: readonly string[];
	/** 多特性 OR（含任一）。 */
	traits_any?: readonly string[];
	cost_min?: number;
	cost_max?: number;
	level_min?: number;
	level_max?: number;
	/** 精确等级（0-5；-1 表示「无等级」的卡）。 */
	level_exact?: number;
	health_min?: number;
	horror_min?: number;
	attack_min?: number;
	/** 敌人闪避值下限。 */
	evade_min?: number;
	victory_min?: number;
	/** true → 仅调查员。 */
	investigator_only?: boolean;
	/** true → 仅弱点卡（class=弱点）。 */
	weakness_only?: boolean;
	/** 返回数量上限，默认 5，最大 5。 */
	limit?: number;
}

/** 单条搜索结果（匹配到的索引条目 + 命中信息）。 */
export interface SearchResult {
	readonly card: IndexedCard;
	/** 与 query 的相关度分数，越高越相关（无 query 时为 0）。 */
	readonly score: number;
}

/** 原始 JSON 卡牌的 faces content（宽松类型，只取需要的字段）。 */
interface FaceContent {
	name?: string;
	type?: string;
	class?: string;
	subclass?: string;
	traits?: string[];
	cost?: number;
	level?: number;
	health?: number;
	/** 敌人生命（敌人卡用 enemy_health，普通支援/调查员用 health）。 */
	enemy_health?: string | number;
	horror?: string | number;
	attack?: string;
	evade?: string;
	enemy_damage?: number;
	enemy_damage_horror?: number;
	shroud?: string;
	clues?: string;
	victory?: number;
	submit_icon?: string[];
	weakness_type?: string;
}

interface RawFace {
	image_file?: string;
	content?: FaceContent;
}

interface RawCard {
	arkhamdb_id: string;
	name_zh: string;
	category: string;
	cycle: string;
	faces?: Record<string, RawFace>;
}

interface AllCardsJson {
	cards: RawCard[];
}

/** 数值字段宽松解析：字符串数字 → number，非法 → undefined。 */
function toNum(v: unknown): number | undefined {
	if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
	if (typeof v === "string") {
		const s = v.trim();
		if (s === "" || s === "X" || s === "x" || s === "-") return undefined;
		// 形如 "0<调查员>" 的混排，取前导数字
		const m = s.match(/^-?\d+/);
		if (m) {
			const n = Number(m[0]);
			return Number.isFinite(n) ? n : undefined;
		}
	}
	return undefined;
}

/**
 * 从原始卡牌抽取索引条目。
 * 主要展示面取 a 面；若 b 面有独立 type（如调查员卡背），也并入 faces 列表供图片定位。
 */
function toIndexed(raw: RawCard, sandboxImagePrefix: string): IndexedCard | null {
	const faces = raw.faces ?? {};
	const a = faces.a?.content ?? {};
	const faceList: IndexedCard["faces"][number][] = [];
	for (const [faceKey, face] of Object.entries(faces)) {
		const img = face?.image_file;
		if (!img) continue;
		faceList.push({
			face: faceKey,
			imageFile: `${sandboxImagePrefix}/${img}`,
			type: face?.content?.type,
		});
	}
	if (faceList.length === 0) return null;
	return {
		arkhamdb_id: raw.arkhamdb_id,
		name_zh: raw.name_zh,
		category: raw.category,
		cycle: raw.cycle,
		type: a.type,
		class: a.class,
		subclass: a.subclass,
		traits: a.traits ?? [],
		cost: a.cost,
		level: a.level,
		// 敌人卡用 enemy_health（字符串），普通卡用 health（数字）。
		health: a.type === "敌人卡" ? toNum(a.enemy_health) : toNum(a.health),
		horror: toNum(a.horror),
		attack: a.attack,
		evade: a.evade,
		enemy_damage: a.enemy_damage,
		shroud: a.shroud,
		clues: a.clues,
		victory: a.victory,
		submit_icon: a.submit_icon ?? [],
		weakness_type: a.weakness_type,
		faces: faceList,
	};
}

/** 进程级缓存：同一 databaseDir 只加载一次。 */
const indexCache = new Map<string, Promise<IndexedCard[]>>();

/**
 * 加载卡牌索引（进程级缓存）。
 *
 * @param databaseDir 数据库根目录（宿主机绝对路径，含 json/ + card_images/）
 * @param sandboxImagePrefix 沙箱内图片路径前缀，如 "cards-db"。
 *   返回的 imageFile 会拼成 `cards-db/card_images/01001_a.jpg`。
 */
export function loadCardIndex(
	databaseDir: string,
	sandboxImagePrefix = "cards-db",
): Promise<IndexedCard[]> {
	const cached = indexCache.get(databaseDir);
	if (cached) return cached;
	const p = (async () => {
		const filePath = join(databaseDir, "json", "全部卡牌.json");
		const raw = await readFile(filePath, "utf8");
		const data = JSON.parse(raw) as AllCardsJson;
		const indexed: IndexedCard[] = [];
		for (const raw of data.cards ?? []) {
			const idx = toIndexed(raw, sandboxImagePrefix);
			if (idx) indexed.push(idx);
		}
		return indexed;
	})();
	indexCache.set(databaseDir, p);
	return p;
}

/** 字符串包含匹配（大小写不敏感）。 */
function contains(haystack: string, needle: string): boolean {
	return haystack.length >= needle.length && haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * 名字相关度评分（无 query 返回 0）。
 * - 完全相等：100
 * - 名字包含 query：80 + (query 越长加分，长 query 更精确)
 * - query 包含名字（用户输入更长）：60
 * - 词元重叠：每个重叠词 +30
 * - 编辑距离相近（≤2）：30 - distance
 * 都不命中 → 负分（排除），由调用方过滤。
 */
function nameScore(name: string, query: string): number {
	const n = name.trim();
	const q = query.trim();
	if (!q) return 0;
	if (n === q) return 100;
	const nl = n.toLowerCase();
	const ql = q.toLowerCase();
	if (nl === ql) return 99;
	if (contains(nl, ql)) return 80 + Math.min(ql.length, 15);
	if (contains(ql, nl)) return 60;
	// 词元重叠（按非字母数字分割；中文按字符）。
	const qTokens = tokenize(q);
	const nTokens = new Set(tokenize(n));
	let overlap = 0;
	for (const t of qTokens) if (nTokens.has(t)) overlap++;
	if (overlap > 0) return Math.min(70, overlap * 30);
	// 编辑距离兜底（只对短串算，避免性能问题）。
	if (q.length <= 8 && n.length <= 12) {
		const d = editDistance(ql, nl);
		if (d <= 2) return 30 - d * 10;
	}
	return -1;
}

/** 简单分词：连续中文字符各算一词 + 英文/数字串。 */
function tokenize(s: string): string[] {
	const tokens: string[] = [];
	let buf = "";
	for (const ch of s) {
		if (/[\u4e00-\u9fff]/.test(ch)) {
			if (buf) { tokens.push(buf); buf = ""; }
			tokens.push(ch);
		} else if (/[\w]/.test(ch)) {
			buf += ch;
		} else {
			if (buf) { tokens.push(buf); buf = ""; }
		}
	}
	if (buf) tokens.push(buf);
	return tokens.filter((t) => t.trim() !== "");
}

/** Levenshtein 编辑距离。 */
function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	const prev = new Array<number>(n + 1);
	const curr = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		for (let j = 0; j <= n; j++) prev[j] = curr[j];
	}
	return prev[n];
}

/** 数值范围判断（undefined 字段不匹配数值范围，除非范围含 -1 的「无」语义）。 */
function inRange(v: number | undefined, min?: number, max?: number): boolean {
	// -1 表示「无该属性」（无费用/无等级），不应匹配正数范围。
	if (v === undefined) return false;
	if (min !== undefined && v < min) return false;
	if (max !== undefined && v > max) return false;
	return true;
}

/**
 * 搜索：按结构化条件 AND 过滤，有 query 时再按相关度排序。
 *
 * 行为：
 * - 结构化过滤后若为 0 且有 query → 回退全库按 query 模糊匹配（避免条件太严查空）。
 * - 不硬凑：结果数 < limit 就返回实际数量。
 * - 无 query 且无任何结构化条件 → 返回空（拒绝无意义全量扫描）。
 */
export function searchCards(index: readonly IndexedCard[], params: SearchParams): SearchResult[] {
	const limit = Math.max(1, Math.min(5, params.limit ?? 5));
	const hasQuery = !!params.query?.trim();

	// 结构化过滤。
	const filtered = index.filter((c) => matchStructured(c, params));

	// 有 query → 在过滤集内评分排序；过滤为空 → 回退全库模糊。
	let pool: readonly IndexedCard[];
	if (hasQuery && filtered.length === 0) {
		pool = index;
	} else {
		pool = filtered;
	}

	let results: SearchResult[];
	if (hasQuery) {
		const q = params.query!.trim();
		results = pool
			.map((card) => ({ card, score: nameScore(card.name_zh, q) }))
			.filter((r) => r.score >= 0);
		results.sort((a, b) => b.score - a.score || a.card.arkhamdb_id.localeCompare(b.card.arkhamdb_id));
	} else {
		// 无 query：结构化过滤结果按 id 排序。
		results = pool.map((card) => ({ card, score: 0 }));
		results.sort((a, b) => a.card.arkhamdb_id.localeCompare(b.card.arkhamdb_id));
	}
	return results.slice(0, limit);
}

/** 结构化条件 AND 匹配（不含 query 模糊）。 */
function matchStructured(c: IndexedCard, p: SearchParams): boolean {
	if (p.investigator_only && c.type !== "调查员") return false;
	if (p.weakness_only && c.class !== "弱点") return false;
	if (p.type && c.type !== p.type) return false;
	if (p.class && c.class !== p.class) return false;
	if (p.category && c.category !== p.category) return false;
	if (p.trait && !c.traits.includes(p.trait)) return false;
	if (p.traits_all && p.traits_all.length > 0) {
		const set = new Set(c.traits);
		for (const t of p.traits_all) if (!set.has(t)) return false;
	}
	if (p.traits_any && p.traits_any.length > 0) {
		const set = new Set(c.traits);
		if (!p.traits_any.some((t) => set.has(t))) return false;
	}
	// 精确等级优先于范围。
	if (p.level_exact !== undefined) {
		if ((c.level ?? undefined) !== p.level_exact) return false;
	} else if (p.level_min !== undefined || p.level_max !== undefined) {
		if (!inRange(c.level, p.level_min, p.level_max)) return false;
	}
	if (p.cost_min !== undefined || p.cost_max !== undefined) {
		if (!inRange(c.cost, p.cost_min, p.cost_max)) return false;
	}
	if (p.health_min !== undefined && (c.health ?? 0) < p.health_min) return false;
	if (p.horror_min !== undefined && (c.horror ?? 0) < p.horror_min) return false;
	if (p.attack_min !== undefined) {
		const a = toNum(c.attack);
		if (a === undefined || a < p.attack_min) return false;
	}
	if (p.evade_min !== undefined) {
		const e = toNum(c.evade);
		if (e === undefined || e < p.evade_min) return false;
	}
	if (p.victory_min !== undefined && (c.victory ?? 0) < p.victory_min) return false;
	return true;
}
