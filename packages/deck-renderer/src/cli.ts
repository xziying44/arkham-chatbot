#!/usr/bin/env node
/**
 * deck-renderer CLI — 验收用命令行。
 *
 * 用法：
 *   deck-renderer inspect --deck <id|deck.json>            # 导入+分类，打印摘要
 *   deck-renderer layout  --deck <id|deck.json> [--out f]  # 导入+自动排班→排班表 JSON
 *   deck-renderer render  --layout f.json [--out f.png]    # 排班表→图
 *   deck-renderer render  --deck <id|deck.json> [--out f]  # 一步：导入+排班+渲染
 *
 * 默认数据路径（可用 flag / 环境变量覆盖）：
 *   --card-db      CHATBOT_CARD_DATABASE_DIR   card-database
 *   --arkhamdb     ARKHAMDB_DATA_DIR           社区数据库/arkhamdb-json-data
 *   --fonts        DECK_FONTS_DIR              arkham-homebrew/fonts
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { registerFonts } from "./fonts.ts";
import { createCardImageResolver } from "./data/card-image-resolver.ts";
import { loadCardMetadata } from "./data/card-metadata.ts";
import { fetchDeck, fetchArkhamBuildDeck, parseArkhamBuildShareId } from "./deck/fetch-deck.ts";
import type { ArkhamDeck } from "./deck/fetch-deck.ts";
import { organizeDeck, expandedCounts } from "./deck/organize.ts";
import { autoLayout, buildDefaultPlan } from "./deck/auto-layout.ts";
import { planDeck, describePositions } from "./plan.ts";
import type { DeckPlan } from "./plan.ts";
import { validateDeckPlan, formatValidation } from "./validate.ts";
import { renderDeck } from "./engine.ts";
import type { DeckLayout } from "./types.ts";

// 默认路径（本机实际位置）
const ROOT = "/Users/xziying/project/arkham";
const DEFAULT_CARD_DB = join(ROOT, "card-database");
const DEFAULT_ARKHAMDB = join(ROOT, "社区数据库", "arkhamdb-json-data");
const DEFAULT_FONTS = join(ROOT, "arkham-homebrew", "fonts");

interface ParsedFlags {
	values: Record<string, string | undefined>;
	positional: string[];
}

function parseFlags(argv: string[], opts: string[]): ParsedFlags {
	const { values, positionals } = parseArgs({
		args: argv,
		options: Object.fromEntries(opts.map((k) => [k, { type: "string" }])),
		allowPositionals: true,
	});
	return { values: values as Record<string, string | undefined>, positional: positionals };
}

function envOr(v: string | undefined, ...keys: string[]): string | undefined {
	if (v) return v;
	for (const k of keys) if (process.env[k]) return process.env[k] as string;
	return undefined;
}

/** deck 参数：数字 → ArkhamDB 在线拉取；arkham.build URL/ID → 在线拉取分享；否则当本地 JSON 文件读。
 *  本地文件兼容两种格式：单卡组对象（ArkhamDB / arkham.build 导出）或历史数组（arkham.build share_history，取末尾最新版）。 */
async function loadDeck(deckArg: string): Promise<ArkhamDeck> {
	const arg = deckArg.trim();
	if (/^\d+$/.test(arg)) {
		console.log(`→ 在线拉取 ArkhamDB 卡组 ${arg} ...`);
		return fetchDeck(arg);
	}
	const shareId = parseArkhamBuildShareId(arg);
	if (shareId) {
		console.log(`→ 在线拉取 arkham.build 分享卡组 ${shareId} ...`);
		return fetchArkhamBuildDeck(shareId);
	}
	console.log(`→ 读取本地 deck 文件 ${deckArg} ...`);
	const raw = JSON.parse(await readFile(deckArg, "utf8")) as unknown;
	if (Array.isArray(raw)) {
		if (raw.length === 0) throw new Error("deck 文件是空数组");
		return raw[raw.length - 1] as ArkhamDeck;
	}
	return raw as ArkhamDeck;
}

async function run(): Promise<void> {
	const sub = process.argv[2] ?? "";
	const rest = process.argv.slice(3);
	const f = parseFlags(rest, ["deck", "layout", "plan", "out", "card-db", "arkhamdb", "fonts", "title", "format", "quality"]);
	const v = f.values;

	const format: "png" | "jpeg" = v.format === "png" ? "png" : "jpeg";
	const quality = v.quality ? Math.max(0.1, Math.min(1, Number(v.quality))) : 0.9;
	const defaultOut = format === "png" ? "deck.png" : "deck.jpg";

	const cardDb = envOr(v["card-db"], "CHATBOT_CARD_DATABASE_DIR") ?? DEFAULT_CARD_DB;
	const arkhamdb = envOr(v["arkhamdb"], "ARKHAMDB_DATA_DIR", "CHATBOT_ARKHAMDB_DATA_DIR") ?? DEFAULT_ARKHAMDB;
	const fonts = envOr(v["fonts"], "DECK_FONTS_DIR") ?? DEFAULT_FONTS;

	if (sub === "render" && v.layout) {
		// 排班表 → 图
		const layout = JSON.parse(await readFile(v.layout, "utf8")) as DeckLayout;
		const out = resolve(v.out ?? defaultOut);
		const registered = registerFonts(fonts);
		console.log(`字体已注册: ${registered.join(", ") || "(无)"}  格式: ${format}${format === "jpeg" ? ` q${quality}` : ""}`);
		const resolver = createCardImageResolver({ cardDatabaseDir: cardDb });
		const buf = await renderDeck(layout, { resolver, format, quality });
		await mkdir(dirname(out), { recursive: true });
		await writeFile(out, buf);
		console.log(`✓ 已渲染 → ${out} (${(buf.byteLength / 1024).toFixed(0)} KB)`);
		return;
	}

	if (sub === "plan" && v.deck) {
		// 导入 + 分类 → 默认槽位 plan（agent 可编辑槽位名/归组/顺序）
		const deck = await loadDeck(v.deck);
		const meta = await loadCardMetadata(arkhamdb, cardDb);
		const organized = organizeDeck(deck, meta);
		const plan = buildDefaultPlan(organized, { title: v.title ?? deck.name });
		const out = resolve(v.out ?? "plan.json");
		await mkdir(dirname(out), { recursive: true });
		await writeFile(out, JSON.stringify(plan, null, 2), "utf8");
		const total = plan.slots.reduce((s, x) => s + x.cards.length, 0);
		console.log(`✓ 默认排班计划 → ${out}（${plan.slots.length} 槽位，${total} 张卡）`);
		console.log("  槽位:", plan.slots.map((s) => `${s.name}(${s.cards.length})`).join(", "));
		if (organized.warnings.length > 0) console.log(`  ⚠ 未识别卡: ${organized.warnings.join(", ")}`);
		return;
	}

	if (sub === "check" && v.plan) {
		// 静态图名校验（不渲染），返回缺图警告 + 候选 ID
		const plan = JSON.parse(await readFile(v.plan, "utf8")) as DeckPlan;
		const report = await validateDeckPlan(plan, join(cardDb, "card_images"));
		console.log(formatValidation(report));
		if (!report.ok) process.exitCode = 1;
		return;
	}

	if (sub === "render" && v.plan) {
		// 槽位 plan → 渲染 + 打印每卡位置
		const plan = JSON.parse(await readFile(v.plan, "utf8")) as DeckPlan;
		const result = planDeck(plan);
		const out = resolve(v.out ?? defaultOut);
		const registered = registerFonts(fonts);
		console.log(`字体: ${registered.join(", ") || "(无)"}  格式: ${format}`);
		const resolver = createCardImageResolver({ cardDatabaseDir: cardDb });
		const buf = await renderDeck(result.layout, { resolver, format, quality });
		await mkdir(dirname(out), { recursive: true });
		await writeFile(out, buf);
		console.log(`✓ 已渲染 → ${out} (${(buf.byteLength / 1024).toFixed(0)} KB)  画布 ${result.width}×${result.height}`);
		console.log("\n=== 卡牌位置（供智能体感知）===");
		console.log(describePositions(result));
		console.log("\n=== 图名校验（缺图警告，供智能体修正 ID）===");
		const report = await validateDeckPlan(plan, join(cardDb, "card_images"));
		console.log(formatValidation(report));
		return;
	}

	if ((sub === "layout" || sub === "render" || sub === "inspect") && v.deck) {
		const deck = await loadDeck(v.deck);
		console.log(`调查员: ${deck.investigator_name ?? deck.investigator_code}  卡组: ${deck.name}`);
		const meta = await loadCardMetadata(arkhamdb, cardDb);
		console.log(`元数据: ${meta.size} 张`);
		const organized = organizeDeck(deck, meta);

		if (sub === "inspect") {
			console.log("\n=== 分类摘要 ===");
			console.log(JSON.stringify(expandedCounts(organized), null, 2));
			console.log(`阵营: ${organized.investigator.faction}  边框色: ${organized.borderColor}`);
			console.log(`主卡张数: ${organized.totalCards}`);
			if (organized.warnings.length > 0) {
				console.log(`⚠ 未识别卡 (${organized.warnings.length}): ${organized.warnings.join(", ")}`);
			}
			return;
		}

		const layout = autoLayout(organized, { title: v.title ?? deck.name });

		if (sub === "layout") {
			const out = resolve(v.out ?? "layout.json");
			await mkdir(dirname(out), { recursive: true });
			await writeFile(out, JSON.stringify(layout, null, 2), "utf8");
			console.log(`✓ 排班表 → ${out}（${layout.sections.length} 块）`);
			return;
		}

		// render --deck：一步出图
		const out = resolve(v.out ?? defaultOut);
		const registered = registerFonts(fonts);
		console.log(`字体已注册: ${registered.join(", ") || "(无)"}  格式: ${format}${format === "jpeg" ? ` q${quality}` : ""}`);
		const resolver = createCardImageResolver({ cardDatabaseDir: cardDb });
		const buf = await renderDeck(layout, { resolver, format, quality });
		await mkdir(dirname(out), { recursive: true });
		await writeFile(out, buf);
		console.log(`✓ 已渲染 → ${out} (${(buf.byteLength / 1024).toFixed(0)} KB)`);
		if (organized.warnings.length > 0) {
			console.log(`⚠ 未识别卡: ${organized.warnings.join(", ")}`);
		}
		return;
	}

	usage();
}

function usage(): void {
	const t = `deck-renderer <command> [options]

命令:
  inspect --deck <id|file>                  导入+分类，打印摘要
  plan    --deck <id|file> [--out plan.json]  导入+分类 → 默认槽位 plan（agent 可编辑）
  check   --plan plan.json                  静态图名校验 → 缺图警告 + 候选 ID（不渲染）
  render  --plan plan.json [--out f.jpg]    槽位 plan → 渲染 + 打印每卡位置 + 缺图校验
  render  --deck <id|file> [--out f.jpg]    一步：导入+排班+渲染
  render  --layout f.json [--out f.jpg]     [低层] 带坐标排班表 → 图

选项:
  --deck <id|file>      ArkhamDB deck id（数字）或本地 deck JSON 文件
  --plan <file>         槽位 plan JSON（render 用）
  --layout <file>       [低层] 带坐标排班表 JSON
  --out <file>          输出路径（默认 deck.jpg / plan.json）
  --title <text>        覆盖卡组标题
  --format <png|jpeg>   输出格式，默认 jpeg（快约9倍、文件小）
  --quality <0-1>       jpeg 质量，默认 0.9
  --card-db <dir>       card-database 目录 (默认 $CHATBOT_CARD_DATABASE_DIR)
  --arkhamdb <dir>      社区数据库 arkhamdb-json-data 目录 (默认 $ARKHAMDB_DATA_DIR)
  --fonts <dir>         字体目录 (默认 $DECK_FONTS_DIR)
`;
	console.log(t);
	process.exit(1);
}

run().catch((e: unknown) => {
	console.error(`✗ ${(e as Error).message}`);
	process.exit(1);
});
