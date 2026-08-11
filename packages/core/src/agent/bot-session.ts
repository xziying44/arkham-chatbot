import { type AgentMessage, type AgentTool, type Skill, formatSkillsForSystemPrompt, Agent, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { buildSystemPrompt } from "./system-prompt.ts";
import { createDefaultTools } from "../tools/index.ts";
import { createSendMessageTool } from "../tools/send-message.ts";
import { createLoadSkillTool } from "../tools/load-skill.ts";
import type { PendingAskHolder } from "../tools/ask-user.ts";
import { HistoryStore } from "../session/history.ts";
import { MemoryFiles } from "../session/memory-files.ts";
import type { ScopeKey } from "../identity/scope.ts";
import { scopeKeyStr } from "../identity/scope.ts";

/**
 * 一个活跃会话的协调器：持有 pi Agent，装配工具，管理历史存取。
 *
 * 生命周期由 {@link SessionManager} 驱动：
 * - 激活（activate）：读历史 → 建 Agent → 进入可对话状态。
 * - 对话（prompt）：把群成员消息喂给 Agent，收集流式输出拼成回复。
 * - 回收（dispose）：落盘历史快照 + 释放 Agent（压缩在后续步骤接入）。
 */
export interface BotSessionOptions {
	readonly scope: ScopeKey;
	readonly scopeName: string;
	readonly scopeDir: string;
	readonly model: Model<any>;
	/** pi-ai 的 Models 注册表（会话压缩 compact() 用，替代 streamFn 之外的 LLM 调用）。 */
	readonly models: Models;
	readonly streamFn: StreamFn;
	readonly env: ExecutionEnv;
	/** 思考程度: off/low/medium/high/max。控制 Agent 的 thinkingLevel。 */
	readonly thinkingLevel?: string;
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
	/**
	 * 挂起提问容器：ask_user 工具写入 PendingAsk，prompt 在收到用户文字消息时
	 * 读取并 reject（把文字作为响应）。由 SessionManager 创建，与工具共享同一引用。
	 */
	readonly pendingAskHolder?: PendingAskHolder;
}

export class ChatBotSession {
	readonly scope: ScopeKey;
	private readonly opts: BotSessionOptions;
	private readonly history: HistoryStore;
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
	/** triggerMessageId 的 getter（保留给管理端/日志查看）。 */
	get triggerMessageIdValue(): string | undefined { return this.triggerMessageId; }
	private runInFlight: Promise<string> | undefined;

	constructor(opts: BotSessionOptions) {
		this.opts = opts;
		this.scope = opts.scope;
		this.history = new HistoryStore(opts.scopeDir);
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
		// load_skill 工具：agent 通过工具调用加载技能（比 read SKILL.md 更结构化）。
		const loadSkillTool = opts.skills?.length
			? [createLoadSkillTool({ skills: opts.skills })]
			: [];
		this.tools = [...createDefaultTools(opts.env), ...sendMessageTool, ...loadSkillTool, ...(opts.extraTools ?? [])];
	}

	/** 激活：确保工作目录存在，读历史，构造 Agent。 */
	async activate(): Promise<void> {
		await mkdir(join(this.opts.scopeDir, "workspace"), { recursive: true });
		await this.memoryFiles.ensure();
		// 检查「清除历史」标记：存在则本次不注入历史消息（session.jsonl 不删），然后消费标记。
		const cleared = await this.consumeHistoryClearedFlag();
		// 加载历史（若被标记清除则注入空）。会话续接靠 session.jsonl 里的消息
		// （Step 2 接入后，含 compactionSummary 消息——压缩摘要作为对话历史的一部分）。
		const previousMessages = cleared ? [] : await this.history.load();
		const systemPrompt = buildSystemPrompt({
			scopeName: this.opts.scopeName,
			scopeKind: this.opts.scope.kind,
			persona: this.opts.persona,
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
				// thinkingLevel 控制思考开关与强度：off=关闭，low/medium/high/max=对应 effort。
				// 默认 "off"；pi-ai 据此 + Model.reasoning 决定发给 LLM 的 thinking 参数。
				// 从 settings 传来的是 string，这里窄化为 ThinkingLevel 联合类型。
				thinkingLevel: (this.opts.thinkingLevel ?? "off") as ThinkingLevel,
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

		// 无论忙闲，都更新 replyToHolder 为最新消息 ID。
		// 这样 send_message 工具发消息时用的永远是最新的（未过期的）消息 ID。
		if (this.opts.replyToHolder) this.opts.replyToHolder.current = message.platformMessageId;

		// 忙 → steer 注入，等当前 run 的回复（回复引用触发消息）。
		if (this.runInFlight) {
			// 拦截：如果 agent 正在等 ask_user 响应（pendingAsk 挂起），
			// 用户发了消息（点按钮自动发送 或 手动打字）→ 取消提问，消息内容作为响应返回给工具。
			// 此时消息已被 ask_user 工具消费，不再 steer（避免 agent 重复看到同一条消息导致重复回复）。
			const pending = this.opts.pendingAskHolder?.current;
			if (pending) {
				pending.reject(message.text);
				return this.runInFlight.then((text) => ({ text, replyToMessageId: this.opts.replyToHolder?.current }));
			}
			this.agent.steer({ role: "user", content: formatted, timestamp: Date.now() });
			return this.runInFlight.then((text) => ({ text, replyToMessageId: this.opts.replyToHolder?.current }));
		}

		// 空闲 → 开新 run。
		this.triggerMessageId = message.platformMessageId;
		this.runInFlight = this.runPrompt(formatted);
		try {
			const text = await this.runInFlight;
			return { text, replyToMessageId: this.opts.replyToHolder?.current };
		} finally {
			this.runInFlight = undefined;
			// 不清除 replyToHolder.current——保留最后一条消息 ID，
			// 万一 agent 还在收尾发消息时能用到。
		}
	}

	/** 实际跑一次 agent.prompt，收集 assistant 文本。 */
	private async runPrompt(formattedText: string): Promise<string> {
		const hasSendTool = !!this.opts.onSendMessage;
		this.messageSentThisRun = false;
		// 记录 run 前的消息数，结束后把本轮新增的消息增量追加到 session.jsonl，
		// 这样即使进程被 kill，未触发 dispose 的对话也不会丢（dispose 时 history.save 仍会全量覆盖兜底）。
		const beforeLen = this.agent.state.messages.length;
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
		// 增量落盘本轮新增消息（user + assistant + toolResult 等）。失败不阻断回复。
		const after = this.agent.state.messages;
		if (after.length > beforeLen) {
			await this.history.appendAll(after.slice(beforeLen)).catch(() => {});
		}
		// 有 send_message 工具且 agent 已通过工具发送了消息 → 返回空（router 不重复发）。
		// agent 没调 send_message（漏了）→ 用最终文字兜底。
		if (hasSendTool && this.messageSentThisRun) return "";
		return collector.text;
	}

	/**
	 * 回收：落盘历史快照 + 按天归档，然后释放 Agent。
	 *
	 * 当前实现为直接落盘原始消息（不做压缩）。Step 2 接入后会改为调 pi 的
	 * compact() 把历史压缩成 [compactionSummary, ...retainedTail] 再落盘，
	 * 让下次激活时 token 开销更小、会话无缝续接。
	 *
	 * 注意：dispose 期间不再向 agent 发任何 prompt（旧版的 summarizeSelf 已删除），
	 * 避免一次额外的 LLM 往返拖慢回收。
	 */
	async dispose(): Promise<void> {
		try {
			const historySnapshot = this.agent.state.messages.slice();
			await this.history.save(historySnapshot);
			await this.history.archiveByDay(historySnapshot);
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
