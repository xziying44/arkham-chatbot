import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, OutgoingMessage, ScopeKey } from "@arkham/chatbot-core";
import type { ImEvent, StreamSink, OpenStreamOptions } from "@arkham/chatbot-im-core";
import { createMessageRouter } from "../src/message-router.ts";

/** 最小可用的 scope key 工厂。 */
const userScope = (id: string): ScopeKey => ({ kind: "user", id });
const groupScope = (id: string): ScopeKey => ({ kind: "group", id });

/** Mock adapter：记录所有调用，openStream/sendText 可注入行为。 */
interface MockAdapterOpts {
	/** openStream 实现；返回 undefined 表示不支持/失败（触发降级）。 */
	openStream?: (scope: ScopeKey, opts: OpenStreamOptions) => Promise<StreamSink | undefined>;
}
interface MockAdapterCalls {
	sendTextCalls: Array<{ scope: ScopeKey; text: string; replyToMessageId?: string }>;
	openStreamCalls: Array<{ scope: ScopeKey; opts: OpenStreamOptions }>;
	sinkDeltas: string[];
	sinkFinished: boolean;
}
function createMockAdapter(opts: MockAdapterOpts): {
	adapter: any;
	calls: MockAdapterCalls;
} {
	const calls: MockAdapterCalls = {
		sendTextCalls: [],
		openStreamCalls: [],
		sinkDeltas: [],
		sinkFinished: false,
	};
	const sink: StreamSink | undefined = opts.openStream
		? {
				onDelta: async (delta: string) => { calls.sinkDeltas.push(delta); },
				finish: async () => { calls.sinkFinished = true; },
			}
		: undefined;
	const adapter = {
		sendText: async (scope: ScopeKey, text: string, replyToMessageId?: string) => {
			calls.sendTextCalls.push({ scope, text, replyToMessageId });
		},
		openStream: opts.openStream
			? async (scope: ScopeKey, o: OpenStreamOptions) => {
					calls.openStreamCalls.push({ scope, opts: o });
					return opts.openStream!(scope, o);
				}
			: undefined,
		replyInteraction: async () => {},
		subscribe: () => () => {},
		connect: async () => {},
		disconnect: async () => {},
		isConnected: true,
		[Symbol.asyncDispose]: async () => {},
	};
	// 让默认 openStream 返回内部 sink，方便断言 sinkDeltas/sinkFinished
	if (opts.openStream === undefined) {
		// 不支持流式：openStream 保持 undefined
	} else if (sink) {
		// 已注入自定义实现，sink 用于断言由调用方决定
	}
	return { adapter, calls };
}

/** Mock SessionManager：dispatch 时调用注入的 onText 模拟 agent 文字增量。 */
interface MockSessionsOpts {
	/** 在 resolve 前调用的回调（拿到 onText 后用它发 delta）。 */
	emitDeltas?: (onText: (delta: string) => void) => void;
	/** dispatch 返回的 OutgoingMessage。 */
	reply?: OutgoingMessage;
	/** dispatch 抛出的错误（优先于 reply）。 */
	throwError?: Error;
}
function createMockSessions(opts: MockSessionsOpts): any {
	return {
		dispatch: async (
			_message: IncomingMessage,
			dispatchOpts?: { onText?: (delta: string) => void },
		): Promise<OutgoingMessage> => {
			// 先发 delta（模拟 agent 跑了一半产出文字），再决定抛错或返回。
			// 真实场景：runPrompt 中途异常前可能已经流过若干轮思考。
			if (opts.emitDeltas && dispatchOpts?.onText) {
				opts.emitDeltas(dispatchOpts.onText);
			}
			if (opts.throwError) throw opts.throwError;
			return opts.reply ?? { text: "" };
		},
		dispatchInteraction: () => {},
	};
}

function makeMessageEvent(scope: ScopeKey, text: string): ImEvent {
	return {
		type: "message",
		scope,
		text,
		senderId: "sender-1",
		senderName: "sender-1",
		mentioned: scope.kind === "group",
		platformMessageId: "msg-id-1",
	} as ImEvent;
}

// 等一个 setTimeout 节流周期 + 微任务，确保 router 内的节流 flush 触发。
function waitForThrottle(ms = 200): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("C2C 流式：deltas 流到 sink，send_message 触发后只收尾不发 sendText", async () => {
	const { adapter, calls } = createMockAdapter({
		openStream: async () => ({
			onDelta: async (d) => calls.sinkDeltas.push(d),
			finish: async () => { calls.sinkFinished = true; },
		}),
	});
	const sessions = createMockSessions({
		emitDeltas: (onText) => {
			onText("让我想想…");
			onText("找到了。");
		},
		// reply.text 空 = agent 用 send_message 发了主回复
		reply: { text: "", replyToMessageId: "msg-id-1" },
	});
	const router = createMessageRouter({
		adapter, sessions, botId: "bot-1", c2cStreaming: true,
	});

	await router(makeMessageEvent(userScope("u-1"), "你好"));
	await waitForThrottle();

	// openStream 被调用（C2C + flag 开）
	assert.equal(calls.openStreamCalls.length, 1);
	assert.equal(calls.openStreamCalls[0].opts.firstContent, "💭 ");
	assert.equal(calls.openStreamCalls[0].opts.contentType, "text");
	assert.equal(calls.openStreamCalls[0].opts.msgId, "msg-id-1");
	// 两个 delta 都到 sink（首段无换行前缀，第二段前加 \n>）
	assert.ok(calls.sinkDeltas.length >= 1);
	assert.ok(calls.sinkDeltas.join("").includes("让我想想"));
	assert.ok(calls.sinkDeltas.join("").includes("找到了"));
	// 末片收尾被调用
	assert.equal(calls.sinkFinished, true);
	// reply.text 空 → 不调 sendText（主回复由 send_message 发）
	assert.equal(calls.sendTextCalls.length, 0);
});

test("C2C 流式：agent 没调 send_message（reply.text 非空）→ 引用块收尾 + 回复作为新消息独立发送", async () => {
	const { adapter, calls } = createMockAdapter({
		openStream: async () => ({
			onDelta: async (d) => calls.sinkDeltas.push(d),
			finish: async () => { calls.sinkFinished = true; },
		}),
	});
	const sessions = createMockSessions({
		emitDeltas: (onText) => { onText("思考中…"); },
		// reply.text 非空 = agent 没用 send_message，router 兜底发回复
		reply: { text: "这是答案。" },
	});
	const router = createMessageRouter({
		adapter, sessions, botId: "bot-1", c2cStreaming: true,
	});

	await router(makeMessageEvent(userScope("u-1"), "问题"));
	await waitForThrottle();

	// 思考在引用块里（deltas 含「思考中」），引用块收尾
	assert.ok(calls.sinkDeltas.some((d) => d.includes("思考中")));
	assert.equal(calls.sinkFinished, true);
	// 回复作为独立新消息发送（不 append 进引用块）
	assert.equal(calls.sendTextCalls.length, 1);
	assert.equal(calls.sendTextCalls[0].text, "这是答案。");
});

test("群聊不开启流式：走 sendText 批量发送", async () => {
	const { adapter, calls } = createMockAdapter({
		openStream: async () => ({ onDelta: async () => {}, finish: async () => {} }),
	});
	const sessions = createMockSessions({ reply: { text: "群聊回复" } });
	const router = createMessageRouter({
		adapter, sessions, botId: "bot-1", c2cStreaming: true,
	});

	await router(makeMessageEvent(groupScope("g-1"), "@bot 你好"));

	// 群聊：openStream 不应被调用
	assert.equal(calls.openStreamCalls.length, 0);
	// 走 sendText
	assert.equal(calls.sendTextCalls.length, 1);
	assert.equal(calls.sendTextCalls[0].text, "群聊回复");
});

test("c2cStreaming=false 时即便 C2C 也不开流式", async () => {
	const { adapter, calls } = createMockAdapter({
		openStream: async () => ({ onDelta: async () => {}, finish: async () => {} }),
	});
	const sessions = createMockSessions({
		emitDeltas: (onText) => { onText("delta"); },
		reply: { text: "回复" },
	});
	const router = createMessageRouter({
		adapter, sessions, botId: "bot-1", c2cStreaming: false,
	});

	await router(makeMessageEvent(userScope("u-1"), "hi"));

	assert.equal(calls.openStreamCalls.length, 0);
	assert.equal(calls.sendTextCalls.length, 1);
});

test("openStream 失败 → 降级到 sendText", async () => {
	const { adapter, calls } = createMockAdapter({
		// 模拟 openStream 抛错
		openStream: async () => { throw new Error("stream_messages 限流"); },
	});
	const sessions = createMockSessions({
		emitDeltas: (onText) => { onText("delta"); },
		reply: { text: "答案" },
	});
	const router = createMessageRouter({
		adapter, sessions, botId: "bot-1", c2cStreaming: true,
	});

	await router(makeMessageEvent(userScope("u-1"), "问"));
	await waitForThrottle();

	// openStream 被尝试但失败
	assert.equal(calls.openStreamCalls.length, 1);
	// 降级到 sendText（reply.text 完整送达）
	assert.equal(calls.sendTextCalls.length, 1);
	assert.equal(calls.sendTextCalls[0].text, "答案");
});

test("无 deltas 的 C2C 消息：不开启流式，直接走批量兜底", async () => {
	const { adapter, calls } = createMockAdapter({
		openStream: async () => ({ onDelta: async () => {}, finish: async () => {} }),
	});
	// emitDeltas 不发任何 delta
	const sessions = createMockSessions({ reply: { text: "简短回复" } });
	const router = createMessageRouter({
		adapter, sessions, botId: "bot-1", c2cStreaming: true,
	});

	await router(makeMessageEvent(userScope("u-1"), "嗨"));

	// 没有 delta → openStream 不开（懒开启）
	assert.equal(calls.openStreamCalls.length, 0);
	// reply.text 非空 → 走 sendText
	assert.equal(calls.sendTextCalls.length, 1);
});

test("dispatch 抛错：已开流式时收尾，再走错误兜底回复", async () => {
	const { adapter, calls } = createMockAdapter({
		openStream: async () => ({
			onDelta: async (d) => calls.sinkDeltas.push(d),
			finish: async () => { calls.sinkFinished = true; },
		}),
	});
	const sessions = createMockSessions({
		emitDeltas: (onText) => { onText("正在处理…"); },
		throwError: new Error("LLM 端点挂了"),
	});
	const router = createMessageRouter({
		adapter, sessions, botId: "bot-1", c2cStreaming: true,
	});

	await router(makeMessageEvent(userScope("u-1"), "复杂请求"));
	await waitForThrottle();

	// 错误前已开流式 → 收尾
	assert.equal(calls.sinkFinished, true);
	// 错误兜底回复
	assert.equal(calls.sendTextCalls.length, 1);
	assert.match(calls.sendTextCalls[0].text, /出了点问题/);
});
