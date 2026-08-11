import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ToolCall,
	ToolResultMessage,
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
 *
 * - OpenAI Chat Completions 端点：某些兼容端点流式模式有 bug（推理模型只输出 reasoning）。
 * - Anthropic Messages 端点：DeepSeek 兼容层在 stream:true + thinking + tool_use 时，
 *   input_json_delta 解析出的工具参数为空对象 {}，导致工具调用失败。
 *   非流式模式正常返回完整 tool_use.input。用非流式绕过这个 bug。
 *
 * 其它 API 走原始 streamFn。
 */
export function createNonStreamStreamFn(originalStreamFn: StreamFn): StreamFn {
	return (model, context, options) => {
		if (model.api === "openai-completions") {
			return nonStreamOpenAI(model as Model<"openai-completions">, context, options as Record<string, unknown> | undefined);
		}
		if (model.api === "anthropic-messages") {
			return nonStreamAnthropic(model as Model<"anthropic-messages">, context, options as Record<string, unknown> | undefined);
		}
		return originalStreamFn(model, context, options);
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
		const e = event as { type: string; message?: AssistantMessage; reason?: string };
		if (e.type === "done") {
			if (e.message) finalMessage = e.message;
			done = true;
		} else if (e.type === "error") {
			// error 事件：构造一个 stopReason=error 的空 assistant message 作为最终结果，
			// 让 agent-loop 能正常结束（否则 result() 永远不 resolve）。
			if (!finalMessage) {
				finalMessage = {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					api: "unknown" as never,
					provider: "unknown",
					model: "unknown",
					responseModel: "unknown",
					responseId: undefined,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "error",
					timestamp: Date.now(),
				};
			}
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
					// 4xx 等不可重试错误：读 body 存 lastError，避免抛无信息的「API 返回失败」
					lastError = `API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
					console.log(`[non-stream] ← ${res.status}: ${lastError}`);
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

			// reasoning_content：记录到日志（诊断用），但不放入 thinking block。
			// 原因：thinking block 需要 signature 才能被 Anthropic 兼容端点（如 DeepSeek）
			// 在多轮 tool_use 时正确接受；非流式桥接拿不到 signature，无 signature 的
			// thinking block 会导致后续请求 400（tool_use without tool_result，实际是
			// thinking 块打乱了消息序列校验）。reasoning 内容对 agent 逻辑无用，直接丢弃。
			const reasoning = (msg as { reasoning_content?: string }).reasoning_content;

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

/** 从 model/options 获取 Anthropic API key。 */
function getAnthropicApiKey(model: Model<string>, options?: Record<string, unknown>): string {
	const opts = options as { apiKey?: string } | undefined;
	if (opts?.apiKey) return opts.apiKey;
	// DeepSeek 兼容端点用 ANTHROPIC_AUTH_TOKEN，官方用 ANTHROPIC_API_KEY
	const envKey = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
	if (envKey) return envKey;
	throw new Error(`No API key for provider: ${model.provider} (need ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY)`);
}

/**
 * 用 fetch 发非流式 Anthropic Messages 请求。
 *
 * 绕过 DeepSeek 兼容端点在 stream:true 下 tool_use.input 解析为空 {} 的 bug。
 * 请求 POST {baseUrl}/v1/messages（stream:false），把完整响应转换成事件序列。
 */
function nonStreamAnthropic(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: Record<string, unknown>,
): AssistantMessageEventStream {
	const stream = createEventStream();

	(async () => {
		try {
			const apiKey = getAnthropicApiKey(model, options);
			const baseUrl = (model.baseUrl ?? "").replace(/\/+$/, "");
			const url = `${baseUrl}/v1/messages`;

			const body = buildAnthropicRequestBody(model, context, options);
			const msgCount = (body.messages as unknown[])?.length ?? 0;
			const toolCount = (body.tools as unknown[])?.length ?? 0;
			console.log(`[non-stream:anthropic] → POST ${url} model=${model.id} msgs=${msgCount} tools=${toolCount}`);
			if (process.env.NONSTREAM_DEBUG) console.log(`[non-stream:anthropic] body: ${JSON.stringify(body).slice(0, 500)}`);

			const controller = new AbortController();
			const timeout = setTimeout(() => {
				console.log(`[non-stream:anthropic] ⏱ 请求超时(120s)，中止`);
				controller.abort();
			}, 120_000);
			if (options && typeof (options as { signal?: AbortSignal }).signal?.addEventListener === "function") {
				(options as { signal: AbortSignal }).signal.addEventListener("abort", () => controller.abort());
			}

			const fetchStart = Date.now();
			let res: Response | null = null;
			let lastError: string | null = null;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					res = await fetch(url, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-api-key": apiKey,
							"anthropic-version": "2023-06-01",
							...(options && typeof (options as { headers?: Record<string, string> }).headers === "object"
								? (options as { headers: Record<string, string> }).headers
								: {}),
						},
						body: JSON.stringify(body),
						signal: controller.signal,
					});
					if (res.ok) break;
					if (res.status >= 500 && attempt < 2) {
						const errBody = await res.text().catch(() => "");
						console.log(`[non-stream:anthropic] ← ${res.status} (attempt ${attempt + 1}), 重试...`);
						lastError = `API ${res.status}: ${errBody.slice(0, 150)}`;
						await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
						continue;
					}
					// 4xx 等不可重试错误：读 body 存 lastError，避免抛无信息的「API 返回失败」
					lastError = `API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
					console.log(`[non-stream:anthropic] ← ${res.status}: ${lastError}`);
					break;
				} catch (fetchErr) {
					lastError = (fetchErr as Error).message;
					if (attempt < 2) {
						console.log(`[non-stream:anthropic] fetch异常 (attempt ${attempt + 1}): ${lastError}, 重试...`);
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
			console.log(`[non-stream:anthropic] ← ${res.status} (${elapsed}ms)`);

			if (!res.ok) {
				const errText = await res.text().catch(() => res.statusText);
				console.log(`[non-stream:anthropic] ✗ API错误: ${errText.slice(0, 300)}`);
				throw new Error(`API ${res.status}: ${errText.slice(0, 300)}`);
			}

			const data = (await res.json()) as AnthropicMessagesResponse;
			const now = Date.now();
			const content: AssistantMessage["content"] = [];

			// content blocks → pi-ai blocks
			// 注意：thinking block 丢弃（同 OpenAI 分支的理由——无 signature 的 thinking
			// block 会导致 DeepSeek 兼容端点多轮 tool_use 时 400）。reasoning 内容对 agent 逻辑无用。
			let toolCount2 = 0;
			if (Array.isArray(data.content)) {
				for (const block of data.content) {
					if (block.type === "text" && block.text) {
						content.push({ type: "text", text: block.text });
					} else if (block.type === "tool_use") {
						const toolCall: ToolCall = {
							type: "toolCall",
							id: block.id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
							name: block.name ?? "",
							arguments: (block.input as Record<string, unknown>) ?? {},
						};
						content.push(toolCall);
						toolCount2++;
					}
				}
			}

			const stopReason = toolCount2 > 0 ? "toolUse" : data.stop_reason === "max_tokens" ? "length" : "stop";
			console.log(`[non-stream:anthropic] 解析完成: blocks=${content.length} tools=${toolCount2} stop=${stopReason}`);

			const usage: Usage = {
				input: data.usage?.input_tokens ?? 0,
				output: data.usage?.output_tokens ?? 0,
				cacheRead: data.usage?.cache_read_input_tokens ?? 0,
				cacheWrite: data.usage?.cache_creation_input_tokens ?? 0,
				totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
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
			console.log(`[non-stream:anthropic] ✗ 异常: ${errMsg}`);
			stream.push({ type: "error", message: errMsg });
		}
	})();

	return stream;
}

/** Anthropic Messages 非流式响应类型（只取需要的字段）。 */
interface AnthropicMessagesResponse {
	id?: string;
	model?: string;
	stop_reason?: string | null;
	content?: Array<
		| { type: "text"; text?: string }
		| { type: "thinking"; thinking?: string }
		| { type: "tool_use"; id?: string; name?: string; input?: unknown }
	>;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
}

/** 构造 Anthropic Messages 请求体。 */
/**
 * 根据传入的 thinkingLevel（options.reasoning）决定 thinking 参数。
 *
 * - off/undefined → { type: "disabled" }（不思考）
 * - low/medium/high/max → { type: "enabled", budget_tokens: 对应预算 }
 *
 * DeepSeek 的 Anthropic 兼容端点支持 thinking:{type:enabled, budget_tokens}。
 * 预算按级别递增（low=4k, medium=8k, high=16k, max=24k）。
 * 注意：非流式桥接丢弃返回的 reasoning_content（无 signature 多轮 tool_use 会 400），
 * 但仍发送 thinking 参数让模型用思考能力推理。
 */
function resolveThinking(options?: Record<string, unknown>): Record<string, unknown> {
	const reasoning = (options as { reasoning?: string } | undefined)?.reasoning;
	const BUDGETS: Record<string, number> = { minimal: 2048, low: 4096, medium: 8192, high: 16384, xhigh: 24576, max: 24576 };
	if (!reasoning || reasoning === "off") return { type: "disabled" };
	const budget = BUDGETS[reasoning] ?? 8192;
	return { type: "enabled", budget_tokens: budget };
}

/**
 * 把一条 ToolResultMessage 转成 Anthropic 的 tool_result content block。
 * 多个连续 toolResult 合并到同一个 user 消息时，每个调一次此函数。
 */
function buildToolResultBlock(msg: ToolResultMessage): Record<string, unknown> {
	const blocks = Array.isArray(msg.content) ? msg.content : [];
	const text = blocks
		.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type: string }).type === "text")
		.map((b) => b.text)
		.join("");
	return {
		type: "tool_result",
		tool_use_id: msg.toolCallId,
		content: text,
		...(msg.isError ? { is_error: true } : {}),
	};
}

function buildAnthropicRequestBody(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: Record<string, unknown>,
): Record<string, unknown> {
	const messages: unknown[] = [];

	for (let i = 0; i < context.messages.length; i++) {
		const msg = context.messages[i];
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
			const content: unknown[] = [];
			for (const b of blocks) {
				if (typeof b !== "object" || b === null) continue;
				const t = (b as { type: string }).type;
				if (t === "text" && (b as { text: string }).text) {
					content.push({ type: "text", text: (b as { text: string }).text });
				} else if (t === "toolCall") {
					const tc = b as ToolCall;
					content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments ?? {} });
				}
			}
			if (content.length > 0) messages.push({ role: "assistant", content });
		} else if (msg.role === "toolResult") {
			// 合并连续的 toolResult 到同一个 user 消息——Anthropic 格式要求：
			// 一个 assistant 消息里的多个 tool_use，其 tool_result 必须合并在同一个
			// user 消息里。如果每个 toolResult 独立一个 user 消息，DeepSeek 兼容端点
			// 会判定「tool_use without tool_result」400（把第二个 user 当新输入而非回复）。
			// 与 pi-ai 原生 convertMessages 的连续 toolResult 合并逻辑一致。
			const toolResults: unknown[] = [];
			// 当前的 toolResult
			toolResults.push(buildToolResultBlock(msg));
			// 收集后续连续的 toolResult
			let j = i + 1;
			while (j < context.messages.length && context.messages[j].role === "toolResult") {
				toolResults.push(buildToolResultBlock(context.messages[j] as ToolResultMessage));
				j++;
			}
			i = j - 1; // 跳过已处理的连续 toolResult
			messages.push({ role: "user", content: toolResults });
		}
	}

	const thinking = resolveThinking(options);
	// thinking enabled 时，max_tokens 必须 > budget_tokens（Anthropic 要求），且留足正文空间。
	// 否则思考占满 max_tokens，正文 0 token → stop=length → 空回复。
	const baseMaxTokens = (options as { maxTokens?: number } | undefined)?.maxTokens ?? model.maxTokens ?? 8192;
	const isThinkingEnabled = (thinking as { type?: string }).type === "enabled";
	const budgetTokens = (thinking as { budget_tokens?: number }).budget_tokens ?? 0;
	const maxTokens = isThinkingEnabled ? Math.max(baseMaxTokens, budgetTokens + 8192) : baseMaxTokens;

	const body: Record<string, unknown> = {
		model: model.id,
		max_tokens: maxTokens,
		messages,
		// thinking 跟随 options.reasoning（pi-ai 传进来的 thinkingLevel）：
		// off → thinking:disabled；其它（low/medium/high/max）→ thinking:{type:enabled, budget_tokens:...}
		// 注意：非流式桥接丢弃返回的 reasoning_content（无 signature 多轮 tool_use 会 400），
		// 但仍发送 thinking 参数让模型用思考能力推理（推理过程对模型输出质量有帮助，只是不持久化）。
		thinking,
	};
	if (context.systemPrompt) body.system = context.systemPrompt;

	const opts = options as { temperature?: number } | undefined;
	if (opts?.temperature !== undefined) body.temperature = opts.temperature;

	if (context.tools && context.tools.length > 0) {
		body.tools = context.tools.map((t) => ({
			name: t.name,
			description: t.description,
			input_schema: t.parameters ?? { type: "object", properties: {} },
		}));
	}

	return body;
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

	const body: Record<string, unknown> = {
		model: model.id,
		messages,
		// thinking 跟随 options.reasoning（同 anthropic 分支）。
		thinking: resolveThinking(options),
	};

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
