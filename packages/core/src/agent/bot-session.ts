import { type AgentMessage, type AgentTool, Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildSystemPrompt } from "./system-prompt.ts";
import { createDefaultTools } from "../tools/index.ts";
import { HistoryStore } from "../session/history.ts";
import { MemoryStore } from "../session/memory.ts";
import type { ScopeKey } from "../identity/scope.ts";
import { scopeKeyStr } from "../identity/scope.ts";

/**
 * 一个活跃会话的协调器：持有 pi Agent，装配工具，管理记忆/历史存取。
 *
 * 生命周期由 {@link SessionManager} 驱动：
 * - 激活（activate）：读历史 + 记忆 → 建 Agent → 进入可对话状态。
 * - 对话（prompt）：把群成员消息喂给 Agent，收集流式输出拼成回复。
 * - 回收（dispose）：提取记忆摘要落盘 + 落盘历史 + 释放 Agent。
 */
export interface BotSessionOptions {
	readonly scope: ScopeKey;
	readonly scopeName: string;
	readonly scopeDir: string;
	readonly model: Model<any>;
	readonly streamFn: StreamFn;
	readonly env: ExecutionEnv;
	readonly persona?: string;
	/** 额外的自定义工具（在默认 bash/read/edit/write 之上）。 */
	readonly extraTools?: AgentTool[];
}

export class ChatBotSession {
	readonly scope: ScopeKey;
	private readonly opts: BotSessionOptions;
	private readonly history: HistoryStore;
	private readonly memory: MemoryStore;
	private agent!: Agent;
	private readonly tools: AgentTool[];

	constructor(opts: BotSessionOptions) {
		this.opts = opts;
		this.scope = opts.scope;
		this.history = new HistoryStore(opts.scopeDir);
		this.memory = new MemoryStore(opts.scopeDir);
		this.tools = [...createDefaultTools(opts.env), ...(opts.extraTools ?? [])];
	}

	/** 激活：确保工作目录存在，读历史/记忆，构造 Agent。 */
	async activate(): Promise<void> {
		await mkdir(join(this.opts.scopeDir, "workspace"), { recursive: true });
		const [previousMessages, memory] = await Promise.all([this.history.load(), this.memory.load()]);
		const systemPrompt = buildSystemPrompt({
			scopeName: this.opts.scopeName,
			persona: this.opts.persona,
			memory,
			tools: this.tools,
		});

		this.agent = new Agent({
			initialState: {
				systemPrompt,
				model: this.opts.model,
				tools: this.tools,
				messages: previousMessages,
			},
			streamFn: this.opts.streamFn,
		});
	}

	/**
	 * 处理一条入站消息，返回完整回复文本。
	 * 收集 assistant 的文本内容拼接；若 Agent 末轮无文本产出（例如只调了工具），
	 * 返回空串，由上层决定是否补一句默认回复。
	 */
	async prompt(text: string): Promise<string> {
		const collector = new AssistantTextCollector();
		const unsubscribe = this.agent.subscribe((event) => collector.onEvent(event));
		try {
			await this.agent.prompt(text);
		} finally {
			unsubscribe();
		}
		return collector.text;
	}

	/**
	 * 回收：把当前会话压缩成记忆、落盘历史，然后释放 Agent。
	 * @param summarize 由 SessionManager 注入的摘要函数（封装 pi generateSummary）。
	 */
	async dispose(summarize: () => Promise<string | undefined>): Promise<void> {
		try {
			const summary = await summarize();
			if (summary) await this.memory.save(summary);
			await this.history.save(this.agent.state.messages);
		} finally {
			this.agent.abort();
			await this.agent.waitForIdle().catch(() => {});
		}
	}

	/** 当前消息历史快照（用于回收前落盘）。 */
	get messages(): AgentMessage[] {
		return this.agent?.state.messages ?? [];
	}

	get debugId(): string {
		return scopeKeyStr(this.scope);
	}
}

/**
 * 订阅 Agent 事件，把 assistant 文本增量拼成一条完整回复。
 * 注意：pi 的事件流里，message_update 携带当前 partial；我们只在 message_end
 * （assistant 消息完成）时把该条消息的完整文本追加，避免拼接流式增量造成重复。
 */
class AssistantTextCollector {
	private parts: string[] = [];

	onEvent = (event: unknown): void => {
		const e = event as { type: string; message?: { role?: string; content?: unknown } };
		if (e.type !== "message_end") return;
		const message = e.message;
		if (!message || message.role !== "assistant") return;
		const content = message.content;
		if (!Array.isArray(content)) return;
		const chunk = content
			.filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && (c as { type: string }).type === "text")
			.map((c) => c.text)
			.join("");
		if (chunk.length > 0) this.parts.push(chunk);
	};

	get text(): string {
		return this.parts.join("").trim();
	}
}
