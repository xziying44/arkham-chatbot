import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createNonStreamStreamFn } from "../src/non-stream-bridge.ts";

const anthropicModel = {
	id: "deepseek-v4-flash",
	name: "deepseek-v4-flash",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.example.com/anthropic",
} as Model<"anthropic-messages">;

const openAIModel = {
	id: "deepseek-chat",
	name: "deepseek-chat",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.example.com/v1/",
} as Model<"openai-completions">;

const context = {
	systemPrompt: "测试系统提示词",
	messages: [{ role: "user", content: "你好", timestamp: 1 }],
	tools: [],
} as unknown as Context;

function unusedOriginal(onCall?: () => void): StreamFn {
	return (() => {
		onCall?.();
		return {} as AssistantMessageEventStream;
	}) as StreamFn;
}

async function collect(stream: AssistantMessageEventStream): Promise<Array<{ type: string }>> {
	const events: Array<{ type: string }> = [];
	for await (const event of stream) events.push(event as { type: string });
	return events;
}

test("Anthropic 兼容端点转换完整上下文并返回思考和文本", async (t) => {
	let originalCalls = 0;
	const richContext = {
		systemPrompt: "测试系统提示词",
		messages: [
			{ role: "user", content: [{ type: "text", text: "查一下" }], timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "需要调用工具" },
					{ type: "text", text: "正在查询" },
					{ type: "toolCall", id: "call-old", name: "lookup", arguments: { keyword: "天气" } },
				],
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-old",
				toolName: "lookup",
				content: [{ type: "text", text: "晴天" }],
				timestamp: 3,
			},
		],
		tools: [{
			name: "lookup",
			description: "查询信息",
			parameters: {
				type: "object",
				properties: { keyword: { type: "string" } },
				required: ["keyword"],
			},
		}],
	} as unknown as Context;

	t.mock.method(globalThis, "fetch", async (input, init) => {
		assert.equal(String(input), "https://api.example.com/anthropic/v1/messages");
		assert.equal(init?.method, "POST");
		assert.equal(new Headers(init?.headers).get("x-api-key"), "test-key");
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		assert.equal(body.model, "deepseek-v4-flash");
		assert.equal(body.max_tokens, 1024);
		assert.equal(body.temperature, 0.2);
		assert.deepEqual(body.thinking, { type: "disabled" });
		assert.ok(!("stream" in body));
		assert.deepEqual(body.messages, [
			{ role: "user", content: "查一下" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "需要调用工具" },
					{ type: "text", text: "正在查询" },
					{ type: "tool_use", id: "call-old", name: "lookup", input: { keyword: "天气" } },
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "call-old", content: "晴天" }],
			},
		]);
		assert.deepEqual(body.tools, [{
			name: "lookup",
			description: "查询信息",
			input_schema: {
				type: "object",
				properties: { keyword: { type: "string" } },
				required: ["keyword"],
			},
		}]);
		return Response.json({
			id: "response-1",
			model: "deepseek-v4-flash",
			content: [
				{ type: "thinking", thinking: "已经得到结果。" },
				{ type: "text", text: "今天是晴天。" },
			],
			stop_reason: "end_turn",
			usage: { input_tokens: 10, output_tokens: 5 },
		});
	});

	const fn = createNonStreamStreamFn(unusedOriginal(() => originalCalls++));
	const stream = fn(anthropicModel, richContext, {
		apiKey: "test-key",
		maxTokens: 1024,
		temperature: 0.2,
	});
	const resultPromise = stream.result();
	const events = await collect(stream);
	const result = await resultPromise;

	assert.equal(originalCalls, 0);
	assert.deepEqual(events.map((event) => event.type), [
		"start",
		"thinking_start",
		"thinking_delta",
		"thinking_end",
		"text_start",
		"text_delta",
		"text_end",
		"done",
	]);
	assert.deepEqual(result.content, [
		{ type: "thinking", thinking: "已经得到结果。" },
		{ type: "text", text: "今天是晴天。" },
	]);
	assert.equal(result.stopReason, "stop");
});

test("Anthropic 非流式工具调用保留完整参数", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({
		id: "response-2",
		model: "deepseek-v4-flash",
		content: [{ type: "tool_use", id: "call-1", name: "send_message", input: { text: "你好" } }],
		stop_reason: "tool_use",
		usage: { input_tokens: 12, output_tokens: 4 },
	}));

	const stream = createNonStreamStreamFn(unusedOriginal())(anthropicModel, context, { apiKey: "test-key" });
	const events = await collect(stream);
	const result = await stream.result();

	assert.deepEqual(events.map((event) => event.type), ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
	assert.deepEqual(result.content, [{
		type: "toolCall",
		id: "call-1",
		name: "send_message",
		arguments: { text: "你好" },
	}]);
	assert.equal(result.stopReason, "toolUse");
});

test("OpenAI 兼容端点转换完整上下文和响应事件", async (t) => {
	const richContext = {
		systemPrompt: "测试系统提示词",
		messages: [
			{ role: "user", content: [{ type: "text", text: "查一下" }], timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "需要调用工具" },
					{ type: "text", text: "正在查询" },
					{ type: "toolCall", id: "call-old", name: "lookup", arguments: { keyword: "天气" } },
				],
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-old",
				toolName: "lookup",
				content: [{ type: "text", text: "晴天" }],
				timestamp: 3,
			},
		],
		tools: [{
			name: "lookup",
			description: "查询信息",
			parameters: {
				type: "object",
				properties: { keyword: { type: "string" } },
				required: ["keyword"],
			},
		}],
	} as unknown as Context;

	t.mock.method(globalThis, "fetch", async (input, init) => {
		assert.equal(String(input), "https://api.example.com/v1/chat/completions");
		assert.equal(init?.method, "POST");
		assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
		assert.equal(new Headers(init?.headers).get("x-request-id"), "request-1");

		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		assert.equal(body.model, "deepseek-chat");
		assert.equal(body.max_tokens, 1024);
		assert.equal(body.temperature, 0.2);
		assert.deepEqual(body.thinking, { type: "disabled" });
		assert.ok(!("stream" in body));
		assert.deepEqual(body.messages, [
			{ role: "system", content: "测试系统提示词" },
			{ role: "user", content: "查一下" },
			{
				role: "assistant",
				content: "正在查询",
				tool_calls: [{
					id: "call-old",
					type: "function",
					function: { name: "lookup", arguments: '{"keyword":"天气"}' },
				}],
			},
			{ role: "tool", tool_call_id: "call-old", content: "晴天" },
		]);
		assert.deepEqual(body.tools, [{
			type: "function",
			function: {
				name: "lookup",
				description: "查询信息",
				parameters: {
					type: "object",
					properties: { keyword: { type: "string" } },
					required: ["keyword"],
				},
			},
		}]);

		return Response.json({
			id: "response-openai-1",
			model: "deepseek-chat",
			choices: [{
				finish_reason: "tool_calls",
				message: {
					role: "assistant",
					reasoning_content: "我需要继续查询。",
					content: "正在继续查询。",
					tool_calls: [{
						id: "call-new",
						type: "function",
						function: { name: "lookup", arguments: '{"keyword":"温度"}' },
					}],
				},
			}],
			usage: {
				prompt_tokens: 30,
				completion_tokens: 12,
				total_tokens: 42,
				prompt_tokens_details: { cached_tokens: 8 },
			},
		});
	});

	const stream = createNonStreamStreamFn(unusedOriginal())(openAIModel, richContext, {
		apiKey: "test-key",
		maxTokens: 1024,
		temperature: 0.2,
		headers: { "x-request-id": "request-1" },
	});
	const events = await collect(stream);
	const result = await stream.result();

	assert.deepEqual(events.map((event) => event.type), [
		"start",
		"thinking_start",
		"thinking_delta",
		"thinking_end",
		"text_start",
		"text_delta",
		"text_end",
		"toolcall_start",
		"toolcall_delta",
		"toolcall_end",
		"done",
	]);
	assert.deepEqual(result.content, [
		{ type: "thinking", thinking: "我需要继续查询。" },
		{ type: "text", text: "正在继续查询。" },
		{ type: "toolCall", id: "call-new", name: "lookup", arguments: { keyword: "温度" } },
	]);
	assert.equal(result.stopReason, "toolUse");
	assert.equal(result.usage.cacheRead, 8);
});

test("OpenAI 兼容端点在 5xx 后重试并恢复", async (t) => {
	let fetchCalls = 0;
	const realSetTimeout = globalThis.setTimeout;
	t.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, delay?: number) => {
		if (delay === 120_000) return 1 as unknown as NodeJS.Timeout;
		return realSetTimeout(callback, 0);
	}) as typeof setTimeout);
	t.mock.method(globalThis, "fetch", async () => {
		fetchCalls++;
		if (fetchCalls === 1) return Response.json({ error: "临时不可用" }, { status: 503 });
		return Response.json({
			id: "response-retry",
			model: "deepseek-chat",
			choices: [{
				finish_reason: "stop",
				message: { role: "assistant", content: "已恢复。" },
			}],
		});
	});

	const stream = createNonStreamStreamFn(unusedOriginal())(openAIModel, context, { apiKey: "test-key" });
	const events = await collect(stream);
	const result = await stream.result();

	assert.equal(fetchCalls, 2);
	assert.equal(events.at(-1)?.type, "done");
	assert.deepEqual(result.content, [{ type: "text", text: "已恢复。" }]);
});

test("响应未就绪时事件消费者会等待并在完成后恢复", async (t) => {
	let resolveFetch: ((response: Response) => void) | undefined;
	t.mock.method(globalThis, "fetch", async () => new Promise<Response>((resolve) => {
		resolveFetch = resolve;
	}));

	const stream = createNonStreamStreamFn(unusedOriginal())(anthropicModel, context, { apiKey: "test-key" });
	const eventsPromise = collect(stream);
	assert.ok(resolveFetch);
	resolveFetch(Response.json({
		id: "response-delayed",
		model: "deepseek-v4-flash",
		content: [{ type: "text", text: "延迟响应已完成。" }],
		stop_reason: "end_turn",
	}));

	const events = await eventsPromise;
	assert.deepEqual(events.map((event) => event.type), ["start", "text_start", "text_delta", "text_end", "done"]);
});

test("外部取消信号会中止 OpenAI 和 Anthropic 请求", async (t) => {
	const realSetTimeout = globalThis.setTimeout;
	t.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, delay?: number) => {
		if (delay === 120_000) return 1 as unknown as NodeJS.Timeout;
		return realSetTimeout(callback, 0);
	}) as typeof setTimeout);
	t.mock.method(globalThis, "fetch", async (_input, init) => new Promise<Response>((_resolve, reject) => {
		const signal = init?.signal;
		if (!signal) return reject(new Error("请求缺少取消信号"));
		if (signal.aborted) return reject(new Error("请求已取消"));
		signal.addEventListener("abort", () => reject(new Error("请求已取消")), { once: true });
	}));

	for (const model of [openAIModel, anthropicModel]) {
		const controller = new AbortController();
		const stream = createNonStreamStreamFn(unusedOriginal())(model, context, {
			apiKey: "test-key",
			signal: controller.signal,
		});
		controller.abort();
		const events = await collect(stream);
		const result = await stream.result();

		assert.deepEqual(events.map((event) => event.type), ["error"]);
		assert.equal(result.stopReason, "error");
	}
});

test("非成功响应产生 error 事件并结束结果流", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ error: "请求无效" }, { status: 400 }));

	const stream = createNonStreamStreamFn(unusedOriginal())(anthropicModel, context, { apiKey: "test-key" });
	const events = await collect(stream);
	const result = await stream.result();

	assert.deepEqual(events.map((event) => event.type), ["error"]);
	assert.equal(result.stopReason, "error");
});

test("其它 API 保持使用原始流函数", () => {
	const sentinel = {} as AssistantMessageEventStream;
	let receivedOptions: unknown;
	const original = ((_model: unknown, _context: unknown, options: unknown) => {
		receivedOptions = options;
		return sentinel;
	}) as StreamFn;
	const fn = createNonStreamStreamFn(original);
	const model = { api: "google-generative-ai" } as Model<any>;
	const options = { apiKey: "test-key" };

	assert.equal(fn(model, context, options), sentinel);
	assert.equal(receivedOptions, options);
});
