import { test } from "node:test";
import assert from "node:assert/strict";
import { stripMarkdownSyntax } from "../src/markdown.ts";

test("加粗 ** 与 __ 剥离", () => {
	assert.equal(stripMarkdownSyntax("**万事通** —— 事件卡"), "万事通 —— 事件卡");
	assert.equal(stripMarkdownSyntax("__加粗__ 普通文本"), "加粗 普通文本");
	assert.equal(stripMarkdownSyntax("**a**和**b** 相邻"), "a和b 相邻");
});

test("引用块每行行首 > 剥离", () => {
	assert.equal(
		stripMarkdownSyntax("> 快速。第一句。\n> 第二句。"),
		"快速。第一句。\n第二句。",
	);
	// 不带空格的 > 也兼容
	assert.equal(stripMarkdownSyntax(">无空格引用"), "无空格引用");
});

test("标题 # 前缀剥离（1~6 级）", () => {
	assert.equal(stripMarkdownSyntax("## 标题"), "标题");
	assert.equal(stripMarkdownSyntax("###### 六级"), "六级");
	assert.equal(stripMarkdownSyntax("#标题无空格保留"), "#标题无空格保留");
});

test("无序/有序列表标记剥离", () => {
	assert.equal(stripMarkdownSyntax("- 项目一\n- 项目二"), "项目一\n项目二");
	assert.equal(stripMarkdownSyntax("* 星号列表"), "星号列表");
	assert.equal(stripMarkdownSyntax("1. 第一\n2. 第二"), "第一\n第二");
});

test("围栏代码块保留正文去掉围栏", () => {
	const input = "```js\nconsole.log(1)\nconsole.log(2)\n```";
	assert.equal(stripMarkdownSyntax(input), "console.log(1)\nconsole.log(2)");
	// 代码块内的行内标记也会一并剥离（降级到纯文本时优先"无裸露符号"）
	assert.equal(stripMarkdownSyntax("```\n**不是加粗**\n```"), "不是加粗");
});

test("行内代码去掉反引号", () => {
	assert.equal(stripMarkdownSyntax("用 `msg_type` 字段"), "用 msg_type 字段");
});

test("链接与图片转纯文本", () => {
	assert.equal(stripMarkdownSyntax("见 [文档](https://x.com)"), "见 文档");
	assert.equal(stripMarkdownSyntax("![示意图](https://x.com/a.png)"), "示意图");
});

test("表格分隔行删除，数据行竖线换空格", () => {
	const input = "| 名称 | 费用 |\n|---|---:|\n| 万事通 | 0 |";
	assert.equal(stripMarkdownSyntax(input), "名称 费用\n万事通 0");
});

test("分割线删除", () => {
	assert.equal(stripMarkdownSyntax("上文\n\n---\n\n下文"), "上文\n\n下文");
	assert.equal(stripMarkdownSyntax("上文\n***\n下文"), "上文\n\n下文");
});

test("删除线与斜体剥离", () => {
	assert.equal(stripMarkdownSyntax("~~删除~~ 文本"), "删除 文本");
	assert.equal(stripMarkdownSyntax("这是 *斜体* 词"), "这是 斜体 词");
	// 下划线斜体不误伤标识符（中间含 _ 不匹配）
	assert.equal(stripMarkdownSyntax("card_001 不变"), "card_001 不变");
});

test("集成：用户报告的「万事通」消息剥离后无裸露符号", () => {
	const raw = [
		"@✸布谷鸟2号机 「万事通」做好了 ✅",
		"",
		"**万事通** —— 流浪者·2级事件卡，0费",
		"特性：局势、恩惠",
		"",
		"> 快速。只能在自己的回合打出。将自己手牌或者自己控制的一张非弱点卡牌从游戏中移除，查找并丢弃自己牌堆中一张和丢弃卡牌印刷费用相同的卡牌，然后从牌堆中查找并抽取一张与丢弃卡牌拥有相同类别（支援，事件，技能）的卡牌。",
		"",
		"用一张手牌换同费用的弃牌 + 同类型的检索抽牌，绿家赚资源又赚卡差的巧活。",
	].join("\n");

	const out = stripMarkdownSyntax(raw);
	// 不再裸露 markdown 语法符号
	assert.equal(out.includes("**"), false, "不应残留 **");
	assert.doesNotMatch(out, /\n>/, "不应残留行首引用 >");
	// 关键正文与 emoji、特殊字符保留
	assert.match(out, /万事通 —— 流浪者·2级事件卡，0费/);
	assert.match(out, /快速。只能在自己的回合打出/);
	assert.match(out, /✸布谷鸟2号机/);
	assert.match(out, /✅/);
});

test("纯文本（无 markdown）原样返回", () => {
	assert.equal(stripMarkdownSyntax("就是一句普通的话，没有任何符号。"), "就是一句普通的话，没有任何符号。");
});

test("多余空行收敛", () => {
	assert.equal(stripMarkdownSyntax("a\n\n\n\n\nb"), "a\n\nb");
});
