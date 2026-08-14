import { test } from "node:test";
import assert from "node:assert/strict";
import { organizeDeck, assetSlotWeight, expandCards, expandedCounts } from "../src/deck/organize.ts";
import type { ArkhamDeck } from "../src/deck/fetch-deck.ts";
import type { CardMeta } from "../src/data/card-metadata.ts";

/** 构造一个最小 CardMeta（必填字段给默认值）。 */
function M(code: string, over: Partial<CardMeta> = {}): CardMeta {
	return { code, name: code, xp: 0, cost: -1, ...over };
}

const meta = new Map<string, CardMeta>([
	["01001", M("01001", { name: "罗兰", faction_code: "guardian", type_code: "investigator" })],
	["01006", M("01006", { name: "罗兰的.38", type_code: "asset", cost: 3, slot: "Hand", restrictions: "investigator:01001" })],
	["05011", M("05011", { name: "家族遗产", type_code: "asset", permanent: true })],
	["01047", M("01047", { name: ".45自动手枪", type_code: "asset", cost: 3, slot: "Hand x2" })],
	["01053", M("01053", { name: "放大镜", type_code: "asset", cost: 1, slot: "Accessory" })],
	["01080", M("01080", { name: "背水一战", type_code: "event", cost: 2 })],
	["01116", M("01116", { name: "自动成功", type_code: "skill" })],
]);

const baseDeck = {
	id: 1,
	name: "测试卡组",
	investigator_code: "01001",
	investigator_name: "罗兰",
	slots: { "01006": 1, "05011": 1, "01047": 2, "01053": 1, "01080": 1, "01116": 1, "99999": 1 },
	sideSlots: { "01080": 1 },
} as ArkhamDeck;

test("assetSlotWeight: 部位权重", () => {
	assert.equal(assetSlotWeight("Hand x2"), 2);
	assert.equal(assetSlotWeight("Hand"), 1);
	assert.equal(assetSlotWeight("Body"), 3);
	assert.equal(assetSlotWeight("Accessory"), 4);
	assert.equal(assetSlotWeight("Arcane"), 5);
	assert.equal(assetSlotWeight("Ally"), 6);
	assert.equal(assetSlotWeight("Tarot"), 7);
	assert.equal(assetSlotWeight(undefined), 8);
	assert.equal(assetSlotWeight("手部 x2"), 2); // 中文兼容
});

test("organizeDeck: 分类 + 边框色 + warnings", () => {
	const d = organizeDeck(baseDeck, meta);
	assert.equal(d.investigator.faction, "guardian");
	assert.equal(d.borderColor, "#0076c8");
	assert.deepEqual(d.investigator.cards.map((c) => c.baseCode), ["01006"]);
	assert.deepEqual(d.permanentAsset.map((c) => c.baseCode), ["05011"]);
	// asset 按 slotWeight 排序：Hand x2(2) < Accessory(4)
	assert.deepEqual(d.asset.map((c) => c.baseCode), ["01047", "01053"]);
	assert.deepEqual(d.event.map((c) => c.baseCode), ["01080"]);
	assert.deepEqual(d.skill.map((c) => c.baseCode), ["01116"]);
	assert.deepEqual(d.sideCards.map((c) => c.baseCode), ["01080"]);
	assert.deepEqual(d.warnings, ["99999"]);
});

test("expandCards: 按 count 展开，顺序保持", () => {
	const d = organizeDeck(baseDeck, meta);
	assert.deepEqual(expandCards(d.asset).map((c) => c.code), ["01047", "01047", "01053"]);
});

test("expandedCounts: 各块张数", () => {
	const d = organizeDeck(baseDeck, meta);
	const c = expandedCounts(d);
	assert.equal(c["支援卡"], 3);
	assert.equal(c["永久支援卡"], 1);
	assert.equal(c["专属卡"], 1);
});

test("organizeDeck: taboo 命中 → 取图 code 加 -t", () => {
	const d = organizeDeck({ ...baseDeck, taboo_id: 5 }, meta, { tabooCodes: new Set(["01080"]) });
	assert.equal(d.tabooId, 5);
	assert.equal(d.event[0].code, "01080-t");
	assert.equal(d.event[0].baseCode, "01080");
	// 未命中 taboo 的卡不变
	assert.equal(d.skill[0].code, "01116");
});

test("organizeDeck: 无 taboo_id 时即使 tabooCodes 命中也不加 -t", () => {
	const d = organizeDeck(baseDeck, meta, { tabooCodes: new Set(["01080"]) });
	assert.equal(d.event[0].code, "01080");
});
