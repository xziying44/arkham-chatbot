import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { groupTarget, QQClient, userTarget } from "../src/client.ts";

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

function createClient(): QQClient {
	return new QQClient({ appId: "app-id", appSecret: "app-secret", apiBase: "https://api.example.com" });
}

test("字符串 expires_in 会按秒计算，并在到期前刷新", async (t) => {
	let nowMs = 1_800_000_000_000;
	let tokenCalls = 0;
	t.mock.method(Date, "now", () => nowMs);
	t.mock.method(globalThis, "fetch", async (input) => {
		assert.equal(String(input), TOKEN_URL);
		tokenCalls++;
		return Response.json({ access_token: `token-${tokenCalls}`, expires_in: "7200" });
	});

	const client = createClient();
	assert.equal(await client.getAccessToken(), "token-1");
	assert.equal(client.tokenExpiresAt, Math.floor(nowMs / 1000) + 7200);

	nowMs += 7100 * 1000;
	assert.equal(await client.getAccessToken(), "token-1");
	nowMs += 41 * 1000;
	assert.equal(await client.getAccessToken(), "token-2");
	assert.equal(tokenCalls, 2);
});

test("并发获取令牌只会发起一次刷新请求", async (t) => {
	let tokenCalls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		tokenCalls++;
		return Response.json({ access_token: "shared-token", expires_in: "7200" });
	});

	const client = createClient();
	const tokens = await Promise.all([client.getAccessToken(), client.getAccessToken(), client.getAccessToken()]);
	assert.deepEqual(tokens, ["shared-token", "shared-token", "shared-token"]);
	assert.equal(tokenCalls, 1);
});

test("服务端返回 11244 时刷新令牌并重试一次", async (t) => {
	let tokenCalls = 0;
	let gatewayCalls = 0;
	const authorizations: string[] = [];
	t.mock.method(globalThis, "fetch", async (input, init) => {
		if (String(input) === TOKEN_URL) {
			tokenCalls++;
			return Response.json({ access_token: tokenCalls === 1 ? "stale-token" : "fresh-token", expires_in: "7200" });
		}

		gatewayCalls++;
		authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
		if (gatewayCalls === 1) {
			return Response.json({ message: "token not exist or expire", code: 11244, err_code: 11244 }, { status: 500 });
		}
		return Response.json({
			url: "wss://gateway.example.com",
			shards: 1,
			session_start_limit: { total: 100, remaining: 99, reset_after: 0, max_concurrency: 1 },
		});
	});

	const gateway = await createClient().getGateway();
	assert.equal(gateway.url, "wss://gateway.example.com");
	assert.deepEqual(authorizations, ["QQBot stale-token", "QQBot fresh-token"]);
	assert.equal(tokenCalls, 2);
	assert.equal(gatewayCalls, 2);
});

test("非令牌错误不会触发刷新重试", async (t) => {
	let tokenCalls = 0;
	let gatewayCalls = 0;
	t.mock.method(globalThis, "fetch", async (input) => {
		if (String(input) === TOKEN_URL) {
			tokenCalls++;
			return Response.json({ access_token: "valid-token", expires_in: "7200" });
		}
		gatewayCalls++;
		return Response.json({ message: "接口调用超过频率限制", code: 100017 }, { status: 429 });
	});

	await assert.rejects(createClient().getGateway(), /getGateway failed: 429/);
	assert.equal(tokenCalls, 1);
	assert.equal(gatewayCalls, 1);
});

test("无效 expires_in 会被拒绝且不会缓存令牌", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ access_token: "token", expires_in: "invalid" }));
	const client = createClient();

	await assert.rejects(client.getAccessToken(), /有效期无效/);
	assert.equal(client.tokenExpiresAt, 0);
});

test("消息、交互、上传和附件下载公共接口使用统一鉴权", async (t) => {
	const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
	t.mock.method(globalThis, "fetch", async (input, init) => {
		const url = String(input);
		if (url === TOKEN_URL) return Response.json({ access_token: "valid-token", expires_in: "7200" });
		if (url === "https://media.example.com/image") return new Response(Buffer.from([1, 2, 3]));

		const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
		requests.push({ url, method: init?.method ?? "GET", body });
		assert.equal(new Headers(init?.headers).get("Authorization"), "QQBot valid-token");
		if (url.endsWith("/files")) return Response.json({ file_info: "file-info", ttl: 300 });
		if (url.includes("/interactions/")) return new Response(null, { status: 204 });
		return Response.json({ id: `message-${requests.length}`, timestamp: 123 });
	});

	const group = groupTarget("group-id");
	const user = userTarget("user-id");
	assert.deepEqual(group, { kind: "group", openid: "group-id", path: "/v2/groups/group-id" });
	assert.deepEqual(user, { kind: "user", openid: "user-id", path: "/v2/users/user-id" });

	const client = createClient();
	assert.equal(client.appId, "app-id");
	await client.sendMarkdown(group, "**内容**", "message-id");
	await client.sendText(user, "文本", "message-id");
	await client.sendKeyboard(group, "选择", { content: { rows: [] } }, "message-id");
	assert.equal(await client.uploadFile(group, 1, "base64-data"), "file-info");
	await client.sendMedia(group, "file-info", "message-id");
	await client.sendImageBase64(user, "base64-data", "message-id");
	await client.replyInteraction("interaction-id");
	assert.deepEqual(await client.downloadAttachment("https://media.example.com/image"), Buffer.from([1, 2, 3]));

	assert.equal(client.sentCount, 5);
	assert.equal(requests.filter((request) => request.url.endsWith("/messages")).length, 5);
	assert.equal(requests.filter((request) => request.url.endsWith("/files")).length, 2);
	assert.equal(requests.at(-1)?.method, "PUT");
	assert.equal(requests[0]?.body?.msg_seq, 1);
});

test("附件匿名下载失败后会携带令牌重试", async (t) => {
	let attachmentCalls = 0;
	t.mock.method(globalThis, "fetch", async (input, init) => {
		if (String(input) === TOKEN_URL) return Response.json({ access_token: "download-token", expires_in: 7200 });
		attachmentCalls++;
		if (attachmentCalls === 1) return new Response("forbidden", { status: 403 });
		assert.equal(new Headers(init?.headers).get("Authorization"), "QQBot download-token");
		return new Response(Buffer.from([4, 5, 6]));
	});

	const data = await createClient().downloadAttachment("https://media.example.com/protected");
	assert.deepEqual(data, Buffer.from([4, 5, 6]));
	assert.equal(attachmentCalls, 2);
});

test("令牌端点错误和缺失令牌会返回明确错误", async (t) => {
	let tokenCalls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		tokenCalls++;
		if (tokenCalls === 1) return new Response("服务不可用", { status: 503 });
		return Response.json({ access_token: "", expires_in: "7200" });
	});

	await assert.rejects(createClient().getAccessToken(), /getAppAccessToken failed: 503/);
	await assert.rejects(createClient().getAccessToken(), /缺少有效令牌/);
});

// ---- stream_messages（C2C 流式）----

/** 记录所有 stream_messages 请求并按序返回响应的 mock fetch。 */
function mockStreamFetch(t: TestContext, slices: Array<{ id: string; remain?: number }>): {
	requests: Array<{ url: string; body: Record<string, unknown> }>;
} {
	const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
	let sliceIdx = 0;
	t.mock.method(globalThis, "fetch", async (input, init) => {
		const url = String(input);
		if (url === TOKEN_URL) return Response.json({ access_token: "valid-token", expires_in: "7200" });
		const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
		requests.push({ url, body });
		if (url.endsWith("/stream_messages")) {
			const slice = slices[Math.min(sliceIdx, slices.length - 1)];
			sliceIdx++;
			return Response.json({ id: slice.id, timestamp: "2026-08-12T10:00:00+08:00", remain_msg_len: slice.remain ?? 3800 });
		}
		return Response.json({ id: "msg-x", timestamp: 123 });
	});
	return { requests };
}

test("startStream 在 user scope 发首片并返回 StreamSession", async (t) => {
	const { requests } = mockStreamFetch(t, [{ id: "stream-id-1" }]);
	const client = createClient();
	const session = await client.startStream(userTarget("user-id"), {
		msgId: "msg-1",
		contentType: "markdown",
		firstContent: "> 💭 ",
	});

	assert.equal(requests.length, 1);
	const first = requests[0];
	assert.equal(first.url, "https://api.example.com/v2/users/user-id/stream_messages");
	assert.equal(first.body.index, 0);
	assert.equal(first.body.input_state, 1);
	assert.equal(first.body.input_mode, "append");
	assert.equal(first.body.content_type, "markdown");
	assert.equal(first.body.content_raw, "> 💭 ");
	assert.equal(first.body.msg_id, "msg-1");
	assert.equal(first.body.stream_msg_id, undefined);
	// msg_seq 自增
	assert.equal(first.body.msg_seq, 1);
	// 返回的 session 已携带首片返回的 stream_msg_id
	void session;
});

test("startStream 在 group scope 抛错（防御）", async (t) => {
	t.mock.method(globalThis, "fetch", async (input) => {
		if (String(input) === TOKEN_URL) return Response.json({ access_token: "t", expires_in: "7200" });
		return Response.json({});
	});
	const client = createClient();
	await assert.rejects(
		client.startStream(groupTarget("g"), { msgId: "m" }),
		/仅支持 C2C/,
	);
});

test("StreamSession.append 递增 index 并携带 stream_msg_id + content_type + msg_id（真机压测确认续片必带 msg_id）", async (t) => {
	const { requests } = mockStreamFetch(t, [{ id: "stream-1" }, { id: "stream-1" }, { id: "stream-1" }]);
	const client = createClient();
	const session = await client.startStream(userTarget("u"), { msgId: "msg-x", firstContent: "> 💭 " });
	await session.append("第一段思考");
	await session.append("第二段思考");

	// 0=首片，1/2=两次 append
	assert.equal(requests.length, 3);
	const a1 = requests[1];
	const a2 = requests[2];
	assert.equal(a1.body.index, 1);
	assert.equal(a1.body.input_state, 1);
	assert.equal(a1.body.input_mode, "append");
	assert.equal(a1.body.content_raw, "第一段思考");
	assert.equal(a1.body.stream_msg_id, "stream-1");
	// 续片必带 content_type + msg_id（缺 msg_id → 服务端 50001）
	assert.equal(a1.body.content_type, "markdown");
	assert.equal(a1.body.msg_id, "msg-x");
	assert.equal(a2.body.index, 2);
	assert.equal(a2.body.content_raw, "第二段思考");
});

test("StreamSession.finish 发末片（input_state=10，空正文）", async (t) => {
	const { requests } = mockStreamFetch(t, [{ id: "s1" }, { id: "s1" }]);
	const client = createClient();
	const session = await client.startStream(userTarget("u"), { firstContent: "> 💭 " });
	await session.finish();

	// 末片是第 2 个请求
	assert.equal(requests.length, 2);
	const last = requests[1];
	assert.equal(last.body.input_state, 10);
	assert.equal(last.body.input_mode, "append");
	assert.equal(last.body.content_raw, "");
	assert.equal(last.body.stream_msg_id, "s1");
});

test("StreamSession.finish 幂等：多次调用只发一次末片", async (t) => {
	const { requests } = mockStreamFetch(t, [{ id: "s1" }, { id: "s1" }]);
	const client = createClient();
	const session = await client.startStream(userTarget("u"), { firstContent: "> 💭 " });
	await session.finish();
	await session.finish();
	await session.finish();
	// 只有首片 + 一次末片
	assert.equal(requests.length, 2);
});

test("StreamSession.append 失败后停止后续流式（标记结束）", async (t) => {
	let sliceIdx = 0;
	t.mock.method(globalThis, "fetch", async (input) => {
		const url = String(input);
		if (url === TOKEN_URL) return Response.json({ access_token: "t", expires_in: "7200" });
		sliceIdx++;
		if (sliceIdx === 2) {
			// 第二片（第一个 append）失败
			return new Response("限流", { status: 429 });
		}
		return Response.json({ id: "s1", timestamp: "t" });
	});
	const client = createClient();
	const session = await client.startStream(userTarget("u"), { firstContent: "> 💭 " });
	// 第一次 append 失败
	await session.append("第一段");
	// 第二次 append 应该是 no-op（已标记结束）
	const result = await session.append("第二段");
	assert.equal(result, undefined);
});

test("StreamSession 服务端返回新 stream_msg_id 会更新（容错）", async (t) => {
	const { requests } = mockStreamFetch(t, [{ id: "first-id" }, { id: "updated-id" }, { id: "updated-id" }]);
	const client = createClient();
	const session = await client.startStream(userTarget("u"), { firstContent: "> 💭 " });
	// 第二次响应返回了新 id，后续请求应该用新 id
	await session.append("delta1");
	await session.append("delta2");
	assert.equal(requests[2].body.stream_msg_id, "updated-id");
});
