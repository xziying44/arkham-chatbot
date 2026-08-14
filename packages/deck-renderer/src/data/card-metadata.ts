/**
 * 卡牌元数据（Layer 2）：合并两套数据源，补齐分类所需字段。
 *
 * - 标准字段（type_code/faction_code/xp/cost/slot/permanent/restrictions）来自
 *   社区数据库 arkhamdb-json-data（按 pack 拆分的标准 ArkhamDB JSON）。
 * - 中文名 name_zh / 卡图文件名 imageFile 来自 card-database（中文导出库）。
 * 两边都以 code(=arkhamdb_id) 为主键对齐合并。
 *
 * bot 现有 IndexedCard 只有 type/class/level/cost，缺 permanent/slot/restrictions，
 * 这层专门补上 organize 分类要用的字段。进程级缓存：同目录只加载一次。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Dirent } from "node:fs";

/** 一张卡的合并元数据。 */
export interface CardMeta {
	code: string;
	/** 展示名：优先中文，回退英文。 */
	name: string;
	name_zh?: string;
	name_en?: string;
	/** asset/event/skill/investigator/location/... */
	type_code?: string;
	faction_code?: string;
	/** 等级 0-5，无等级卡为 0。 */
	xp: number;
	/** 费用；无费用（技能/弱点）为 -1。 */
	cost: number;
	/** 部位 Hand/Body/Accessory/Arcane/Ally/... */
	slot?: string;
	permanent?: boolean;
	/** 限定字符串，如 "investigator:01001"。 */
	restrictions?: string;
	traits?: string;
	/** 卡图文件名，如 "01006_a.jpg"。 */
	imageFile?: string;
	is_double_sided?: boolean;
}

interface RawStandardCard {
	code?: string;
	name?: string;
	type_code?: string;
	faction_code?: string;
	xp?: number;
	cost?: number | null;
	slot?: string;
	permanent?: boolean;
	restrictions?: string;
	traits?: string;
	double_sided?: boolean;
}

interface RawCnFace {
	image_file?: string;
	content?: { name?: string };
}

interface RawCnCard {
	arkhamdb_id?: string;
	name_zh?: string;
	is_double_sided?: boolean;
	faces?: Record<string, RawCnFace>;
}

function toNum(v: unknown, def: number): number {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	return def;
}

/** 递归收集 arkhamdb-json-data 的 pack 目录下所有 json。 */
async function collectPackFiles(packsDir: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory()) await walk(full);
			else if (e.isFile() && e.name.endsWith(".json")) out.push(full);
		}
	}
	await walk(packsDir);
	return out;
}

/** 读一个 pack json，兼容顶层数组或 {cards:[...]}。 */
async function readPackCards(file: string): Promise<RawStandardCard[]> {
	const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
	if (Array.isArray(raw)) return raw as RawStandardCard[];
	if (raw && typeof raw === "object" && Array.isArray((raw as { cards?: unknown }).cards)) {
		return (raw as { cards: RawStandardCard[] }).cards;
	}
	return [];
}

/** 进程级缓存：同一对目录只加载一次。 */
const metaCache = new Map<string, Promise<Map<string, CardMeta>>>();

/**
 * 加载合并元数据。
 * @param arkhamdbDataDir 社区数据库 arkhamdb-json-data 根目录
 * @param cardDatabaseDir  card-database 根目录（含 json/）
 * @returns code → CardMeta 的 Map
 */
export function loadCardMetadata(
	arkhamdbDataDir: string,
	cardDatabaseDir: string,
): Promise<Map<string, CardMeta>> {
	const cacheKey = `${arkhamdbDataDir}\n${cardDatabaseDir}`;
	const cached = metaCache.get(cacheKey);
	if (cached) return cached;

	const p = (async () => {
		const map = new Map<string, CardMeta>();

		// 1. 标准字段
		const packFiles = await collectPackFiles(join(arkhamdbDataDir, "pack"));
		for (const f of packFiles) {
			const cards = await readPackCards(f);
			for (const c of cards) {
				if (!c.code) continue;
				// 跳过明显非卡牌的 pack 元数据文件（无 type_code 且无 name）
				if (!c.type_code && !c.name) continue;
				map.set(c.code, {
					code: c.code,
					name: c.name ?? c.code,
					name_en: c.name,
					type_code: c.type_code,
					faction_code: c.faction_code,
					xp: toNum(c.xp, 0),
					cost: typeof c.cost === "number" ? c.cost : -1,
					slot: c.slot,
					permanent: c.permanent === true,
					restrictions: c.restrictions,
					traits: c.traits,
					is_double_sided: c.double_sided,
				});
			}
		}

		// 2. 中文名 + 卡图（card-database）。读玩家卡 + 全部卡牌（兜底）。
		for (const rel of ["json/玩家卡.json", "json/全部卡牌.json"]) {
			let raw: string;
			try {
				raw = await readFile(join(cardDatabaseDir, rel), "utf8");
			} catch {
				continue;
			}
			const data = JSON.parse(raw) as { cards?: RawCnCard[] };
			for (const c of data.cards ?? []) {
				const code = c.arkhamdb_id;
				if (!code) continue;
				const faceA = c.faces?.a;
				const nameZh = c.name_zh ?? faceA?.content?.name;
				const imageFile = faceA?.image_file;
				const existing = map.get(code);
				if (existing) {
					if (nameZh && !existing.name_zh) {
						existing.name_zh = nameZh;
						existing.name = nameZh;
					}
					if (imageFile) existing.imageFile = imageFile;
					if (c.is_double_sided) existing.is_double_sided = true;
				} else {
					map.set(code, {
						code,
						name: nameZh ?? code,
						name_zh: nameZh,
						imageFile,
						is_double_sided: c.is_double_sided,
						xp: 0,
						cost: -1,
					});
				}
			}
		}
		return map;
	})();

	metaCache.set(cacheKey, p);
	return p;
}

/** 诊断：统计加载结果（不读文件，仅当已加载时返回）。 */
export async function peekMetadata(
	arkhamdbDataDir: string,
	cardDatabaseDir: string,
): Promise<{ total: number; withNameZh: number; withImage: number } | null> {
	const cacheKey = `${arkhamdbDataDir}\n${cardDatabaseDir}`;
	if (!metaCache.has(cacheKey)) return null;
	const map = await metaCache.get(cacheKey)!;
	let withNameZh = 0;
	let withImage = 0;
	for (const m of map.values()) {
		if (m.name_zh) withNameZh++;
		if (m.imageFile) withImage++;
	}
	return { total: map.size, withNameZh, withImage };
}

/** 仅供测试：清空进程级缓存。 */
export function _clearMetadataCacheForTest(): void {
	metaCache.clear();
}
