import { type AgentMessage, type AgentTool, type Skill, formatSkillsForSystemPrompt, Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { buildSystemPrompt } from "./system-prompt.ts";
import { createDefaultTools } from "../tools/index.ts";
import { createSendMessageTool } from "../tools/send-message.ts";
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
	/** 已加载的技能清单（filePath 已重写为沙箱内路径）。所有 scope 共享。 */
	readonly skills?: Skill[];
	/**
	 * 共享的"当前被动消息 id"容器：prompt 时写入，工具执行期间读取。
	 * 由 SessionManager 创建，与 extraToolsFactory 共享同一引用。
	 */
	readonly replyToHolder?: { current?: string };
	/**
	 * 中间消息回调：当 agent 在工具调用之间输出了文字（如"让我查一下…""做好了"），
	 * 立即通过此回调发送，而不是攒到最后。让对话更像真人——边想边说。
	 * 最终回复仍然由 prompt() 返回值发送（router 负责）。
	 */
	readonly onIntermediateText?: (text: string) => void;
	/**
	 * 发送消息回调：agent 调用 send_message 工具时触发。
	 * agent 的文字输出不自动发送——只有主动调用 send_message 才发送。
	 */
	readonly onSendMessage?: (text: string) => Promise<void>;
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
	/** 本次 prompt run 中 agent 是否已通过 send_message 工具发送过消息。 */
	private messageSentThisRun = false;
	/**
	 * 群消息合并注入的「触发消息」：当前 prompt run 是由哪条群消息触发的。
	 * steer 进来的新消息不会开新 run，回复应引用「触发这条 run 的消息」。
	 * 由 prompt() 写入、run 结束后读取。
	 */
	private triggerMessageId: string | undefined;
	private runInFlight: Promise<string> | undefined;

	constructor(opts: BotSessionOptions) {
		this.opts = opts;
		this.scope = opts.scope;
		this.history = new HistoryStore(opts.scopeDir);
		this.memory = new MemoryStore(opts.scopeDir);
		this.memoryFiles = new MemoryFiles(opts.scopeDir);
		// send_message 工具：agent 主动决定何时发消息（替代自动发送文字输出）。
		const sendMessageTool = opts.onSendMessage
			? [createSendMessageTool({
					send: async (text: string) => {
						this.messageSentThisRun = true;
						await opts.onSendMessage!(text);
					},
				})]
			: [];
		this.tools = [...createDefaultTools(opts.env), ...sendMessageTool, ...(opts.extraTools ?? [])];
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
			skillsBlock: this.opts.skills?.length ? formatSkillsForSystemPrompt(this.opts.skills) : "",
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
	 * 群消息文本会带发送者前缀（`[openid]: 正文`），让 agent 识别是谁在说话。
	 * agent 自行决定回复里是否写 <qqbot-at-user> 标签 @ 人（adapter 不再自动 @）。
	 * 私聊不带头缀（只有一个对话者）。
	 *
	 * @returns 回复文本 + 该回复应引用的消息 id。
	 */
	async prompt(message: {
		text: string;
		senderId: string;
		senderName: string;
		platformMessageId?: string;
	}): Promise<{ text: string; replyToMessageId?: string }> {
		const isGroup = this.scope.kind === "group";
		const formatted = isGroup
			? `[${message.senderId}]: ${message.text}`
			: message.text;

		// 忙 → steer 注入，等当前 run 的回复（回复引用触发消息）。
		if (this.runInFlight) {
			this.agent.steer({ role: "user", content: formatted, timestamp: Date.now() });
			return this.runInFlight.then((text) => ({ text, replyToMessageId: this.triggerMessageId }));
		}

		// 空闲 → 开新 run。
		this.triggerMessageId = message.platformMessageId;
		if (this.opts.replyToHolder) this.opts.replyToHolder.current = message.platformMessageId;
		this.runInFlight = this.runPrompt(formatted);
		try {
			const text = await this.runInFlight;
			return { text, replyToMessageId: this.triggerMessageId };
		} finally {
			this.runInFlight = undefined;
			if (this.opts.replyToHolder) this.opts.replyToHolder.current = undefined;
		}
	}

	/** 实际跑一次 agent.prompt，收集 assistant 文本。 */
	private async runPrompt(formattedText: string): Promise<string> {
		const hasSendTool = !!this.opts.onSendMessage;
		this.messageSentThisRun = false;
		const collector = new AssistantTextCollector(hasSendTool ? undefined : this.opts.onIntermediateText);
		const unsubscribe = this.agent.subscribe((event) => collector.onEvent(event));
		try {
			await this.agent.prompt(formattedText);
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			console.error(`[bot] agent.prompt 失败: ${errMsg}`);
			return "服务器开小差了，请稍后再试。";
		} finally {
			unsubscribe();
		}
		// 有 send_message 工具且 agent 已通过工具发送了消息 → 返回空（router 不重复发）。
		// agent 没调 send_message（漏了）→ 用最终文字兜底。
		if (hasSendTool && this.messageSentThisRun) return "";
		return collector.text;
	}

	/**
	 * 回收：让 agent 自己总结会话并写入 memory.md，落盘历史，然后释放 Agent。
	 *
	 * 摘要由 agent 基于自己的完整上下文（系统提示词+记忆+对话历史）自行生成，
	 * 而非外部 generateSummary——agent 最清楚哪些重要、该带什么到下次。
	 *
	 * 注意：总结这段对话（"请总结" + agent 回复）**不存入 session.jsonl**——
	 * 在发总结消息前快照 messages，用快照落盘，避免下次加载时混入总结对话。
	 * 总结只写 memory.md。
	 */
	async dispose(): Promise<void> {
		try {
			// 先快照当前 messages（不含即将发生的总结对话）。
			const historySnapshot = this.agent.state.messages.slice();
			// 让 agent 自己总结当前会话。它带着完整上下文，知道该保留什么。
			const summary = await this.summarizeSelf();
			if (summary) await this.memory.save(summary);
			// 用快照落盘——不包含总结这段对话。
			await this.history.save(historySnapshot);
			// 按天归档到 history/YYYY-MM-DD.jsonl（长期累积，只读挂载到沙箱供 agent 查阅）。
			await this.history.archiveByDay(historySnapshot);
		} finally {
			this.agent.abort();
			await this.agent.waitForIdle().catch(() => {});
		}
	}

	/**
	 * 让 agent 自己总结会话，返回摘要文本。
	 * 复用 prompt 机制（带 replyToHolder 清理），收集 assistant 回复。
	 */
	private async summarizeSelf(): Promise<string | undefined> {
		const messages = this.agent.state.messages;
		if (messages.length === 0) return undefined;
		try {
			const collector = new AssistantTextCollector();
			const unsubscribe = this.agent.subscribe((event) => collector.onEvent(event));
			try {
				await this.agent.prompt(
					"【系统】这个会话即将被回收（1 小时无活动）。请基于以上全部对话，总结一段简洁的会话摘要写入你的长期记忆，供下次会话激活时续接上下文。\n\n" +
						"要求：\n" +
						"- 用 Markdown，控制在 500 字以内\n" +
						"- 保留：关键事实、未完成的任务、重要的用户偏好/约定、你的人设演变\n" +
						"- 不要逐条复述对话，只提炼对未来有用的信息\n" +
						"- 如果对话没什么值得记住的，回复「（无重要内容）」\n\n" +
						"直接输出摘要内容，不要调用工具。",
				);
			} finally {
				unsubscribe();
			}
			const text = collector.text;
			return text && !text.includes("（无重要内容）") ? text : undefined;
		} catch {
			return undefined;
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
/**
 * 收集 agent 的 assistant 文本，并在工具调用之间产生中间文字时立即回调发送。
 *
 * Agent loop 每轮 LLM 调用结束会 emit message_end（带完整 assistant message）。
 * 如果这轮的 stopReason 是 "toolUse"（后面还有工具执行+更多轮），且 assistant
 * 输出了文字，这文字就是"中间消息"——应该立即发给用户，而不是攒到最后。
 * 最后一轮（stopReason="stop"）的文字由 prompt() 返回值发送。
 */
class AssistantTextCollector {
	private finalParts: string[] = [];

	constructor(private readonly onIntermediateText?: (text: string) => void) {}

	onEvent = (event: unknown): void => {
		const e = event as {
			type: string;
			message?: { role?: string; content?: unknown; stopReason?: string };
		};
		if (e.type !== "message_end") return;
		const message = e.message;
		if (!message || message.role !== "assistant") return;
		const content = message.content;
		if (!Array.isArray(content)) return;
		const chunk = content
			.filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && (c as { type: string }).type === "text")
			.map((c) => c.text)
			.join("")
			.trim();
		if (!chunk) return;

		// 如果这轮以 toolUse 结束（后面还有工具要执行），文字是中间消息，立即发送。
		if (message.stopReason === "toolUse" && this.onIntermediateText) {
			this.onIntermediateText(chunk);
		} else {
			// 最后一轮（stop/length）的文字作为最终回复返回。
			this.finalParts.push(chunk);
		}
	};

	get text(): string {
		return this.finalParts.join("").trim();
	}
}
