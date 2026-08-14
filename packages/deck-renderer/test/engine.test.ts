import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { renderDeck, computeHeight, sectionHeight, createImageCache } from "../src/engine.ts";
import type { CardImageResolver, DeckLayout, DeckSection } from "../src/types.ts";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("sectionHeight: 几何计算", () => {
	// 17 卡、7 列、卡 368x532、gap 12、标题栏 70
	const s = {
		title: "t",
		pos: [0, 0] as const,
		cardSize: [368, 532] as const,
		cols: 7,
		gap: 12,
		titleHeight: 70,
		cards: Array.from({ length: 17 }, () => ({ code: "x" })),
	} as DeckSection;
	// rows=ceil(17/7)=3; height = 30 + 70 + (12 + 3*(532+12)) + 30 = 1774
	assert.equal(sectionHeight(s, 2820), 1774);
});

test("sectionHeight: 空块只有标题栏", () => {
	const s = { title: "t", pos: [0, 0] as const, cardSize: [100, 150] as const, cols: 5, cards: [] } as DeckSection;
	// 30 + 70(默认标题) + 0 + 30 = 130
	assert.equal(sectionHeight(s, 1000), 130);
});

test("computeHeight: 从 section 自动算画布高", () => {
	const layout = {
		canvas: { width: 1000 },
		sections: [
			{
				title: "t",
				pos: [0, 100] as const,
				cardSize: [100, 150] as const,
				cols: 5,
				gap: 10,
				titleHeight: 60,
				cards: Array.from({ length: 12 }, () => ({ code: "x" })),
			},
		],
	} as DeckLayout;
	// section 高 = 30+60+(10+3*160)+30 = 610；底部 = 100+610 = 710；+50 padding = 760
	assert.equal(computeHeight(layout), 760);
});

test("createImageCache: LRU 淘汰", () => {
	const c = createImageCache(2);
	c.set("a", null);
	c.set("b", null);
	assert.equal(c.get("a"), null); // 命中 → a 变最近
	c.set("c", null); // 淘汰最久未用的 b
	assert.equal(c.get("b"), undefined);
	assert.equal(c.get("a"), null);
	assert.equal(c.get("c"), null);
	assert.equal(c.size, 2);
});

test("renderDeck: 缺图走占位，仍输出合法 PNG", async () => {
	const resolver: CardImageResolver = { async resolve() { return null; } };
	const layout = {
		canvas: { width: 300, height: 200, background: "#ffffff" },
		sections: [
			{ title: "测试", pos: [10, 10] as const, cardSize: [60, 80] as const, cols: 3, cards: [{ code: "miss", label: "缺图卡" }] },
		],
	} as DeckLayout;
	const buf = await renderDeck(layout, { resolver, format: "png" });
	assert.deepEqual(buf.subarray(0, 8), PNG_SIG);
	assert.ok(buf.byteLength > 100);
});

test("renderDeck: 默认 jpeg 输出合法 JPEG 头", async () => {
	const resolver: CardImageResolver = { async resolve() { return null; } };
	const layout = {
		canvas: { width: 100, height: 100 },
		sections: [{ title: "t", pos: [0, 0] as const, cardSize: [40, 40] as const, cols: 1, cards: [{ code: "x" }] }],
	} as DeckLayout;
	const buf = await renderDeck(layout, { resolver }); // 默认 jpeg
	assert.equal(buf[0], 0xff);
	assert.equal(buf[1], 0xd8);
	assert.equal(buf[2], 0xff);
});

test("renderDeck: 给定卡图能正常 cover-fit 绘制", async () => {
	const c = createCanvas(10, 10);
	const ctx = c.getContext("2d");
	ctx.fillStyle = "#ff0000";
	ctx.fillRect(0, 0, 10, 10);
	const redBuf = c.toBuffer("image/png");
	const resolver: CardImageResolver = { async resolve() { return redBuf; } };
	const layout = {
		canvas: { width: 100, height: 100 },
		sections: [{ title: "t", pos: [0, 0] as const, cardSize: [50, 50] as const, cols: 1, cards: [{ code: "r" }] }],
	} as DeckLayout;
	const buf = await renderDeck(layout, { resolver, format: "png" });
	assert.deepEqual(buf.subarray(0, 8), PNG_SIG);
});
