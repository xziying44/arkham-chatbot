import type { AgentMessage, AgentTool, Skill } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { mkdir } from "node:fs/promises";
import { ChatBotSession } from "../agent/bot-session.ts";
import type { PendingAskHolder } from "../tools/ask-user.ts";
import type { PromptLoader } from "../prompts/prompt-loader.ts";
import type { ScopeKey } from "../identity/scope.ts";
import { scopeKeyStr } from "../identity/scope.ts";
import type { IncomingMessage, OutgoingMessage } from "./message.ts";
import { TranscriptStore } from "./transcript-store.ts";
import { Semaphore } from "./semaphore.ts";

/** 默认每群最大并发 agent run 数。超出排队，避免 N 人同时发指令打爆 LLM 端点。 */
const DEFAULT_GROUP_MAX_CONCURRENT = 3;

/**
 * envFactory 收到的会话路径上下文。
 *
 * server 侧据此组装沙箱挂载（哪些宿主目录映射进沙箱 workspace）。
 * 群成员与私聊的路径布局不同，统一用一个上下文对象传，比多个位置参数清晰。
 */
export interface SessionEnvContext {
	readonly scope: ScopeKey;
	/** 群成员会话的成员 openid（私聊 undefined）。 */
	readonly memberId?: string;
	/** 沙箱工作目录绝对路径（cwd）。 */
	readonly workspaceDir: string;
	/** session.jsonl + history/ 归档所在的宿主目录。 */
	readonly sessionDir: string;
	/** 记忆目录的宿主绝对路径（群级共享或私聊自己的）。沙箱挂载到 workspace/memories。 */
	readonly memoriesDir: string;
	/** 群共享 transcript.jsonl 的宿主绝对路径（仅群聊）。沙箱挂载到 workspace/group-feed.jsonl。 */
	readonly transcriptPath?: string;
	/** 群共享卡牌库目录（仅群聊）。制卡是群活动，新旧卡统一存这里，全群可读可发。沙箱 rw-bind 到 workspace/cards。 */
	readonly cardsDir?: string;
	/** 群共享文生图目录（仅群聊）。插画全群复用，避免重复生图。沙箱 rw-bind 到 workspace/generated。 */
	readonly generatedDir?: string;
}

/** 附件下载入参（url/filename/contentType）。 */
export interface AttachmentRef {
	readonly url: string;
	readonly filename: string;
	readonly contentType: string;
}

/**
 * 会话池配置。
 */
export interface SessionManagerOptions {
	/** 根数据目录。 */
	readonly dataDir: string;
	/** LLM 模型。 */
	readonly model: Model<any>;
	/** pi-ai 的 Models 注册表（用于记忆摘要）。 */
	readonly models: Models;
	/** 流式调用函数，通常为 `models.streamSimple.bind(models)`。 */
	readonly streamFn: StreamFn;
	/** 为每个会话创建沙箱执行环境（注入 cwd + 挂载）。 */
	readonly envFactory: (ctx: SessionEnvContext) => ExecutionEnv | Promise<ExecutionEnv>;
	/** 无活动回收阈值（毫秒），默认 1 小时。 */
	readonly ttlMs?: number;
	/** 回收器扫描间隔（毫秒），默认 1 分钟。 */
	readonly reaperIntervalMs?: number;
	/** 每群最大并发 agent run 数（默认 3）。超出排队。 */
	readonly groupMaxConcurrent?: number;
	/** 思考程度: off/low/medium/high/max。传给 Agent 控制思考开关与强度。 */
	readonly thinkingLevel?: string;
	/** 机器人人设（所有会话共享）。 */
	readonly persona?: string;
	/** 已加载的技能清单（所有会话共享，filePath 已重写为沙箱内路径）。 */
	readonly skills?: Skill[];
	/** 提示词加载器（所有会话共享）。启动时已 load() 过 prompts/static/*.md。 */
	readonly promptLoader: PromptLoader;
	/**
	 * 按会话生成额外工具（如 send_image、ask_user）。每次激活调用一次。
	 * 注意：工具对外的「发送」目标始终是 scope（群或私聊），与 memberId 无关——
	 * 群成员会话里 agent 发消息仍是发到群里，因此 factory 拿到的还是 scope。
	 */
	readonly extraToolsFactory?: (
		scope: ScopeKey,
		getReplyToMsgId: () => string | undefined,
		workspaceDir: string,
		pendingAskHolder: PendingAskHolder,
	) => AgentTool[];
	/**
	 * 发送消息回调。agent 调 send_message 时触发。目标 = scope（群/私聊）。
	 */
	readonly onSendMessage?: (scope: ScopeKey, text: string, replyToMessageId?: string) => Promise<void>;
	/**
	 * 下载附件回调。群聊传 memberId（下载到该成员 workspace/inbox）；私聊 memberId 为 undefined。
	 * 返回相对于该会话 workspace 的路径（如 "inbox/1234_photo.jpg"）。
	 */
	readonly onAttachment?: (scope: ScopeKey, memberId: string | undefined, attachment: AttachmentRef) => Promise<string>;
}

interface ActiveEntry {
	readonly session: ChatBotSession;
	/** 该会话的挂起提问容器（ask_user 工具与 prompt/dispatchInteraction 共享）。 */
	readonly pendingAskHolder: PendingAskHolder;
	lastActivityAt: number;
	/** 回收定时器。 */
	reaper: ReturnType<typeof setTimeout>;
	/** 群成员会话的成员 openid（私聊 undefined）。 */
	readonly memberId?: string;
	/** 群成员会话所属的群上下文（私聊 undefined）。 */
	readonly groupCtx?: GroupContext;
}

/** 群级共享资源：transcript（全群只读记录）+ 共享记忆/卡牌库/生图 + 并发信号量。 */
interface GroupContext {
	readonly groupId: string;
	readonly groupDir: string;
	readonly memoriesDir: string;
	/** 群共享卡牌库（render_card 写这里，全群可读可发）。 */
	readonly cardsDir: string;
	/** 群共享文生图（插画全群复用）。 */
	readonly generatedDir: string;
	readonly transcript: TranscriptStore;
	readonly semaphore: Semaphore;
	lastActivityAt: number;
}

/**
 * 管理所有活跃会话的 ChatBotSession 实例。
 *
 * **每成员智能体模型（群聊）**：一个群里每个成员有自己独立的 agent 会话，互不串行——
 * 多人同时发指令可并行处理。各成员会话共享：
 * - 群级 `memories/`（读写，记忆全群可见）
 * - 群级 `transcript.jsonl`（只读，agent 按需查阅其他成员和机器人的对话）
 * 群内并发由 {@link GroupContext.semaphore} 把关（默认 3），超出排队。
 *
 * **私聊**：一人一会话，行为不变。
 *
 * 其它职责：按需激活、TTL 回收、断电续传（session.jsonl）。
 */
export class SessionManager {
	private readonly opts: Required<Omit<SessionManagerOptions, "persona" | "thinkingLevel" | "skills" | "envFactory" | "model" | "models" | "streamFn" | "extraToolsFactory" | "onSendMessage" | "onAttachment">> &
		Pick<SessionManagerOptions, "persona" | "thinkingLevel" | "skills" | "promptLoader" | "envFactory" | "model" | "models" | "streamFn" | "extraToolsFactory" | "onSendMessage" | "onAttachment">;
	/** 活跃会话池。key：私聊 `user:<id>`；群成员 `group:<groupId>:<memberId>`。 */
	private readonly active = new Map<string, ActiveEntry>();
	/** 群级上下文（transcript + 记忆 + 信号量）。key: groupId。 */
	private readonly groups = new Map<string, GroupContext>();
	private reaperTimer: ReturnType<typeof setInterval> | undefined;
	private shuttingDown = false;

	constructor(opts: SessionManagerOptions) {
		this.opts = {
			dataDir: opts.dataDir,
			model: opts.model,
			models: opts.models,
			streamFn: opts.streamFn,
			envFactory: opts.envFactory,
			ttlMs: opts.ttlMs ?? 3_600_000,
			reaperIntervalMs: opts.reaperIntervalMs ?? 60_000,
			groupMaxConcurrent: opts.groupMaxConcurrent ?? DEFAULT_GROUP_MAX_CONCURRENT,
			thinkingLevel: opts.thinkingLevel,
			persona: opts.persona,
			skills: opts.skills,
			promptLoader: opts.promptLoader,
			extraToolsFactory: opts.extraToolsFactory,
			onSendMessage: opts.onSendMessage,
			onAttachment: opts.onAttachment,
		};
	}

	/** 启动后台回收扫描器。 */
	start(): void {
		if (this.reaperTimer) return;
		this.reaperTimer = setInterval(() => void this.reap(), this.opts.reaperIntervalMs);
	}

	/**
	 * 热更新技能清单：替换 opts.skills（影响新激活的会话）。
	 * 调用方应在调此方法后 reapAll，让活跃会话下次消息重新激活。
	 */
	updateSkills(skills: Skill[]): void {
		(this.opts as { skills?: Skill[] }).skills = skills;
	}

	/**
	 * 路由一条入站消息到对应会话，返回出站回复。
	 *
	 * - 群聊：路由到 (group, senderId) 的成员会话；多人同时发指令并行处理（群内并发上限把关）。
	 *   同一成员的多条快速消息：第一条开 run，后续 steer 进去合并（同成员串行）。
	 * - 私聊：路由到 (user) 会话，行为同前。
	 */
	async dispatch(message: IncomingMessage & { attachments?: readonly AttachmentRef[] }): Promise<OutgoingMessage> {
		if (this.shuttingDown) {
			return { text: "（服务正在关闭，暂时无法处理消息。）" };
		}
		// 处理附件：下载图片到该会话 workspace/inbox/，把路径信息拼到 text 里让 agent 知道。
		let text = message.text;
		if (message.attachments?.length && this.opts.onAttachment) {
			const memberId = message.scope.kind === "group" ? message.senderId : undefined;
			const imageAttachments = message.attachments.filter((a) => a.contentType.startsWith("image/"));
			for (const att of imageAttachments) {
				try {
					const relPath = await this.opts.onAttachment(message.scope, memberId, att);
					text += `\n[用户发来一张图片：已保存到 ${relPath}]`;
				} catch (e) {
					console.warn(`[session] 下载附件失败: ${(e as Error).message}`);
					text += `\n[用户发来一张图片，但下载失败]`;
				}
			}
		}

		if (message.scope.kind === "group") {
			return this.dispatchGroup(message, text);
		}
		return this.dispatchUser(message, text);
	}

	/** 私聊路径：一人一会话。 */
	private async dispatchUser(message: IncomingMessage & { attachments?: readonly AttachmentRef[] }, text: string): Promise<OutgoingMessage> {
		const entry = await this.getOrCreateUser(message.scope);
		entry.lastActivityAt = Date.now();
		this.resetReaper(entry);
		const result = await entry.session.prompt({
			text,
			senderId: message.senderId,
			senderName: message.senderName,
			platformMessageId: message.platformMessageId,
		});
		return { text: result.text, replyToMessageId: result.replyToMessageId };
	}

	/**
	 * 群聊路径：每成员一会话。
	 *
	 * 1. 入站消息（含附件标注）写入群 transcript——格式同 agent 看到的 `[memberId]: text`。
	 * 2. 成员会话 busy（已有 in-flight run）→ prompt 内部 steer 合并（同成员串行）。
	 * 3. 成员会话 idle → 群信号量 acquire（满则排队）→ prompt → release（并发上限把关）。
	 *
	 * 机器人回复由 ChatBotSession.runPrompt 一轮结束后追加进 transcript，不在本方法写。
	 */
	private async dispatchGroup(message: IncomingMessage & { attachments?: readonly AttachmentRef[] }, text: string): Promise<OutgoingMessage> {
		const memberId = message.senderId;
		const groupCtx = await this.getOrCreateGroup(message.scope);
		// 入站 user 消息写入群 transcript（每条都写，含被 steer 的情况）。
		const formatted = `[${memberId}]: ${text}`;
		await groupCtx.transcript.append([{ role: "user", content: formatted, timestamp: Date.now() }]).catch(() => {});

		const entry = await this.getOrCreateMember(message.scope, groupCtx, memberId);
		entry.lastActivityAt = Date.now();
		groupCtx.lastActivityAt = Date.now();
		this.resetReaper(entry);

		const payload = {
			text,
			senderId: memberId,
			senderName: message.senderName,
			platformMessageId: message.platformMessageId,
		};
		let result;
		if (entry.session.isBusy) {
			// 同成员已有 in-flight run → steer 合并（不占群并发名额）。
			result = await entry.session.prompt(payload);
		} else {
			// idle → 群并发信号量把关。acquire 满则排队等空位。
			await groupCtx.semaphore.acquire();
			try {
				result = await entry.session.prompt(payload);
			} finally {
				groupCtx.semaphore.release();
			}
		}
		return { text: result.text, replyToMessageId: result.replyToMessageId };
	}

	/**
	 * 处理按钮点击回调（INTERACTION_CREATE）。
	 *
	 * 群聊：按 (group, memberId) 找到点击者的成员会话，resolve 其挂起提问。
	 * 私聊：按 (user) 找。没有挂起提问（乱点过期按钮）则静默忽略。
	 */
	dispatchInteraction(scope: ScopeKey, callback: { interactionId: string; buttonData?: string; buttonId?: string }, memberId?: string): void {
		const key = this.entryKey(scope, memberId);
		const entry = this.active.get(key);
		const pending = entry?.pendingAskHolder.current;
		if (pending) {
			pending.resolve(callback.buttonData ?? callback.buttonId ?? "unknown");
		}
	}

	/** 关闭所有会话：回收落盘，停止扫描器。 */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.reaperTimer) {
			clearInterval(this.reaperTimer);
			this.reaperTimer = undefined;
		}
		await Promise.all(
			Array.from(this.active.values()).map((entry) =>
				this.reapEntry(entry).catch(() => {}),
			),
		);
		this.groups.clear();
	}

	/** 统一的 entry key：私聊 `user:<id>`；群成员 `group:<id>:<memberId>`。 */
	private entryKey(scope: ScopeKey, memberId?: string): string {
		return scope.kind === "group" ? `group:${scope.id}:${memberId ?? ""}` : scopeKeyStr(scope);
	}

	/** 取或建群上下文（transcript + 共享记忆 + 信号量）。 */
	private async getOrCreateGroup(scope: ScopeKey): Promise<GroupContext> {
		const existing = this.groups.get(scope.id);
		if (existing) return existing;
		const groupDir = `${this.opts.dataDir}/group/${scope.id}`;
		const memoriesDir = `${groupDir}/memories`;
		const cardsDir = `${groupDir}/cards`;
		const generatedDir = `${groupDir}/generated`;
		// 提前建好群级共享目录：成员会话 envFactory 会把它们可读写挂载进沙箱，
		// 挂载源必须先存在（bwrap --bind / 开发 symlink 都要求源路径存在）。
		// - memories：群共享记忆（全群读写同一份）
		// - cards：群共享卡牌库（制卡是群活动，新旧卡统一存这里，全群可读可发可改）
		// - generated：群共享文生图（插画全群复用，避免重复生图）
		await mkdir(memoriesDir, { recursive: true });
		await mkdir(cardsDir, { recursive: true });
		await mkdir(generatedDir, { recursive: true });
		const ctx: GroupContext = {
			groupId: scope.id,
			groupDir,
			memoriesDir,
			cardsDir,
			generatedDir,
			transcript: new TranscriptStore(groupDir),
			semaphore: new Semaphore(this.opts.groupMaxConcurrent),
			lastActivityAt: Date.now(),
		};
		this.groups.set(scope.id, ctx);
		return ctx;
	}

	/** 取或建私聊会话。 */
	private async getOrCreateUser(scope: ScopeKey): Promise<ActiveEntry> {
		const key = scopeKeyStr(scope);
		const existing = this.active.get(key);
		if (existing) return existing;
		const sessionDir = `${this.opts.dataDir}/user/${scope.id}`;
		const workspaceDir = `${sessionDir}/workspace`;
		const entry = await this.createSession({
			scope,
			sessionDir,
			memoriesDir: `${workspaceDir}/memories`,
			workspaceDir,
		});
		this.active.set(key, entry);
		return entry;
	}

	/** 取或建群成员会话（共享群上下文的 transcript + memories）。 */
	private async getOrCreateMember(scope: ScopeKey, groupCtx: GroupContext, memberId: string): Promise<ActiveEntry> {
		const key = this.entryKey(scope, memberId);
		const existing = this.active.get(key);
		if (existing) return existing;
		const sessionDir = `${groupCtx.groupDir}/members/${memberId}`;
		const workspaceDir = `${sessionDir}/workspace`;
		const entry = await this.createSession({
			scope,
			memberId,
			sessionDir,
			memoriesDir: groupCtx.memoriesDir,
			cardsDir: groupCtx.cardsDir,
			generatedDir: groupCtx.generatedDir,
			workspaceDir,
			transcript: groupCtx.transcript,
			groupCtx,
		});
		this.active.set(key, entry);
		return entry;
	}

	/** 共享的 ChatBotSession 构造（私聊 / 群成员都走这里，差别在路径与 transcript）。 */
	private async createSession(args: {
		scope: ScopeKey;
		memberId?: string;
		sessionDir: string;
		memoriesDir: string;
		/** 群共享卡牌库目录（仅群聊）。私聊 undefined → 卡片留在自己 workspace。 */
		cardsDir?: string;
		/** 群共享文生图目录（仅群聊）。 */
		generatedDir?: string;
		workspaceDir: string;
		transcript?: TranscriptStore;
		groupCtx?: GroupContext;
	}): Promise<ActiveEntry> {
		const { scope, memberId, sessionDir, memoriesDir, cardsDir, generatedDir, workspaceDir, transcript, groupCtx } = args;
		const env = await this.opts.envFactory({
			scope,
			memberId,
			workspaceDir,
			sessionDir,
			memoriesDir,
			transcriptPath: transcript?.path,
			cardsDir,
			generatedDir,
		});
		// 共享 holder：factory 创建的工具读它，ChatBotSession.prompt 写它。
		const replyToHolder: { current?: string } = {};
		// 挂起提问容器：ask_user 工具写，dispatchInteraction（点按钮）/ prompt（发文字）读。
		const pendingAskHolder: PendingAskHolder = {};
		const extraTools = this.opts.extraToolsFactory?.(scope, () => replyToHolder.current, workspaceDir, pendingAskHolder) ?? [];
		const session = new ChatBotSession({
			scope,
			scopeName: scope.id,
			sessionDir,
			memoriesDir,
			memberId,
			transcript,
			model: this.opts.model,
			models: this.opts.models,
			streamFn: this.opts.streamFn,
			env,
			thinkingLevel: this.opts.thinkingLevel,
			persona: this.opts.persona,
			skills: this.opts.skills,
			promptLoader: this.opts.promptLoader,
			extraTools,
			replyToHolder,
			pendingAskHolder,
			onSendMessage: this.opts.onSendMessage
				? async (text: string) => this.opts.onSendMessage!(scope, text, replyToHolder.current)
				: undefined,
		});
		await session.activate();

		const entry: ActiveEntry = {
			session,
			pendingAskHolder,
			lastActivityAt: Date.now(),
			reaper: undefined as unknown as ReturnType<typeof setTimeout>,
			memberId,
			groupCtx,
		};
		this.resetReaper(entry);
		return entry;
	}

	private resetReaper(entry: ActiveEntry): void {
		if (entry.reaper) clearTimeout(entry.reaper);
		entry.reaper = setTimeout(() => {
			void this.reapEntry(entry).catch(() => {});
		}, this.opts.ttlMs);
	}

	/** 回收一个 entry：落盘、销毁 Agent、移出池。群成员全退则清群上下文。 */
	private async reapEntry(entry: ActiveEntry): Promise<void> {
		let key: string | undefined;
		for (const [k, v] of this.active) {
			if (v === entry) {
				key = k;
				break;
			}
		}
		if (key === undefined) return;
		this.active.delete(key);
		if (entry.reaper) clearTimeout(entry.reaper);

		await entry.session.dispose();

		// 群成员：若该群已无活跃成员会话，清群上下文（释放 transcript/信号量引用）。
		if (entry.groupCtx) {
			const groupId = entry.groupCtx.groupId;
			const stillActive = Array.from(this.active.keys()).some((k) => k.startsWith(`group:${groupId}:`));
			if (!stillActive) this.groups.delete(groupId);
		}
	}

	/** 扫描所有活跃 entry，回收超时者（双重保险：定时器 + 扫描）。 */
	private async reap(): Promise<void> {
		const now = Date.now();
		for (const entry of Array.from(this.active.values())) {
			if (now - entry.lastActivityAt >= this.opts.ttlMs) {
				await this.reapEntry(entry).catch(() => {});
			}
		}
	}

	/** 仅测试用：当前活跃会话数（含群成员会话）。 */
	get activeCount(): number {
		return this.active.size;
	}

	/**
	 * 列出当前活跃会话的运行时信息（管理端「会话」视图用）。
	 * 群成员会话带 memberId。
	 */
	listActiveScopes(): ActiveScopeInfo[] {
		const now = Date.now();
		const out: ActiveScopeInfo[] = [];
		for (const [key, entry] of this.active) {
			out.push({
				key,
				scope: entry.session.scope,
				memberId: entry.memberId,
				lastActivityAt: entry.lastActivityAt,
				ttlRemainingMs: Math.max(0, this.opts.ttlMs - (now - entry.lastActivityAt)),
				messageCount: entry.session.messages.length,
			});
		}
		return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
	}

	/**
	 * 取某会话的详情：系统提示词 + 工具描述符 + 最近 N 条消息。
	 * 群聊需传 memberId 定位到具体成员会话；不传则群聊返回 undefined。
	 */
	getScopeDetail(scope: ScopeKey, memberId?: string, recentMessageLimit = 20): ActiveScopeDetail | undefined {
		const entry = this.active.get(this.entryKey(scope, memberId));
		if (!entry) return undefined;
		const messages = entry.session.messages;
		return {
			scope: entry.session.scope,
			memberId: entry.memberId,
			systemPrompt: entry.session.systemPrompt,
			tools: entry.session.toolDescriptors,
			messages: messages.slice(Math.max(0, messages.length - recentMessageLimit)),
			messageCount: messages.length,
			lastActivityAt: entry.lastActivityAt,
		};
	}

	/**
	 * 强制回收一个会话（管理端「强制回收」按钮）。群聊需传 memberId。
	 */
	async forceReap(scope: ScopeKey, memberId?: string): Promise<boolean> {
		const entry = this.active.get(this.entryKey(scope, memberId));
		if (!entry) return false;
		await this.reapEntry(entry).catch(() => {});
		return true;
	}

	/** 回收所有活跃会话（改 LLM 端点后强制应用新模型用）。 */
	async reapAll(): Promise<number> {
		const entries = Array.from(this.active.values());
		await Promise.all(entries.map((e) => this.reapEntry(e).catch(() => {})));
		return entries.length;
	}
}

/** 活跃会话的运行时摘要（listActiveScopes 返回）。 */
export interface ActiveScopeInfo {
	readonly key: string;
	readonly scope: ScopeKey;
	/** 群成员会话的成员 openid（私聊 undefined）。 */
	readonly memberId?: string;
	readonly lastActivityAt: number;
	readonly ttlRemainingMs: number;
	readonly messageCount: number;
}

/** 活跃会话的详情（getScopeDetail 返回）。 */
export interface ActiveScopeDetail {
	readonly scope: ScopeKey;
	readonly memberId?: string;
	readonly systemPrompt: string;
	readonly tools: { name: string; description: string }[];
	readonly messages: AgentMessage[];
	readonly messageCount: number;
	readonly lastActivityAt: number;
}
