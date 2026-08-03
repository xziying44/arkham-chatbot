import { type AgentMessage, type AgentTool, Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { buildSystemPrompt } from "./system-prompt.ts";
import { createDefaultTools } from "../tools/index.ts";
import { HistoryStore } from "../session/history.ts";
import { MemoryStore } from "../session/memory.ts";
import { MemoryFiles } from "../session/memory-files.ts";
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
	/**
	 * 共享的"当前被动消息 id"容器：prompt 时写入，工具执行期间读取。
	 * 由 SessionManager 创建，与 extraToolsFactory 共享同一引用。
	 */
	readonly replyToHolder?: { current?: string };
}

export class ChatBotSession {
	readonly scope: ScopeKey;
	private readonly opts: BotSessionOptions;
	private readonly history: HistoryStore;
	private readonly memory: MemoryStore;
	/** 文件式自管理记忆（memories/ 目录 + MEMORY.md 索引）。 */
	private readonly memoryFiles: MemoryFiles;
	private agent!: Agent;
	private readonly tools: AgentTool[];
	/** 激活时构建并缓存，供管理端只读查看。 */
	private systemPromptCache: string | undefined;
	/**
	 * 群消息合并注入的「触发消息」：当前 prompt run 是由哪条群消息触发的。
	 * steer 进来的新消息不会开新 run，回复应引用「触发这条 run 的消息」。
	 * 由 prompt() 写入、run 结束后读取。
	 */
	private triggerMessageId: string | undefined;
	/** 触发当前 run 的群消息发送者 openid（回复时 @ 那个人）。 */
	private triggerSenderOpenid: string | undefined;
	private runInFlight: Promise<string> | undefined;

	constructor(opts: BotSessionOptions) {
		this.opts = opts;
		this.scope = opts.scope;
		this.history = new HistoryStore(opts.scopeDir);
		this.memory = new MemoryStore(opts.scopeDir);
		this.memoryFiles = new MemoryFiles(opts.scopeDir);
		// 不单独做 memory 工具——记忆文件在沙箱工作目录内（workspace/memories/），
		// agent 用自带的 read/write/edit/bash 直接操作，沙箱的 per-scope 隔离保证不串。
		this.tools = [...createDefaultTools(opts.env), ...(opts.extraTools ?? [])];
	}

	/** 激活：确保工作目录存在，读历史/记忆/记忆索引，构造 Agent。 */
	async activate(): Promise<void> {
		await mkdir(join(this.opts.scopeDir, "workspace"), { recursive: true });
		await this.memoryFiles.ensure();
		// 检查「清除历史」标记：存在则本次不注入历史消息（session.jsonl 不删），然后消费标记。
		const cleared = await this.consumeHistoryClearedFlag();
		// 并行加载：历史（若被标记清除则注入空）、会话摘要、记忆索引。
		const [previousMessages, sessionSummary, memoryIndex] = await Promise.all([
			cleared ? Promise.resolve([]) : this.history.load(),
			this.memory.load(),
			this.memoryFiles.loadIndex(),
		]);
		const systemPrompt = buildSystemPrompt({
			scopeName: this.opts.scopeName,
			scopeKind: this.opts.scope.kind,
			persona: this.opts.persona,
			memory: sessionSummary,
			memoryIndex,
			recentMessageCount: previousMessages.length,
			tools: this.tools,
		});
		this.systemPromptCache = systemPrompt;

		this.agent = new Agent({
			initialState: {
				systemPrompt,
				model: this.opts.model,
				tools: this.tools,
				messages: previousMessages,
			},
			streamFn: this.opts.streamFn,
		});
		// 群聊消息合并：steer 队列设为 "all"，drain 时把积攒的所有消息一次性注入。
		this.agent.steeringMode = "all";
		console.log(`[bot] activate scope=${this.opts.scope.kind}:${this.opts.scope.id} msgs=${previousMessages.length} tools=[${this.tools.map((t) => t.name).join(",")}]`);
	}

	/** 当前会话的系统提示词全文（管理端「提示词」视图）。激活后可用。 */
	get systemPrompt(): string {
		return this.systemPromptCache ?? "";
	}

	/** 工具描述符列表（name + description），管理端只读展示。 */
	get toolDescriptors(): { name: string; description: string }[] {
		return this.tools.map((t) => ({ name: t.name, description: t.description }));
	}

	/**
	 * 是否正在处理（有 in-flight 的 prompt run）。
	 * SessionManager 据此决定：idle → 开新 prompt；busy → steer 注入。
	 */
	get isBusy(): boolean {
		return this.runInFlight !== undefined;
	}

	/**
	 * 处理一条入站消息。
	 *
	 * 群聊合并语义：
	 * - 若 agent 空闲 → 开新 run（agent.prompt），记录 triggerMessageId。
	 * - 若 agent 忙 → agent.steer 注入（mode=all），等当前 run 结束后批量 drain。
	 *   steer 的消息不改变 triggerMessageId（回复仍引用触发当前 run 的那条消息）。
	 *
	 * 群消息文本会带发送者前缀（`<昵称>: <正文>`），让 agent 识别是谁在说话。
	 * 私聊不带头缀（只有一个对话者）。
	 *
	 * @returns 回复文本 + 该回复应引用的消息 id + 触发消息发送者的 openid（群消息 @ 人用）。
	 */
	async prompt(message: {
		text: string;
		senderId: string;
		senderName: string;
		platformMessageId?: string;
	}): Promise<{ text: string; replyToMessageId?: string; mentionUserOpenid?: string }> {
		// QQ 群消息事件不提供昵称，senderName 退化为 senderId（member_openid）。
		// 因此群消息前缀直接用 openid 作为发送者标识，agent 靠 openid 识别不同群员，
		// 并通过记忆建立「openid → 称呼」映射（首次互动时问对方怎么称呼）。
		const isGroup = this.scope.kind === "group";
		const formatted = isGroup
			? `[${message.senderId}]: ${message.text}`
			: message.text;

		// 忙 → steer 注入，等当前 run 的回复（回复引用触发消息、@ 触发送者）。
		if (this.runInFlight) {
			this.agent.steer({ role: "user", content: formatted, timestamp: Date.now() });
			return this.runInFlight.then((text) => ({ text, replyToMessageId: this.triggerMessageId, mentionUserOpenid: this.triggerSenderOpenid }));
		}

		// 空闲 → 开新 run。
		this.triggerMessageId = message.platformMessageId;
		// 群消息记录发送者 openid，回复时用它 @ 那个人。
		this.triggerSenderOpenid = isGroup ? message.senderId : undefined;
		if (this.opts.replyToHolder) this.opts.replyToHolder.current = message.platformMessageId;
		this.runInFlight = this.runPrompt(formatted);
		try {
			const text = await this.runInFlight;
			return { text, replyToMessageId: this.triggerMessageId, mentionUserOpenid: this.triggerSenderOpenid };
		} finally {
			this.runInFlight = undefined;
			if (this.opts.replyToHolder) this.opts.replyToHolder.current = undefined;
		}
	}

	/** 实际跑一次 agent.prompt，收集 assistant 文本。 */
	private async runPrompt(formattedText: string): Promise<string> {
		const collector = new AssistantTextCollector();
		const unsubscribe = this.agent.subscribe((event) => collector.onEvent(event));
		try {
			await this.agent.prompt(formattedText);
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

	/** 「清除历史」标记文件路径（沙箱外，agent 看不到也改不了）。 */
	private get historyClearedFlagPath(): string {
		return join(this.opts.scopeDir, ".history_cleared");
	}

	/**
	 * 消费「清除历史」标记：存在则返回 true 并删除标记（一次性）。
	 * 管理端调 setHistoryCleared() 写标记，下次激活时不注入历史消息。
	 */
	private async consumeHistoryClearedFlag(): Promise<boolean> {
		try {
			await unlink(this.historyClearedFlagPath);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * 写「清除历史」标记：下次激活时 consumeHistoryClearedFlag 会读到它，
	 * 本次不注入 session.jsonl 历史（文件不删，只是不加载）。
	 */
	async setHistoryCleared(): Promise<void> {
		await writeFile(this.historyClearedFlagPath, String(Date.now()), "utf8");
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
