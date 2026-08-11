import type { AgentMessage, AgentTool, Skill } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { ChatBotSession } from "../agent/bot-session.ts";
import type { PendingAskHolder } from "../tools/ask-user.ts";
import type { PromptLoader } from "../prompts/prompt-loader.ts";
import type { ScopeKey } from "../identity/scope.ts";
import { scopeKeyStr } from "../identity/scope.ts";
import type { IncomingMessage, OutgoingMessage } from "./message.ts";

/**
 * 会话池配置。
 */
export interface SessionManagerOptions {
	/** 根数据目录。每 scope 在其下建 `<kind>/<id>/` 子目录。 */
	readonly dataDir: string;
	/** LLM 模型。 */
	readonly model: Model<any>;
	/** pi-ai 的 Models 注册表（用于记忆摘要）。 */
	readonly models: Models;
	/** 流式调用函数，通常为 `models.streamSimple.bind(models)`。 */
	readonly streamFn: StreamFn;
	/** 为每个 scope 创建沙箱执行环境（注入 cwd）。 */
	readonly envFactory: (scope: ScopeKey, workspaceDir: string, scopeDir: string) => ExecutionEnv | Promise<ExecutionEnv>;
	/** 无活动回收阈值（毫秒），默认 1 小时。 */
	readonly ttlMs?: number;
	/** 回收器扫描间隔（毫秒），默认 1 分钟。 */
	readonly reaperIntervalMs?: number;
	/** 思考程度: off/low/medium/high/max。传给 Agent 控制思考开关与强度。 */
	readonly thinkingLevel?: string;
	/** 机器人人设（所有 scope 共享）。 */
	readonly persona?: string;
	/** 已加载的技能清单（所有 scope 共享，filePath 已重写为沙箱内路径）。 */
	readonly skills?: Skill[];
	/** 提示词加载器（所有 scope 共享）。启动时已 load() 过 prompts/static/*.md。 */
	readonly promptLoader: PromptLoader;
	/**
	 * 按 scope 生成额外工具（如 send_image、ask_user）。每个 scope 激活时调用一次，
	 * 返回的工具会与默认 bash/read/edit/write 一起装入 Agent。
	 * getReplyToMsgId 返回当前被动消息 id（工具执行期间有值），供需要被动回复引用的工具使用。
	 * workspaceDir 为该 scope 的沙箱工作目录绝对路径，供需要做路径边界检查的工具使用。
	 * pendingAskHolder 为该 scope 的挂起提问容器，ask_user 工具与 prompt 共享。
	 */
	readonly extraToolsFactory?: (
		scope: ScopeKey,
		getReplyToMsgId: () => string | undefined,
		workspaceDir: string,
		pendingAskHolder: PendingAskHolder,
	) => AgentTool[];
	/**
	 * 发送消息回调。agent 调用 send_message 工具时触发。
	 * agent 的文字输出不自动发送，只有主动调用 send_message 才发送。
	 */
	readonly onSendMessage?: (scope: ScopeKey, text: string, replyToMessageId?: string) => Promise<void>;
	/**
	 * 下载附件回调。收到带图片的消息时调用，把附件下载到 scope 的 workspace/inbox/，
	 * 返回相对于 workspace 的路径（如 "inbox/1234_photo.jpg"）。
	 * 由 server 注入 adapter.downloadAttachment + 文件写入逻辑。
	 */
	readonly onAttachment?: (scope: ScopeKey, attachment: { url: string; filename: string; contentType: string }) => Promise<string>;
}

interface ActiveEntry {
	readonly session: ChatBotSession;
	/** 该 scope 的挂起提问容器（ask_user 工具与 prompt/dispatchInteraction 共享）。 */
	readonly pendingAskHolder: PendingAskHolder;
	lastActivityAt: number;
	/** 回收定时器。 */
	reaper: ReturnType<typeof setTimeout>;
}

/**
 * 管理所有活跃 scope 的 ChatBotSession 实例，实现：
 * 1. **按需激活**：首次收到某 scope 消息时建 Agent（加载历史）。
 * 2. **串行处理**：同一 scope 的消息串行 prompt（pi Agent 不可重入）。
 * 3. **TTL 回收**：某 scope 超过 ttlMs 无新消息 → 落盘历史 + 销毁 Agent，仅保留磁盘数据。
 * 4. **断电续传**：磁盘上的 session.jsonl 让下次激活恢复上下文（增量落盘 + dispose 全量兜底）。
 */
export class SessionManager {
	private readonly opts: Required<Omit<SessionManagerOptions, "persona" | "thinkingLevel" | "skills" | "envFactory" | "model" | "models" | "streamFn" | "extraToolsFactory" | "onSendMessage" | "onAttachment">> &
		Pick<SessionManagerOptions, "persona" | "thinkingLevel" | "skills" | "promptLoader" | "envFactory" | "model" | "models" | "streamFn" | "extraToolsFactory" | "onSendMessage" | "onAttachment">;
	private readonly active = new Map<string, ActiveEntry>();
	private reaperTimer: ReturnType<typeof setInterval> | undefined;
	private shuttingDown = false;

	constructor(opts: SessionManagerOptions) {
		const ttlMs = opts.ttlMs ?? 3_600_000;
		this.opts = {
			dataDir: opts.dataDir,
			model: opts.model,
			models: opts.models,
			streamFn: opts.streamFn,
			envFactory: opts.envFactory,
			ttlMs,
			reaperIntervalMs: opts.reaperIntervalMs ?? 60_000,
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
	 *
	 * 已激活的会话不会立即用新技能（Agent 已构建、systemPrompt 已烘焙）。
	 * 调用方（BotManager.reloadSkills）应在调此方法后 reapAll，让活跃会话下次消息重新激活。
	 */
	updateSkills(skills: Skill[]): void {
		(this.opts as { skills?: Skill[] }).skills = skills;
	}

	/**
	 * 路由一条入站消息到对应 scope 的会话，返回出站回复。
	 *
	 * 群聊消息合并语义（见 ChatBotSession.prompt）：
	 * - agent 空闲 → 开新 run，回复引用本条消息。
	 * - agent 忙 → steer 注入（mode=all），等当前 run 结束，回复引用触发 run 的消息。
	 * 因此多条快速连发的群消息，只在首条开 run，后续 steer 进去批量合并，
	 * 一次 LLM 调用看到所有新消息统一回应——贴近群聊体感。
	 */
	async dispatch(message: IncomingMessage & { attachments?: readonly { url: string; filename: string; contentType: string }[] }): Promise<OutgoingMessage> {
		if (this.shuttingDown) {
			return { text: "（服务正在关闭，暂时无法处理消息。）" };
		}
		const entry = await this.getOrCreate(message.scope);
		entry.lastActivityAt = Date.now();
		// 刷新回收定时器：有新消息则推迟回收。
		this.resetReaper(entry);

		// 处理附件：下载图片到 workspace/inbox/，把路径信息拼到 text 里让 agent 知道。
		let text = message.text;
		if (message.attachments?.length && this.opts.onAttachment) {
			const imageAttachments = message.attachments.filter((a) => a.contentType.startsWith("image/"));
			for (const att of imageAttachments) {
				try {
					const relPath = await this.opts.onAttachment(message.scope, att);
					text += `\n[用户发来一张图片：已保存到 ${relPath}]`;
				} catch (e) {
					console.warn(`[session] 下载附件失败: ${(e as Error).message}`);
					text += `\n[用户发来一张图片，但下载失败]`;
				}
			}
		}

		const result = await entry.session.prompt({
			text,
			senderId: message.senderId,
			senderName: message.senderName,
			platformMessageId: message.platformMessageId,
		});
		return {
			// agent 通过 send_message 工具发消息时 text 为空——不再重复发。
			// 只有 agent 没用 send_message 时才返回最终文字由 router 发送。
			text: result.text,
			replyToMessageId: result.replyToMessageId,
		};
	}

	/**
	 * 处理按钮点击回调（INTERACTION_CREATE）。
	 *
	 * 找到对应 scope 的挂起提问，resolve 它（把按钮 data 作为用户的选择）。
	 * 如果没有挂起提问（用户乱点过期的按钮），静默忽略。
	 */
	dispatchInteraction(scope: ScopeKey, callback: { interactionId: string; buttonData?: string; buttonId?: string }): void {
		const entry = this.active.get(scopeKeyStr(scope));
		const pending = entry?.pendingAskHolder.current;
		if (pending) {
			pending.resolve(callback.buttonData ?? callback.buttonId ?? "unknown");
		}
	}

	/** 关闭所有会话：回收记忆 + 落盘，停止扫描器。 */
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
	}

	private async getOrCreate(scope: ScopeKey): Promise<ActiveEntry> {
		const key = scopeKeyStr(scope);
		const existing = this.active.get(key);
		if (existing) return existing;

		const scopeDir = `${this.opts.dataDir}/${scope.kind}/${scope.id}`;
		const workspaceDir = `${scopeDir}/workspace`;
		const env = await this.opts.envFactory(scope, workspaceDir, scopeDir);
		// 共享 holder：factory 创建的工具读它，ChatBotSession.prompt 写它。
		// 让 send_image 等工具能拿到当前被动消息 id（群消息发图必须带 msg_id）。
		const replyToHolder: { current?: string } = {};
		// 挂起提问容器：ask_user 工具写，dispatchInteraction（点按钮）/ prompt（发文字）读。
		const pendingAskHolder: PendingAskHolder = {};
		const extraTools = this.opts.extraToolsFactory?.(scope, () => replyToHolder.current, workspaceDir, pendingAskHolder) ?? [];
		const session = new ChatBotSession({
			scope,
			scopeName: scope.id,
			scopeDir,
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
		};
		this.resetReaper(entry);
		this.active.set(key, entry);
		return entry;
	}

	private resetReaper(entry: ActiveEntry): void {
		if (entry.reaper) clearTimeout(entry.reaper);
		entry.reaper = setTimeout(() => {
			void this.reapEntry(entry).catch(() => {});
		}, this.opts.ttlMs);
	}

	/** 回收一个 entry：提取记忆、落盘、销毁 Agent、移出池。 */
	private async reapEntry(entry: ActiveEntry): Promise<void> {
		// 找到对应 key 并移除（避免在 await 期间被重复回收）。
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

	/** 仅测试用：当前活跃 scope 数。 */
	get activeCount(): number {
		return this.active.size;
	}

	/**
	 * 列出当前活跃 scope 的运行时信息（管理端「会话」视图用）。
	 * 不返回 ChatBotSession 引用，避免上层直接操作内部 Agent。
	 */
	listActiveScopes(): ActiveScopeInfo[] {
		const now = Date.now();
		const out: ActiveScopeInfo[] = [];
		for (const [key, entry] of this.active) {
			out.push({
				key,
				scope: entry.session.scope,
				lastActivityAt: entry.lastActivityAt,
				ttlRemainingMs: Math.max(0, this.opts.ttlMs - (now - entry.lastActivityAt)),
				messageCount: entry.session.messages.length,
			});
		}
		return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
	}

	/**
	 * 取某 scope 的详情：系统提示词 + 工具描述符 + 最近 N 条消息。
	 * 不存在活跃会话时返回 undefined。
	 */
	getScopeDetail(scope: ScopeKey, recentMessageLimit = 20): ActiveScopeDetail | undefined {
		const entry = this.active.get(scopeKeyStr(scope));
		if (!entry) return undefined;
		const messages = entry.session.messages;
		return {
			scope: entry.session.scope,
			systemPrompt: entry.session.systemPrompt,
			tools: entry.session.toolDescriptors,
			messages: messages.slice(Math.max(0, messages.length - recentMessageLimit)),
			messageCount: messages.length,
			lastActivityAt: entry.lastActivityAt,
		};
	}

	/**
	 * 强制回收一个 scope（管理端「强制回收」按钮）。
	 * 与 TTL 超时走同一条回收路径：提取记忆、落盘、销毁 Agent。
	 * 不存在活跃会话时返回 false。
	 */
	async forceReap(scope: ScopeKey): Promise<boolean> {
		const entry = this.active.get(scopeKeyStr(scope));
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

/** 活跃 scope 的运行时摘要（listActiveScopes 返回）。 */
export interface ActiveScopeInfo {
	readonly key: string;
	readonly scope: ScopeKey;
	readonly lastActivityAt: number;
	readonly ttlRemainingMs: number;
	readonly messageCount: number;
}

/** 活跃 scope 的详情（getScopeDetail 返回）。 */
export interface ActiveScopeDetail {
	readonly scope: ScopeKey;
	readonly systemPrompt: string;
	readonly tools: { name: string; description: string }[];
	readonly messages: AgentMessage[];
	readonly messageCount: number;
	readonly lastActivityAt: number;
}
