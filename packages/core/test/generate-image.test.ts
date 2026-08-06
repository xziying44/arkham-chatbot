import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArtPrompt, typeDefaults } from "../src/tools/generate-image.ts";

/**
 * 提示词模板规则来自《诡镇奇谭卡牌插画 · MiniMax 生图方案 v1.0》§3/§5。
 * 这些断言锁住经过 6 轮实机校验的结论，防回归。
 */

test("通用前缀与尾约束：所有类型共享", () => {
	for (const type of ["character", "scene", "monster", "item"] as const) {
		const p = buildArtPrompt(type, "测试描述");
		assert.match(p, /^欧美写实油画，诡镇奇谭卡牌插画风格/);
		assert.match(p, /非动漫非卡通非二次元/);
		assert.match(p, /：测试描述，画面中不出现任何文字、字母、水印、边框$/);
	}
});

test("人物：伦勃朗光 + 油画布纹理，默认 3:4，关 optimizer", () => {
	const p = buildArtPrompt("character", "中年女调查员，手提煤油灯");
	assert.match(p, /伦勃朗式明暗用光/);
	assert.match(p, /粗糙油画布纹理/);
	assert.match(p, /1920年代美国复古设定/);
	const d = typeDefaults("character");
	assert.equal(d.ratio, "3:4");
	// 方案 §5：人物类必须关 prompt_optimizer（跑偏动漫脸主因）。
	assert.equal(d.optimize, false);
});

test("场景：默认 4:3，开 optimizer，电影感构图", () => {
	const p = buildArtPrompt("scene", "雾中街道，煤气灯昏黄");
	assert.match(p, /电影感构图/);
	const d = typeDefaults("scene");
	assert.equal(d.ratio, "4:3");
	assert.equal(d.optimize, true);
});

test("怪物：去掉 1920s 时代词，强调写实生物质感，开 optimizer", () => {
	const p = buildArtPrompt("monster", "巨大触手怪物从漆黑海面升起");
	assert.match(p, /写实生物质感/);
	// 方案 §3.2：怪物模板不含 1920s 时代词。
	assert.ok(!p.includes("1920年代"), "怪物提示词不应包含时代设定词");
	assert.equal(typeDefaults("monster").optimize, true);
});

test("物品：静物特写 + 深色背景 + 顶部聚光，默认 1:1", () => {
	const p = buildArtPrompt("item", "一把黄铜左轮手枪");
	assert.match(p, /静物特写，深色背景，顶部聚光/);
	assert.equal(typeDefaults("item").ratio, "1:1");
});

test("用户描述首尾空白被清理", () => {
	const p = buildArtPrompt("scene", "  雾中街道  ");
	assert.match(p, /：雾中街道，画面中/);
});
