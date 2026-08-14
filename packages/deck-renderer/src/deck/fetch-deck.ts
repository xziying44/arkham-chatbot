/**
 * 卡组拉取（Layer 3）：从 ArkhamDB 公开 API 取一份卡组 JSON。
 *
 * 接口：GET https://arkhamdb.com/api/public/deck/{deck_id}
 * 返回结构核心：{ investigator_code, slots: {code: count}, sideSlots, taboo_id, xp, meta, ... }
 * 卡组本质就是 slots 这个 code→数量映射。
 *
 * 容错：带 UA 头（防服务器断开）、忽略 SSL（旧代码 verify=False 的等价），
 * 失败重试一次。deck 必须是公开的（public endpoint）。
 */

/** ArkhamDB 公开 deck JSON（只列我们用到的字段）。 */
export interface ArkhamDeck {
	id: number;
	name: string;
	investigator_code: string;
	investigator_name?: string;
	/** code → 数量。 */
	slots: Record<string, number>;
	/** 升级备卡 code → 数量。 */
	sideSlots?: Record<string, number>;
	/** 禁忌表 id（影响某些卡的图/文本）。 */
	taboo_id?: number | null;
	xp?: number;
	meta?: string;
	description_md?: string;
	/** 原始字段透传（诊断用）。 */
	[key: string]: unknown;
}

const API_BASE = "https://arkhamdb.com/api/public/deck";
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface FetchDeckOptions {
	signal?: AbortSignal;
	/** 覆盖 API base（测试用）。 */
	apiBase?: string;
	/** 重试间隔 ms，默认 800。 */
	retryDelayMs?: number;
}

/**
 * 拉取一份公开卡组。
 * @param deckId ArkhamDB deck id（数字字符串）
 * @throws 网络错误或非 200 时抛 Error
 */
export async function fetchDeck(deckId: string | number, opts: FetchDeckOptions = {}): Promise<ArkhamDeck> {
	const base = opts.apiBase ?? API_BASE;
	const url = `${base}/${deckId}`;
	const delay = opts.retryDelayMs ?? 800;

	async function once(): Promise<Response> {
		// 旧代码 verify=False：Node fetch 对合法公网证书默认通过，arkhamdb 证书有效，无需特殊处理
		return fetch(url, {
			headers: { "User-Agent": UA, Accept: "application/json" },
			signal: opts.signal,
		});
	}

	let resp: Response;
	try {
		resp = await once();
		if (resp.status === 429 || resp.status >= 500) {
			// 限流/服务端错误：等一下重试一次
			await new Promise((r) => setTimeout(r, delay));
			resp = await once();
		}
	} catch (e) {
		// 网络错误：重试一次
		await new Promise((r) => setTimeout(r, delay));
		resp = await once().catch(() => {
			throw new Error(`请求 ArkhamDB 失败：${(e as Error).message}`);
		});
	}

	if (!resp.ok) {
		const detail = resp.status === 404 ? "卡组不存在或非公开" : `HTTP ${resp.status}`;
		throw new Error(`查询卡组 ${deckId} 失败：${detail}`);
	}

	const json = (await resp.json()) as ArkhamDeck;
	if (!json || typeof json !== "object" || !json.investigator_code) {
		throw new Error(`卡组 ${deckId} 返回数据格式异常`);
	}
	return json;
}

// ---------------------------------------------------------------------------
// arkham.build 分享卡组
//
// 站点是 SPA（Cloudflare Pages + Functions），数据走 legacy API：
//   GET https://api.arkham.build/v1/public/share_history/{shareId}
// 返回【历史版本数组】（ArkhamDB 兼容格式的 Deck[]），取末尾即最新版。
// 卡组模型（frontend/src/store/schemas/deck.schema.ts）与 ArkhamDB 完全同构：
// slots/sideSlots/investigator_code/taboo_id/meta/previous_deck/next_deck…
// 所以 organizeDeck 无需改动即可直接解析。
// ---------------------------------------------------------------------------

const ARKHAM_BUILD_HISTORY_API = "https://api.arkham.build/v1/public/share_history";

/** arkham.build 分享 ID：如 "EaXFKGBAR7i9hob"（15 位大小写字母数字）。 */
const SHARE_ID_RE = /^[A-Za-z0-9]{10,20}$/;

/** 从各种输入解析出 arkham.build 分享 ID。支持完整 URL、带路径短链、裸 ID。 */
export function parseArkhamBuildShareId(input: string): string | null {
	const s = input.trim();
	// https://arkham.build/deck/view/EaXFKGBAR7i9hob
	const m = s.match(/arkham\.build\/(?:deck|decklist)\/view\/([A-Za-z0-9]+)/i);
	if (m) return m[1];
	// 裸 ID
	if (SHARE_ID_RE.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s)) return s;
	return null;
}

/** 拉取 arkham.build 分享卡组（取历史数组末尾 = 最新版）。 */
export async function fetchArkhamBuildDeck(
	shareId: string,
	opts: FetchDeckOptions = {},
): Promise<ArkhamDeck> {
	const url = `${opts.apiBase ?? ARKHAM_BUILD_HISTORY_API}/${shareId}`;
	const resp = await fetch(url, {
		headers: { "User-Agent": UA, Accept: "application/json" },
		signal: opts.signal,
	}).catch((e: unknown) => {
		throw new Error(`请求 arkham.build 失败：${(e as Error).message}`);
	});
	if (!resp.ok) {
		const detail = resp.status === 404 ? "分享不存在或已删除" : `HTTP ${resp.status}`;
		throw new Error(`查询 arkham.build 卡组 ${shareId} 失败：${detail}`);
	}
	const history = (await resp.json()) as unknown;
	if (!Array.isArray(history) || history.length === 0) {
		throw new Error(`arkham.build 卡组 ${shareId} 返回数据格式异常（非历史数组）`);
	}
	const deck = history[history.length - 1] as ArkhamDeck;
	if (!deck?.investigator_code) {
		throw new Error(`arkham.build 卡组 ${shareId} 缺少 investigator_code`);
	}
	return deck;
}
