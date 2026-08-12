import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCard, hasCardErrors, formatCardErrors } from "../src/tools/validate-card.ts";

/** 取出指定 field 的 error 消息（便于断言）。 */
function errMsgsOf(issues: ReturnType<typeof validateCard>, field: string): string[] {
	return issues.filter((i) => i.field === field && i.severity === "error").map((i) => i.message);
}

test("合法的技能卡：0 error", () => {
	const issues = validateCard({
		type: "技能卡",
		name: "推理",
		class: "探求者",
		level: 0,
		traits: ["精通"],
		submit_icon: ["智力"],
		body: "如果调查一个地点时本技能检定成功，额外发现该地点的1个线索。",
		language: "zh",
	});
	assert.equal(hasCardErrors(issues), false, formatCardErrors(issues));
});

test("合法的支援卡（含 slots/health/horror）：0 error", () => {
	const issues = validateCard({
		type: "支援卡",
		name: "工具箱",
		class: "守护者",
		cost: 2,
		level: 1,
		traits: ["道具", "工具"],
		slots: "手部",
		health: 2,
		horror: 0,
		body: "➡️：获得1资源。",
		language: "zh",
	});
	assert.equal(hasCardErrors(issues), false, formatCardErrors(issues));
});

test("未知字段 icons（000.card 的真实错误）：拦截并提示 submit_icon", () => {
	const issues = validateCard({
		type: "事件卡",
		name: "做账",
		class: "流浪者",
		icons: ["📚", "📚"], // ← agent 自造的字段名
		traits: ["违法"],
		body: "获得6资源。",
		language: "zh",
	});
	const errs = errMsgsOf(issues, "icons");
	assert.ok(errs.length >= 1, "icons 应被报为未知字段");
	assert.match(errs[0], /未知字段/);
	// hint 应提示用 submit_icon
	const hint = issues.find((i) => i.field === "icons")?.hint ?? "";
	assert.match(hint, /submit_icon/);
});

test("submit_icon 用 emoji 📚：拦截并提示应为「智力」", () => {
	const issues = validateCard({
		type: "技能卡",
		name: "推理",
		class: "探求者",
		submit_icon: ["📚"],
		body: "调查。",
		language: "zh",
	});
	const errs = errMsgsOf(issues, "submit_icon[0]");
	assert.ok(errs.length >= 1);
	const hint = issues.find((i) => i.field === "submit_icon[0]")?.hint ?? "";
	assert.match(hint, /智力/);
});

test("submit_icon 用单字简称「书」：拦截", () => {
	const issues = validateCard({
		type: "技能卡", name: "x", class: "探求者", submit_icon: ["书"], body: "。", language: "zh",
	});
	assert.ok(errMsgsOf(issues, "submit_icon[0]").length >= 1);
});

test("traits 含「绑定（做账）」：拦截（疑似正文误填特性）", () => {
	const issues = validateCard({
		type: "诡计卡",
		name: "查税",
		class: "弱点",
		traits: ["契约", "绑定（做账）"], // ← 第二个是正文句子
		body: "【显现】 - 受到2点伤害。",
		language: "zh",
	});
	const errs = errMsgsOf(issues, "traits[1]");
	assert.ok(errs.length >= 1);
	assert.match(errs[0], /标点/);
});

test("正常特性（违法/契约）不误报", () => {
	const issues = validateCard({
		type: "事件卡", name: "x", class: "流浪者", traits: ["违法", "契约"], body: "。", language: "zh",
	});
	assert.equal(errMsgsOf(issues, "traits[0]").length, 0);
	assert.equal(errMsgsOf(issues, "traits[1]").length, 0);
});

test("body 含尖括号 XML 标签 <拳>：拦截", () => {
	const issues = validateCard({
		type: "事件卡", name: "x", class: "守护者", traits: [],
		body: "<拳>对一个敌人造成1点伤害。", // ← 应为 👊
		language: "zh",
	});
	const errs = errMsgsOf(issues, "body");
	assert.ok(errs.length >= 1);
	assert.match(errs[0], /尖括号/);
});

test("body 含 <t>武器</t>：拦截", () => {
	const issues = validateCard({
		type: "支援卡", name: "x", class: "守护者", cost: 1, traits: ["武器"],
		body: "<t>武器</t>。", language: "zh",
	});
	assert.ok(errMsgsOf(issues, "body").length >= 1);
});

test("「<调查员>」在 enemy_health 字段值里：不算 body 尖括号（不误拦）", () => {
	// 这是按调查员人数缩放的标记，不是被禁的 XML 标签
	const issues = validateCard({
		type: "敌人卡", name: "怪物", class: "遭遇", traits: ["异形"],
		attack: "3", evade: "4", enemy_health: "6<调查员>", damage: 1, // damage 是 enemy_damage 简写（非法字段，但这里只测 body 不误拦）
		body: "❤️", language: "zh",
	});
	assert.equal(errMsgsOf(issues, "body").length, 0, "enemy_health 的 <调查员> 不应触发 body 校验");
});

test("class 用「秘术家」：拦截（应为潜修者）", () => {
	const issues = validateCard({
		type: "事件卡", name: "x", class: "秘术家", traits: [], body: "。", language: "zh",
	});
	assert.ok(errMsgsOf(issues, "class").length >= 1);
});

test("缺 type / name：报必填错误", () => {
	const issues = validateCard({ traits: [], body: "。", language: "zh" });
	assert.ok(errMsgsOf(issues, "type").length >= 1);
	assert.ok(errMsgsOf(issues, "name").length >= 1);
});

test("cost 给字符串：报类型错误", () => {
	const issues = validateCard({
		type: "支援卡", name: "x", class: "守护者", cost: "2", traits: [], body: "。", language: "zh",
	} as Record<string, unknown>);
	assert.ok(errMsgsOf(issues, "cost").length >= 1);
});

test("health 给字符串、traits 给字符串：报类型错误", () => {
	const issues = validateCard({
		type: "支援卡", name: "x", class: "守护者", cost: 1,
		health: "3", traits: "道具", body: "。", language: "zh",
	} as Record<string, unknown>);
	assert.ok(errMsgsOf(issues, "health").length >= 1);
	assert.ok(errMsgsOf(issues, "traits").length >= 1);
});

test("非法 type / slots / location_icon：各自报错", () => {
	const issues = validateCard({
		type: "魔法卡", name: "x", class: "守护者", cost: 1, slots: "头部",
		location_icon: "紫色", traits: [], body: "。", language: "zh",
	});
	assert.ok(errMsgsOf(issues, "type").length >= 1);
	assert.ok(errMsgsOf(issues, "slots").length >= 1);
	assert.ok(errMsgsOf(issues, "location_icon").length >= 1);
});

test("formatCardErrors 只展示 error 不展示 warning，空 error 返回空串", () => {
	assert.equal(formatCardErrors([]), "");
	assert.equal(formatCardErrors([{ severity: "warning", message: "x" }]), "");
	const txt = formatCardErrors([{ severity: "error", field: "cost", message: "应为数字", hint: "填数字" }]);
	assert.match(txt, /卡牌校验未通过/);
	assert.match(txt, /\[cost\]/);
	assert.match(txt, /填数字/);
});

test("非对象输入：报错", () => {
	assert.ok(hasCardErrors(validateCard("不是对象")));
	assert.ok(hasCardErrors(validateCard(null)));
	assert.ok(hasCardErrors(validateCard([1, 2])));
});
