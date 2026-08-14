import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArkhamBuildShareId } from "../src/deck/fetch-deck.ts";

test("parseArkhamBuildShareId: 完整 URL", () => {
	assert.equal(parseArkhamBuildShareId("https://arkham.build/deck/view/EaXFKGBAR7i9hob"), "EaXFKGBAR7i9hob");
	assert.equal(parseArkhamBuildShareId("https://arkham.build/decklist/view/AbCdEfGhIjKlMnO"), "AbCdEfGhIjKlMnO");
	assert.equal(parseArkhamBuildShareId("arkham.build/deck/view/EaXFKGBAR7i9hob"), "EaXFKGBAR7i9hob");
});

test("parseArkhamBuildShareId: 裸 ID（需混合大小写，避免误吞纯数字 ArkhamDB id）", () => {
	assert.equal(parseArkhamBuildShareId("EaXFKGBAR7i9hob"), "EaXFKGBAR7i9hob");
	// 纯数字是 ArkhamDB id，不是 share id
	assert.equal(parseArkhamBuildShareId("4689495"), null);
	// 全小写/全大写短串不认（降低误判）
	assert.equal(parseArkhamBuildShareId("abcdefghijk"), null);
	// 无关 URL
	assert.equal(parseArkhamBuildShareId("https://arkhamdb.com/deck/view/123"), null);
});
