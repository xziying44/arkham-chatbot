import { test } from "node:test";
import assert from "node:assert/strict";
import { QQAdapter } from "../src/adapter.ts";

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

function makeAdapter(): QQAdapter {
	return new QQAdapter({ appId: "app-id", appSecret: "app-secret", apiBase: "https://api.example.com" });
}

test("sendMarkdown 失败时降级为剥离后的纯文本（不裸露 markdown 符号）", async (t) => {
	const messages: Array<{ body: Record<string, unknown> }> = [];
	t.mock.method(globalThis, "fetch", async (input, init) => {
		if (String(input) === TOKEN_URL) {
			return Response.json({ access_token: "valid-token", expires_in: "7200" });
		}
		if (String(input).endsWith("/messages")) {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			messages.push({ body });
			// 第一次 sendMarkdown（msg_type=2）失败：模拟 QQ 拒绝含不支持语法的 markdown
			if (body.msg_type === 2) {
				return Response.json({ code: 40034011, message: "markdown not supported" }, { status: 400 });
			}
			// 第二次 sendText（msg_type=0）成功
			return Response.json({ id: "msg-id", timestamp: 123 });
		}
		return new Response(null, { status: 404 });
	});

	const adapter = makeAdapter();
	await adapter.sendText(
		{ kind: "user", id: "u1" },
		"**万事通** —— 事件卡\n\n> 快速。只能在自己的回合打出。",
		"reply-msg-id",
	);

	// 第一次是 markdown（失败），第二次是降级纯文本
	assert.equal(messages.length, 2);
	assert.equal(messages[0].body.msg_type, 2);
	assert.equal(messages[1].body.msg_type, 0);

	const plainContent = String(messages[1].body.content);
	// 降级后的纯文本不再裸露 markdown 符号
	assert.equal(plainContent.includes("**"), false, "降级纯文本不应残留 **");
	assert.doesNotMatch(plainContent, /\n>/, "降级纯文本不应残留行首引用 >");
	// 关键正文保留
	assert.match(plainContent, /万事通 —— 事件卡/);
	assert.match(plainContent, /快速。只能在自己的回合打出/);
});

test("sendMarkdown 成功时不降级，仅发一次 msg_type=2", async (t) => {
	const messages: Array<{ msg_type: unknown }> = [];
	t.mock.method(globalThis, "fetch", async (input, init) => {
		if (String(input) === TOKEN_URL) return Response.json({ access_token: "valid-token", expires_in: "7200" });
		if (String(input).endsWith("/messages")) {
			messages.push({ msg_type: JSON.parse(String(init?.body)).msg_type });
			return Response.json({ id: "m", timestamp: 1 });
		}
		return new Response(null, { status: 404 });
	});

	const adapter = makeAdapter();
	await adapter.sendText({ kind: "user", id: "u1" }, "**正常 markdown**", "r");

	assert.equal(messages.length, 1);
	assert.equal(messages[0].msg_type, 2);
});
