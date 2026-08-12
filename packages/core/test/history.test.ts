import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore } from "../src/session/history.ts";

/**
 * 加载时自愈：session.jsonl 里残留的「毒化」消息（坏 assistant / 孤立 toolResult / 悬空 user）
 * 必须被剔除，否则会让下一轮带着坏上下文继续失败、整个会话卡死。
 */
test("HistoryStore.load 剔除坏 assistant + 孤立 toolResult + 悬空 user", async () => {
	const dir = await mkdtemp(join(tmpdir(), "history-"));
	const poisoned = [
		// 好的起始 assistant
		{ role: "assistant", content: [{ type: "text", text: "你好呀" }], stopReason: "stop", timestamp: 1 },
		{ role: "user", content: "做张卡", timestamp: 2 },
		// 坏 assistant：stop=length, content=[]（DeepSeek 思考吃光 token 的空回复）
		{ role: "assistant", content: [], stopReason: "length", timestamp: 3 },
		{ role: "user", content: "再试", timestamp: 4 },
		// 坏 assistant：stop=error, 空文本
		{ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", timestamp: 5 },
		// 孤立 toolResult（其 toolCallId 不指向任何剩余 assistant）
		{ role: "toolResult", toolCallId: "orphan-1", toolName: "x", content: "y", timestamp: 6 },
	].map((m) => JSON.stringify(m)).join("\n");
	await writeFile(join(dir, "session.jsonl"), poisoned, "utf8");

	const loaded = await new HistoryStore(dir).load();
	// 只剩那条好的 assistant（坏的被删，user 因尾部悬空也被去掉，孤立 toolResult 删除）。
	assert.equal(loaded.length, 1);
	const only = loaded[0] as { role: string; content: Array<{ type: string; text: string }>; stopReason: string };
	assert.equal(only.role, "assistant");
	assert.equal(only.stopReason, "stop");
	assert.equal(only.content[0].text, "你好呀");
	await rm(dir, { recursive: true, force: true });
});

test("HistoryStore.load 对正常历史不改不删", async () => {
	const dir = await mkdtemp(join(tmpdir(), "history-"));
	// 合法交替序列，含并行 toolResult（两条 toolResult 紧跟同一个 assistant 的两个 toolCall）。
	const healthy = [
		{ role: "user", content: "查", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "f", arguments: {} }, { type: "toolCall", id: "c2", name: "g", arguments: {} }], stopReason: "toolUse", timestamp: 2 },
		{ role: "toolResult", toolCallId: "c1", toolName: "f", content: "r1", timestamp: 3 },
		{ role: "toolResult", toolCallId: "c2", toolName: "g", content: "r2", timestamp: 4 },
		{ role: "assistant", content: [{ type: "text", text: "结果" }], stopReason: "stop", timestamp: 5 },
	].map((m) => JSON.stringify(m)).join("\n");
	await writeFile(join(dir, "session.jsonl"), healthy, "utf8");

	const loaded = await new HistoryStore(dir).load();
	assert.equal(loaded.length, 5, "正常历史应原样保留");
	await rm(dir, { recursive: true, force: true });
});

test("HistoryStore.load 重建 dangling tool_use（tool_use 后缺 tool_result → 400 的根因）", async () => {
	const dir = await mkdtemp(join(tmpdir(), "history-"));
	// 复刻生产事故：assistant 发了 3 个 tool_call，后面跟的不是 tool_result 而是一条 user 消息。
	// Anthropic 端点会 400「tool_use ids found without tool_result blocks immediately after」。
	const dangling = [
		{ role: "user", content: "做卡", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "好" }], stopReason: "stop", timestamp: 2 },
		{ role: "user", content: "再来", timestamp: 3 },
		// 这个 assistant 发了 tool_call c1/c2，但后面没有对应 tool_result
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "f", arguments: {} }, { type: "toolCall", id: "c2", name: "g", arguments: {} }], stopReason: "toolUse", timestamp: 4 },
		// 直接是 user 而非 tool_result —— 违反格式
		{ role: "user", content: "复活吧", timestamp: 5 },
	].map((m) => JSON.stringify(m)).join("\n");
	await writeFile(join(dir, "session.jsonl"), dangling, "utf8");

	const loaded = await new HistoryStore(dir).load();
	const roles = loaded.map((m: { role: string }) => m.role);
	// dangling 的 tool_use assistant 必须被丢弃，连同它后面的 user「复活吧」也成悬空被去掉。
	// 最终干净地停在第一条文本 assistant「好」。
	assert.deepEqual(roles, ["user", "assistant"]);
	assert.equal((loaded[loaded.length - 1] as { content: Array<{ text: string }> }).content[0].text, "好");
	await rm(dir, { recursive: true, force: true });
});
