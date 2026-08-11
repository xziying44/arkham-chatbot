import {
	type AgentMessage,
	type AgentTool,
	type Skill,
	type CompactionPreparation,
	type FileOperations,
	type ThinkingLevel,
	formatSkillsForSystemPrompt,
	Agent,
	type StreamFn,
	uuidv7,
	compact,
	estimateContextTokens,
	DEFAULT_COMPACTION_SETTINGS,
	createCompactionSummaryMessage,
	getOrUndefined,
} from "@earendil-works/pi-agent-core";
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
import type { PromptLoader } from "../prompts/prompt-loader.ts";
import type { ScopeKey } from "../identity/scope.ts";
import { scopeKeyStr } from "../identity/scope.ts";

/**
 * 压缩时保留的最近消息条数（原文不压缩）。
 *
 * 这个数字是「最近上下文窗口」：保留最近若干轮的精确对话，确保 agent 接续时
 * 能看到最近的工具调用结果和用户指令细节。其余历史压缩成摘要。
 * 经验值：覆盖最近 1-2 轮复杂工具调用（每轮 user+assistant+toolResult 约 3-5 条）。
 */
const RETAINED_TAIL_MESSAGES = 20;

/**
 * 运行中两次压缩之间至少要新增多少条消息。
 *
 * 防止 transformContext 在每个 turn 反复触发压缩（压缩本身要一次 LLM 调用，
 * 频繁压缩既慢又无意义——刚压完不可能立刻又超阈值）。只有消息数相对上次压缩
 * 又增长了这么多，才允许再压。
 */
const MIN_MESSAGES_BETWEEN_COMPACTIONS = 30;

/**
 * 运行中压缩触发阈值：估算 token 数占模型 contextWindow 的比例。
 *
 * 到 70% 才触发——留 30% 给本轮剩余的 assistant 输出 + 工具结果 + 下一轮 user 消息。
 * 太低（如 50%）会让中短会话也被频繁压缩，得不偿失；太高（如 90%）可能本轮就溢出。
 */
const RUNTIME_COMPACTION_THRESHOLD_RATIO = 0.7;

/**
 * 压缩时给 LLM 的额外指令（拼到 pi 默认摘要 prompt 之后）。
 *
 * pi 默认 prompt 是英文通用结构（Goal/Constraints/Progress/...）。
 * 这里追加群聊场景的重点，让摘要带上群员识别、制卡任务进展等本地化关键信息。
 */
const COMPACTION_CUSTOM_INSTRUCTIONS = [
	"重点关注：群员的稳定身份与 openid 关联、进行中的 DIY 卡牌任务（卡名/字段/状态）、",
	"用户明确表达的偏好与做事方式、群的整体约定。压缩掉的对话细节不必逐条保留，",
	"只要这些关键信息能被下次会话接住即可。",
].join("");

/** 判断一条消息是否是 compactionSummary（前次压缩的结果）。 */
function isCompactionSummary(m: AgentMessage): boolean {
	return typeof m === "object" && m !== null && (m as { role?: string }).role === "compactionSummary";
}

/** 若消息是 compactionSummary，提取其 summary 文本；否则返回 undefined。 */
function extractCompactionSummary(m: AgentMessage): string | undefined {
	if (isCompactionSummary(m)) {
		return (m as { summary?: string }).summary;
	}
	return undefined;
}

/**
 * 一个活跃会话的协调器：持有 pi Agent，装配工具，管理历史存取与会话压缩。
 *
 * 生命周期由 {@link SessionManager} 驱动：
 * - 激活（activate）：读历史（含 compactionSummary 消息）→ 建 Agent → 进入可对话状态。
 * - 对话（prompt）：把群成员消息喂给 Agent，收集流式输出拼成回复。
 * - 回收（dispose）：用 pi 的 compact() 把历史压缩成 [compactionSummary, ...retainedTail]
 *   落盘 → 下次激活以压缩后上下文续接，token 开销小且无缝继续。
 * - 运行中：transformContext hook 在上下文超阈值时触发额外压缩，避免长会话撑爆 context。
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
	 * 提示词加载器（所有 scope 共享同一实例）。启动时已 load() 过 prompts/static/*.md。
	 * 热更新后同一实例会被 reload()，活跃会话重新激活即用新提示词。
	 */
	readonly promptLoader: PromptLoader;
	/**
	 * 共享的"当前被动消息 id"容器：prompt 时写入，工具执行期间读取。
	 * 由 SessionManager 创建，与 extraToolsFactory 共享同一引用。
	 */
	readonly replyToHolder?: { current?: string };
	/**
	 * 首条中间文字回调：agent 在第一个工具轮输出的文字（如「收到，开始做XX」）
	 * 立即通过此回调发给用户，作为收到指令后的即时反馈。**只发第一条**，后续工具轮
	 * 文字不再发（防一次制卡刷屏）。由 SessionManager 注入 adapter.sendText。
	 */
	readonly onFirstIntermediate?: (text: string) => void;
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
	 * 上一次运行中压缩完成时 agent.state.messages 的长度。
	 * 用于 transformContext 防止同一轮内重复压缩：只有 messages 又增长了
	 * 超过 MIN_MESSAGES_BETWEEN_COMPACTIONS 条才允许再压。
	 */
	private lastRuntimeCompactionLen: number | undefined;
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
		const systemPrompt = buildSystemPrompt(this.opts.promptLoader, {
			scopeName: this.opts.scopeName,
			scopeKind: this.opts.scope.kind,
			persona: this.opts.persona,
			skillsBlock: this.opts.skills?.length ? formatSkillsForSystemPrompt(this.opts.skills) : "",
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
			// 显式启用并行工具调用（pi-agent-core 默认即 parallel，显式声明更清晰）。
			// 让 agent 一轮里能并行调多个工具（如 load_skill + generate_image 同时），
			// 把多工具任务的往返轮次压到最少。
			toolExecution: "parallel",
			// 运行中上下文超阈值时触发压缩，避免长会话撑爆 context。
			// 压缩后直接 mutate agent.state.messages（持久化在 dispose 时由 history.save 落盘）。
			transformContext: async (messages) => this.runtimeCompactIfNeeded(messages),
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
		// 每次新 run 重置「上次运行中压缩位置」——允许本轮在 token 超阈值时压缩。
		this.lastRuntimeCompactionLen = undefined;
		// 记录 run 前的消息数，结束后把本轮新增的消息增量追加到 session.jsonl，
		// 这样即使进程被 kill，未触发 dispose 的对话也不会丢（dispose 时 history.save 仍会全量覆盖兜底）。
		const beforeLen = this.agent.state.messages.length;
		const collector = new AssistantTextCollector(this.opts.onFirstIntermediate);
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
	 * 回收：压缩历史 → 落盘 [compactionSummary, ...retainedTail] → 按天归档 → 释放 Agent。
	 *
	 * 用 pi-agent-core 的 compact() 把当前会话消息压缩成一份摘要 + 保留最近若干条原文。
	 * 下次激活时 session.jsonl 里的 compactionSummary 消息会被 Agent 的 convertToLlm
	 * 自动渲染成「<summary>...</summary>」注入上下文，实现无缝续接 + 低 token 开销。
	 *
	 * 增量压缩：若 session.jsonl 里已有 compactionSummary（前次压缩的结果），会作为
	 * previousSummary 传入 compact()，让新摘要并入旧摘要而非从零重写。
	 *
	 * 失败降级：compact() 出错（LLM 超时/拒绝等）→ 原样落盘当前消息（不压缩），
	 * 保证数据不丢，只是下次激活 token 多一些。
	 *
	 * 归档：archiveByDay 仍存原始消息（未压缩），供 agent 用 read 查阅完整历史对话。
	 */
	async dispose(): Promise<void> {
		try {
			const historySnapshot = this.agent.state.messages.slice();
			// 压缩后落盘（失败则原样落盘兜底）。
			const compacted = await this.compactHistory(historySnapshot).catch((e) => {
				console.warn(`[bot] compact 失败，原样落盘: ${(e as Error).message}`);
				return historySnapshot;
			});
			await this.history.save(compacted);
			// 归档用原始快照（未压缩），保留完整对话供 agent read 查阅。
			await this.history.archiveByDay(historySnapshot);
		} finally {
			this.agent.abort();
			await this.agent.waitForIdle().catch(() => {});
		}
	}

	/**
	 * 把当前消息列表压缩成 [compactionSummary, ...retainedTail]。
	 *
	 * 手建 CompactionPreparation（不用 prepareCompaction——那个依赖 session tree）：
	 * - messagesToSummarize：旧消息（不含 retainedTail）
	 * - retainedTail：最近 RETAINED_TAIL_MESSAGES 条原文（保证最近上下文精确）
	 * - previousSummary：若旧消息头部已是 compactionSummary，提取其 summary 做增量更新
	 * - fileOps：空集（agent 的 read/write 我们不在压缩层追踪，pi 会自行从消息里提取）
	 *
	 * 消息太少（≤ RETAINED_TAIL_MESSAGES）时不压缩，直接返回原列表——
	 * 短会话压缩得不偿失（一次 LLM 调用换不来 token 节省）。
	 *
	 * @returns 压缩后的消息列表（[compactionSummary, ...retainedTail]），或原列表（不压缩时）
	 */
	private async compactHistory(messages: AgentMessage[]): Promise<AgentMessage[]> {
		if (messages.length <= RETAINED_TAIL_MESSAGES) return messages;

		// 找到已有 compactionSummary（若有）→ 提取 previousSummary 做增量压缩。
		// 只看第一条消息：正常情况下压缩结果总是第一条是 compactionSummary。
		const previousSummary = extractCompactionSummary(messages[0]);

		// retainedTail 取最后 RETAINED_TAIL_MESSAGES 条；其余进 messagesToSummarize。
		const cutIdx = messages.length - RETAINED_TAIL_MESSAGES;
		const messagesToSummarize = messages.slice(0, cutIdx);
		const retainedTail = messages.slice(cutIdx);

		// 从 messagesToSummarize 里剔除已有的 compactionSummary（避免把旧摘要文本再喂给 LLM）。
		const toSummarizeClean = messagesToSummarize.filter((m) => !isCompactionSummary(m));
		if (toSummarizeClean.length === 0) return messages;

		const tokensBefore = estimateContextTokens(messages).tokens;
		const fileOps: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
		const preparation: CompactionPreparation = {
			firstKeptEntryId: uuidv7(),
			messagesToSummarize: toSummarizeClean,
			turnPrefixMessages: [],
			retainedTail,
			isSplitTurn: false,
			tokensBefore,
			previousSummary,
			fileOps,
			settings: DEFAULT_COMPACTION_SETTINGS,
		};

		const result = await compact(
			preparation,
			this.opts.models,
			this.opts.model,
			COMPACTION_CUSTOM_INSTRUCTIONS,
			undefined, // signal：dispose 不接受外部取消
			(this.opts.thinkingLevel ?? "off") as ThinkingLevel,
		);
		const compacted = getOrUndefined(result);
		if (!compacted) {
			// Result 是 err 分支——抛出让 dispose 的 catch 走原样落盘兜底。
			const reason = result.ok ? "" : result.error.message;
			throw new Error(`compact 返回错误: ${reason}`);
		}
		// 落盘形态：[compactionSummary, ...retainedTail]。
		// timestamp 用 ISO 字符串（createCompactionSummaryMessage 签名要求 string）。
		return [
			createCompactionSummaryMessage(compacted.summary, compacted.tokensBefore, new Date().toISOString()),
			...retainedTail,
		];
	}

	/**
	 * transformContext hook：运行中检测上下文是否超阈值，超了就压缩并 mutate agent 状态。
	 *
	 * pi-agent-core 的 transformContext 只转换「本次 LLM 调用用的 messages」，
	 * 不会把结果写回 agent.state.messages。所以这里压缩完要**显式赋值回 state.messages**，
	 * 否则下一轮 transformContext 又看到原始长消息，会无限重压。
	 *
	 * 触发条件（全部满足才压）：
	 * - 消息数 > RETAINED_TAIL_MESSAGES（否则压不出东西）
	 * - 估算 token ≥ contextWindow × RUNTIME_COMPACTION_THRESHOLD_RATIO
	 * - 距上次运行中压缩又增长了 ≥ MIN_MESSAGES_BETWEEN_COMPACTIONS 条（防同轮反复压）
	 *
	 * 失败降级：压缩出错 → 记日志，返回原 messages（本轮不压，下一轮再试）。
	 *
	 * @returns 供本次 LLM 调用使用的 messages（压缩后或原样）
	 */
	private async runtimeCompactIfNeeded(messages: AgentMessage[]): Promise<AgentMessage[]> {
		// 消息太少，不压。
		if (messages.length <= RETAINED_TAIL_MESSAGES) return messages;
		// 距上次运行中压缩增长不足，跳过（防同轮反复压）。
		if (
			this.lastRuntimeCompactionLen !== undefined &&
			messages.length - this.lastRuntimeCompactionLen < MIN_MESSAGES_BETWEEN_COMPACTIONS
		) {
			return messages;
		}
		// 估算 token 占比未到阈值，跳过。
		const tokens = estimateContextTokens(messages).tokens;
		const threshold = Math.floor(this.opts.model.contextWindow * RUNTIME_COMPACTION_THRESHOLD_RATIO);
		if (tokens < threshold) return messages;

		console.log(`[bot] 运行中压缩触发 scope=${this.opts.scope.kind}:${this.opts.scope.id} tokens=${tokens}/${this.opts.model.contextWindow} msgs=${messages.length}`);
		let compacted: AgentMessage[];
		try {
			compacted = await this.compactHistory(messages);
		} catch (e) {
			console.warn(`[bot] 运行中压缩失败，本轮跳过: ${(e as Error).message}`);
			return messages;
		}
		// 压缩没产生变化（compactHistory 返回原列表）→ 不动状态。
		if (compacted === messages || compacted.length >= messages.length) return messages;
		// 关键：把压缩结果写回 agent 状态，让后续轮次和 dispose 看到压缩后的历史。
		// agent.state.messages 是公开 setter（pi 文档：「copies the provided top-level array」）。
		this.agent.state.messages = compacted;
		this.lastRuntimeCompactionLen = compacted.length;
		// 返回压缩后的消息供本次 LLM 调用使用。
		return compacted;
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
 * 收集 agent 的 assistant 文本，拼成最终回复；并在首个工具轮文字时给即时反馈。
 *
 * 设计（兼顾「即时反馈」「不刷屏」「回复干净」）：
 * - **首条中间文字立即发**：agent 在第一个工具轮（stopReason=toolUse）输出的文字，
 *   通过 onFirstIntermediate 回调立即发给用户——即时反馈。只发第一条。
 * - **后续中间文字丢弃**：第二个及以后的工具轮文字**直接扔掉**，不攒、不发。
 *   这些是 agent 的思考碎屑（如「整理一下用户提供的信息」「让我看看现有示例」），
 *   用户不需要看到，更不能拼进最终回复（否则回复会变成所有思考的拼接，又长又乱）。
 * - **最终轮文字作为回复**：最后一轮（stopReason=stop/length）的文字进 finalParts，
 *   作为 runPrompt 的返回值（最终回复）。如果 agent 调了 send_message，这条会被
 *   router 跳过（messageSentThisRun=true → 返回空）。
 *
 * 结果：单次请求 ≤2 条消息——首条即时反馈（首工具轮）+ 最终结果（最终轮或 send_message）。
 * 中间所有思考碎屑对用户不可见。
 *
 * 注意：pi 的事件流里，message_update 携带当前 partial；我们只在 message_end
 * （assistant 消息完成）时取该条消息的完整文本，避免拼接流式增量造成重复。
 */
class AssistantTextCollector {
	private finalParts: string[] = [];
	private firstIntermediateSent = false;

	constructor(private readonly onFirstIntermediate?: (text: string) => void) {}

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

		if (message.stopReason === "toolUse") {
			// 工具轮文字：第一条发给用户（即时反馈），后续直接丢弃（不攒不发——
			// 它们是思考碎屑，拼进回复会让回复变成所有思考的杂乱拼接）。
			if (!this.firstIntermediateSent && this.onFirstIntermediate) {
				this.firstIntermediateSent = true;
				this.onFirstIntermediate(chunk);
			}
			return;
		}
		// 最终轮（stop/length）的文字 → 作为回复内容。
		this.finalParts.push(chunk);
	};

	get text(): string {
		return this.finalParts.join("").trim();
	}
}
