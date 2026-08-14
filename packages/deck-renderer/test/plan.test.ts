import { test } from "node:test";
import assert from "node:assert/strict";
import { planDeck, describePositions } from "../src/plan.ts";
import type { DeckPlan } from "../src/plan.ts";

test("planDeck: 左对齐+顶部对齐+卡宽填满+位置回传", () => {
	// 宽 1000，5 列，gap 10 → usable=840, cardW=floor((840-40)/5)=160
	const plan: DeckPlan = {
		width: 1000,
		columns: 5,
		gap: 10,
		promo: [],
		slots: [{ name: "A", cards: Array.from({ length: 7 }, (_, i) => ({ code: `c${i}`, label: `卡${i}` })) }],
	};
	const r = planDeck(plan);
	const innerX = 50 + 30; // marginX + INNER_PADDING
	const cardsY = r.slots[0].y + 30 + 70 + 10; // INNER_PADDING + titleH + gap

	// c0：第1行第0列，左上角
	const p0 = r.positions.find((p) => p.code === "c0")!;
	assert.equal(p0.row, 0);
	assert.equal(p0.col, 0);
	assert.equal(p0.x, innerX);
	assert.equal(p0.y, cardsY);
	assert.equal(p0.w, 160);

	// c4：第1行第4列（行末），x = innerX + 4*(160+10)
	const p4 = r.positions.find((p) => p.code === "c4")!;
	assert.equal(p4.col, 4);
	assert.equal(p4.x, innerX + 4 * 170);

	// c5：第2行第0列 —— 残行左对齐（不是居中）
	const p5 = r.positions.find((p) => p.code === "c5")!;
	assert.equal(p5.row, 1);
	assert.equal(p5.col, 0);
	assert.equal(p5.x, innerX); // 关键：残行也靠左

	// c6：第2行第1列
	const p6 = r.positions.find((p) => p.code === "c6")!;
	assert.equal(p6.row, 1);
	assert.equal(p6.col, 1);
	assert.equal(p6.x, innerX + 170);

	assert.equal(r.slots[0].rows, 2);
	assert.equal(r.slots[0].cols, 5);
	assert.equal(r.slots[0].count, 7);
});

test("planDeck: 多槽位纵向堆叠", () => {
	const plan: DeckPlan = {
		width: 1000,
		columns: 5,
		promo: [],
		slots: [
			{ name: "上", cards: Array.from({ length: 5 }, (_, i) => ({ code: `a${i}` })) },
			{ name: "下", cards: Array.from({ length: 3 }, (_, i) => ({ code: `b${i}` })) },
		],
	};
	const r = planDeck(plan);
	assert.ok(r.slots[1].y > r.slots[0].y, "第二个槽位在第一个下方");
	// 位置按槽位归类
	assert.equal(r.positions.filter((p) => p.slot === "上").length, 5);
	assert.equal(r.positions.filter((p) => p.slot === "下").length, 3);
});

test("planDeck: 空槽位被跳过", () => {
	const plan: DeckPlan = {
		width: 1000,
		columns: 5,
		promo: [],
		slots: [
			{ name: "空", cards: [] },
			{ name: "有", cards: [{ code: "x1" }] },
		],
	};
	const r = planDeck(plan);
	assert.equal(r.slots.length, 1);
	assert.equal(r.slots[0].name, "有");
});

test("describePositions: 文字报告含槽位名+每卡位置", () => {
	const plan: DeckPlan = {
		width: 500,
		columns: 3,
		promo: [],
		slots: [{ name: "测试槽", cards: [{ code: "00001", label: "卡A" }] }],
	};
	const text = describePositions(planDeck(plan));
	assert.ok(text.includes("测试槽"));
	assert.ok(text.includes("卡A(00001)"));
	assert.ok(text.includes("行1"));
});
