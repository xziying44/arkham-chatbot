import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/**
 * 非流式 streamFn 适配器。
 *
 * 某些 OpenAI 兼容端点（如 opencode.ai）在流式模式下有 bug：
 * 推理模型只输出 reasoning_content 而不输出 content 就结束。
 * 但非流式模式正常（content 和 tool_calls 都完整返回）。
 *
 * 这个桥接器用原生 fetch 发非流式请求，把完整响应转换成
 * pi-ai 的 AssistantMessageEventStream 事件序列。Agent 感知到的是
 * "流式"事件流，但实际是一次性 HTTP 请求。
 */

/**
 * 创建一个非流式的 streamFn。
 * 只对 openai-completions API 用非流式；其它 API 走原始 streamFn。
 */
export function createNonStreamStreamFn(originalStreamFn: StreamFn): StreamFn {
	return (model, context, options) => {
		if (model.api !== "openai-completions") {
			return originalStreamFn(model, context, options);
		}
		return nonStreamOpenAI(model as Model<"openai-completions">, context, options as Record<string, unknown> | undefined);
	};
}

/**
 * Agent loop 需要的 stream 接口：AsyncIterable<event> + .result() → Promise<AssistantMessage>
 */
interface SimpleEventStream {
	push(event: unknown): void;
	result(): Promise<AssistantMessage>;
	[Symbol.asyncIterator](): AsyncIterator<unknown>;
}

function createEventStream(): SimpleEventStream & AssistantMessageEventStream {
	const queue: unknown[] = [];
	let waiting: ((r: IteratorResult<unknown>) => void) | null = null;
	let done = false;
	let finalResolve: ((r: AssistantMessage) => void) | null = null;
	let finalMessage: AssistantMessage | undefined;

	const push = (event: unknown) => {
		const e = event as { type: string; message?: AssistantMessage };
		if (e.type === "done") {
			if (e.message) finalMessage = e.message;
			done = true;
		}
		if (waiting) {
			const w = waiting;
			waiting = null;
			w({ value: event, done: false });
		} else {
			queue.push(event);
		}
		if (finalResolve && finalMessage) finalResolve(finalMessage);
	};

	return {
		push,
		result: () =>
			new Promise<AssistantMessage>((resolve) => {
				if (finalMessage) return resolve(finalMessage);
				finalResolve = resolve;
			}),
		[Symbol.asyncIterator]() {
			return {
				next(): Promise<IteratorResult<unknown>> {
					if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
					if (done) return Promise.resolve({ value: undefined, done: true });
					return new Promise((resolve) => { waiting = resolve; });
				},
			};
		},
	} as SimpleEventStream & AssistantMessageEventStream;
}

/**
 * 用 fetch 发非流式 OpenAI Chat Completions 请求。
 */
function nonStreamOpenAI(
	model: Model<"openai-completions">,
	context: Context,
	options?: Record<string, unknown>,
): AssistantMessageEventStream {
	const stream = createEventStream();

	(async () => {
		try {
			const apiKey = getApiKey(model, options);
			const baseUrl = (model.baseUrl ?? "").replace(/\/+$/, "");
			const url = `${baseUrl}/chat/completions`;

			const body = buildRequestBody(model, context, options);
			const msgCount = (body.messages as unknown[])?.length ?? 0;
			const toolCount = (body.tools as unknown[])?.length ?? 0;
			console.log(`[non-stream] → POST ${url} model=${model.id} msgs=${msgCount} tools=${toolCount}`);
			const controller = new AbortController();
			const timeout = setTimeout(() => {
				console.log(`[non-stream] ⏱ 请求超时(120s)，中止`);
				controller.abort();
			}, 120_000);
			if (options && typeof (options as { signal?: AbortSignal }).signal?.addEventListener === "function") {
				(options as { signal: AbortSignal }).signal.addEventListener("abort", () => controller.abort());
			}

			const fetchStart = Date.now();
			// 非流式请求 + 重试（端点可能偶发 500 Router.Unavailable）
			let res: Response | null = null;
			let lastError: string | null = null;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					res = await fetch(url, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${apiKey}`,
							...(options && typeof (options as { headers?: Record<string, string> }).headers === "object"
								? (options as { headers: Record<string, string> }).headers
								: {}),
						},
						body: JSON.stringify(body),
						signal: controller.signal,
					});
					if (res.ok) break;
					// 5xx 可重试
					if (res.status >= 500 && attempt < 2) {
						const errBody = await res.text().catch(() => "");
						console.log(`[non-stream] ← ${res.status} (attempt ${attempt + 1}), 重试...`);
						lastError = `API ${res.status}: ${errBody.slice(0, 150)}`;
						await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
						continue;
					}
					break;
				} catch (fetchErr) {
					lastError = (fetchErr as Error).message;
					if (attempt < 2) {
						console.log(`[non-stream] fetch异常 (attempt ${attempt + 1}): ${lastError}, 重试...`);
						await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
						continue;
					}
					throw fetchErr;
				}
			}
			clearTimeout(timeout);

			if (!res || !res.ok) {
				throw new Error(lastError ?? `API 返回失败`);
			}

			const elapsed = Date.now() - fetchStart;
			console.log(`[non-stream] ← ${res.status} (${elapsed}ms)`);

			if (!res.ok) {
				const errText = await res.text().catch(() => res.statusText);
				console.log(`[non-stream] ✗ API错误: ${errText.slice(0, 200)}`);
				throw new Error(`API ${res.status}: ${errText.slice(0, 200)}`);
			}

			const data = (await res.json()) as OpenAIChatResponse;
			const choice = data.choices?.[0];
			if (!choice) throw new Error("API 返回了空的 choices");

			const msg = choice.message;
			const now = Date.now();
			const content: AssistantMessage["content"] = [];

			// reasoning_content → thinking block
			const reasoning = (msg as { reasoning_content?: string }).reasoning_content;
			if (reasoning && reasoning.trim()) {
				content.push({ type: "thinking", thinking: reasoning });
			}

			// content → text block
			if (msg.content && msg.content.trim()) {
				content.push({ type: "text", text: msg.content });
			}

			// tool_calls → toolCall blocks
			if (msg.tool_calls) {
				for (const tc of msg.tool_calls) {
					const args = parseToolArgs(tc.function?.arguments);
					const toolCall: ToolCall = {
						type: "toolCall",
						id: tc.id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						name: tc.function?.name ?? "",
						arguments: args,
					};
					content.push(toolCall);
				}
			}

			const hasToolCalls = (msg.tool_calls?.length ?? 0) > 0;
			const stopReason = hasToolCalls ? "toolUse" : choice.finish_reason === "length" ? "length" : "stop";
			console.log(`[non-stream] 解析完成: content=${msg.content ? `"${msg.content.slice(0, 40)}"` : "null"} reasoning=${reasoning ? `${reasoning.length}字` : "无"} tools=${msg.tool_calls?.length ?? 0} stop=${stopReason}`);

			const usage: Usage = {
				input: data.usage?.prompt_tokens ?? 0,
				output: data.usage?.completion_tokens ?? 0,
				cacheRead: (data.usage as { prompt_tokens_details?: { cached_tokens?: number } })?.prompt_tokens_details?.cached_tokens ?? 0,
				cacheWrite: 0,
				totalTokens: data.usage?.total_tokens ?? 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content,
				api: model.api,
				provider: model.provider,
				model: model.id,
				responseModel: data.model,
				responseId: data.id,
				usage,
				stopReason,
				timestamp: now,
			};

			// 发射事件序列
			let ci = 0;
			stream.push({ type: "start", partial: assistantMessage });
			for (const block of content) {
				if (block.type === "thinking") {
					stream.push({ type: "thinking_start", contentIndex: ci, partial: assistantMessage });
					stream.push({ type: "thinking_delta", contentIndex: ci, delta: block.thinking, partial: assistantMessage });
					stream.push({ type: "thinking_end", contentIndex: ci, content: block.thinking, partial: assistantMessage });
				} else if (block.type === "text") {
					stream.push({ type: "text_start", contentIndex: ci, partial: assistantMessage });
					stream.push({ type: "text_delta", contentIndex: ci, delta: block.text, partial: assistantMessage });
					stream.push({ type: "text_end", contentIndex: ci, content: block.text, partial: assistantMessage });
				} else if (block.type === "toolCall") {
					stream.push({ type: "toolcall_start", contentIndex: ci, partial: assistantMessage });
					stream.push({ type: "toolcall_delta", contentIndex: ci, delta: JSON.stringify(block.arguments), partial: assistantMessage });
					stream.push({ type: "toolcall_end", contentIndex: ci, toolCall: block, partial: assistantMessage });
				}
				ci++;
			}
			stream.push({ type: "done", reason: stopReason, message: assistantMessage });
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", message: errMsg });
		}
	})();

	return stream;
}

/** OpenAI Chat Completions 非流式响应类型（只取需要的字段）。 */
interface OpenAIChatResponse {
	id?: string;
	model?: string;
	choices: Array<{
		finish_reason?: string | null;
		message: {
			role: string;
			content: string | null;
			reasoning_content?: string | null;
			tool_calls?: Array<{
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
}

/** 从 model/options 获取 API key。 */
function getApiKey(model: Model<string>, options?: Record<string, unknown>): string {
	const opts = options as { apiKey?: string } | undefined;
	if (opts?.apiKey) return opts.apiKey;
	const envKey = process.env.OPENAI_API_KEY;
	if (envKey) return envKey;
	throw new Error(`No API key for provider: ${model.provider}`);
}

/** 构造 OpenAI Chat Completions 请求体。 */
function buildRequestBody(
	model: Model<"openai-completions">,
	context: Context,
	options?: Record<string, unknown>,
): Record<string, unknown> {
	const messages: unknown[] = [];

	// system prompt
	if (context.systemPrompt) {
		messages.push({ role: "system", content: context.systemPrompt });
	}

	// conversation
	for (const msg of context.messages) {
		if (msg.role === "user") {
			const textParts: string[] = [];
			if (typeof msg.content === "string") {
				textParts.push(msg.content);
			} else if (Array.isArray(msg.content)) {
				for (const b of msg.content) {
					if (typeof b === "object" && b !== null && (b as { type: string }).type === "text") {
						textParts.push((b as { text: string }).text);
					}
				}
			}
			if (textParts.length > 0) messages.push({ role: "user", content: textParts.join("") });
		} else if (msg.role === "assistant") {
			const blocks = Array.isArray(msg.content) ? msg.content : [];
			const text = blocks
				.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type: string }).type === "text")
				.map((b) => b.text)
				.join("");
			const toolCalls = blocks.filter(
				(b): b is ToolCall => typeof b === "object" && b !== null && (b as { type: string }).type === "toolCall",
			);
			if (toolCalls.length > 0) {
				messages.push({
					role: "assistant",
					content: text || null,
					tool_calls: toolCalls.map((tc) => ({
						id: tc.id,
						type: "function",
						function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
					})),
				});
			} else if (text) {
				messages.push({ role: "assistant", content: text });
			}
		} else if (msg.role === "toolResult") {
			const blocks = Array.isArray(msg.content) ? msg.content : [];
			const text = blocks
				.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type: string }).type === "text")
				.map((b) => b.text)
				.join("");
			messages.push({ role: "tool", tool_call_id: msg.toolCallId, content: text });
		}
	}

	const body: Record<string, unknown> = { model: model.id, messages };

	const opts = options as { maxTokens?: number; temperature?: number } | undefined;
	if (opts?.maxTokens) body.max_tokens = opts.maxTokens;
	if (opts?.temperature !== undefined) body.temperature = opts.temperature;

	// tools
	if (context.tools && context.tools.length > 0) {
		body.tools = context.tools.map((t) => ({
			type: "function",
			function: {
				name: t.name,
				description: t.description,
				parameters: t.parameters ?? { type: "object", properties: {} },
			},
		}));
	}

	return body;
}

function parseToolArgs(raw?: string): Record<string, unknown> {
	if (!raw) return {};
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return {};
	}
}
