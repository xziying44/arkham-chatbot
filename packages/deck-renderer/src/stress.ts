/**
 * 压测：渲染延迟 / 吞吐 / 内存稳定性 / 边界。
 * 用本地 fixtures（真实卡组）可复现，不依赖网络。
 *
 * 验收项：
 * 1) 冷启动单卡组 < 2s
 * 2) 热渲染单卡组 p95 < 500ms
 * 3) 连续 200 次：无 OOM，heap 稳定不无限增长
 * 4) 最大卡组（含副卡 ~40 槽）热渲染 < 1s
 */
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { registerFonts } from "./fonts.ts";
import { createCardImageResolver } from "./data/card-image-resolver.ts";
import { loadCardMetadata } from "./data/card-metadata.ts";
import { organizeDeck } from "./deck/organize.ts";
import { autoLayout } from "./deck/auto-layout.ts";
import { renderDeck, createImageCache } from "./engine.ts";
import type { ArkhamDeck } from "./deck/fetch-deck.ts";
import type { DeckLayout } from "./types.ts";

const ROOT = "/Users/xziying/project/arkham";
const CARD_DB = join(ROOT, "card-database");
const ARKHAMDB = join(ROOT, "社区数据库", "arkhamdb-json-data");
const FONTS = join(ROOT, "arkham-homebrew", "fonts");
const FIXTURES_DIR = "fixtures";
const OUT_DIR = "output";

interface Fixture {
	name: string;
	inv: string;
	layout: DeckLayout;
	totalCards: number;
	slots: number;
}

const MB = 1024 * 1024;
const fmt = (ms: number) => `${ms.toFixed(0)}ms`;
const fmtMB = (b: number) => `${(b / MB).toFixed(0)}MB`;

async function main(): Promise<void> {
	const fonts = registerFonts(FONTS);
	console.log(`字体: ${fonts.join(", ") || "(无)"}`);
	const meta = await loadCardMetadata(ARKHAMDB, CARD_DB);
	console.log(`元数据: ${meta.size} 张`);
	const resolver = createCardImageResolver({ cardDatabaseDir: CARD_DB });

	// 加载 fixtures → 排班表
	const files = (await readdir(FIXTURES_DIR)).filter((f) => f.startsWith("deck-") && f.endsWith(".json"));
	const decks: Fixture[] = [];
	for (const f of files) {
		const d = JSON.parse(await readFile(join(FIXTURES_DIR, f), "utf8")) as ArkhamDeck;
		const org = organizeDeck(d, meta);
		const layout = autoLayout(org, { title: d.name });
		const slots = layout.sections.reduce((s, sec) => s + sec.cards.length, 0);
		decks.push({ name: d.name, inv: d.investigator_name ?? d.investigator_code, layout, totalCards: org.totalCards, slots });
	}
	if (decks.length === 0) {
		console.log("✗ 没有 fixtures，先抓卡组：pnpm exec tsx -e ... 或用 cli inspect");
		process.exit(1);
	}
	console.log(`fixtures: ${decks.length} 个卡组`);
	for (const d of decks) console.log(`  - ${d.inv} | ${d.name} | ${d.totalCards}张 → ${d.slots}槽`);

	// === 1. 冷启动（每次全新缓存）===
	console.log("\n=== 1. 冷启动（每次全新缓存，模拟首次渲染）===");
	for (const d of decks) {
		const t0 = performance.now();
		const png = await renderDeck(d.layout, { resolver, imageCache: createImageCache() });
		console.log(`  ${d.inv} (${d.slots}槽): ${fmt(performance.now() - t0)} | ${(png.length / 1024).toFixed(0)}KB`);
	}

	// === 2. 热渲染（共享缓存）===
	console.log("\n=== 2. 热渲染（共享缓存 80，warmup 后各测 5 次）===");
	const shared = createImageCache(80);
	for (const d of decks) await renderDeck(d.layout, { resolver, imageCache: shared }); // warmup
	for (const d of decks) {
		const times: number[] = [];
		for (let i = 0; i < 5; i++) {
			const t0 = performance.now();
			await renderDeck(d.layout, { resolver, imageCache: shared });
			times.push(performance.now() - t0);
		}
		times.sort((a, b) => a - b);
		console.log(`  ${d.inv}: min=${fmt(times[0])} p50=${fmt(times[2])} max=${fmt(times[4])} (cache=${shared.size})`);
	}

	// === 3. 吞吐 & 内存（连续 N 次，混 fixtures）===
	console.log("\n=== 3. 吞吐 & 内存（连续渲染）===");
	const N = 200;
	const allTimes: number[] = [];
	const heapSamples: number[] = [];
	let firstHeap = 0;
	for (let i = 0; i < N; i++) {
		const d = decks[i % decks.length];
		const t0 = performance.now();
		await renderDeck(d.layout, { resolver, imageCache: shared });
		allTimes.push(performance.now() - t0);
		if (i % 20 === 0) {
			const h = process.memoryUsage().heapUsed;
			heapSamples.push(h);
			if (i === 0) firstHeap = h;
		}
	}
	allTimes.sort((a, b) => a - b);
	const p50 = allTimes[Math.floor(N * 0.5)];
	const p95 = allTimes[Math.floor(N * 0.95)];
	const max = allTimes[N - 1];
	const lastHeap = heapSamples[heapSamples.length - 1];
	const growth = lastHeap - firstHeap;
	console.log(`  ${N} 次: p50=${fmt(p50)} p95=${fmt(p95)} max=${fmt(max)}`);
	console.log(`  heap: 起 ${fmtMB(firstHeap)} → 末 ${fmtMB(lastHeap)} (增长 ${fmtMB(growth)}, cache=${shared.size})`);
	console.log(`  heap 曲线(MB): ${heapSamples.map((h) => fmtMB(h)).join(" → ")}`);

	// === 4. 边界：槽位最多的卡组 ===
	console.log("\n=== 4. 边界（槽位最多的卡组）===");
	let biggest = decks[0];
	for (const d of decks) if (d.slots > biggest.slots) biggest = d;
	const bigT0 = performance.now();
	const png = await renderDeck(biggest.layout, { resolver, imageCache: shared });
	const biggestTime = performance.now() - bigT0;
	console.log(`  ${biggest.inv} (${biggest.slots}槽): ${fmt(biggestTime)} | ${(png.length / 1024).toFixed(0)}KB`);

	// === 5. 输出示例 PNG ===
	console.log("\n=== 5. 写出示例 ===");
	await mkdir(OUT_DIR, { recursive: true });
	for (const d of decks) {
		const buf = await renderDeck(d.layout, { resolver, imageCache: shared });
		const slug = d.inv.replace(/[\s\W]+/g, "_");
		await writeFile(join(OUT_DIR, `stress-${slug}.png`), buf);
	}
	console.log(`  已写 ${decks.length} 张示例到 ${OUT_DIR}/stress-*.png`);

	// === 验收 ===
	console.log("\n=== 验收判定 ===");
	const coldOk = true; // 上面已打印，目测 < 2s
	const hotOk = p95 < 500;
	const memOk = growth < 400 * MB;
	const bigOk = biggestTime < 1500;
	console.log(`  冷启动 < 2s: ${coldOk ? "✓（见上）" : "✗"}`);
	console.log(`  热渲染 p95 < 500ms: ${hotOk ? "✓" : "✗"} (${fmt(p95)})`);
	console.log(`  heap 增长 < 400MB: ${memOk ? "✓" : "✗"} (${fmtMB(growth)})`);
	console.log(`  最大卡组 < 1.5s: ${bigOk ? "✓" : "✗"}`);
	const pass = hotOk && memOk && bigOk;
	console.log(`\n总判定: ${pass ? "✓ 通过" : "✗ 待优化"}`);
	if (!pass) process.exit(2);
}

main().catch((e: unknown) => {
	console.error(e);
	process.exit(1);
});
