import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { ChatBotSession } from "../agent/bot-session.ts";
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
	readonly envFactory: (scope: ScopeKey, workspaceDir: string) => ExecutionEnv;
	/** 无活动回收阈值（毫秒），默认 1 小时。 */
	readonly ttlMs?: number;
	/** 回收器扫描间隔（毫秒），默认 1 分钟。 */
	readonly reaperIntervalMs?: number;
	/** 机器人人设（所有 scope 共享）。 */
	readonly persona?: string;
	/**
	 * 按 scope 生成额外工具（如 send_image）。每个 scope 激活时调用一次，
	 * 返回的工具会与默认 bash/read/edit/write 一起装入 Agent。
	 */
	readonly extraToolsFactory?: (scope: ScopeKey) => AgentTool[];
}

interface ActiveEntry {
	readonly session: ChatBotSession;
	/** 串行化该 scope 的消息处理；每个新消息挂在新 promise 上保持链式。 */
	queue: Promise<OutgoingMessage>;
	lastActivityAt: number;
	/** 回收定时器。 */
	reaper: ReturnType<typeof setTimeout>;
}

/**
 * 管理所有活跃 scope 的 ChatBotSession 实例，实现：
 * 1. **按需激活**：首次收到某 scope 消息时建 Agent（加载记忆+历史）。
 * 2. **串行处理**：同一 scope 的消息串行 prompt（pi Agent 不可重入）。
 * 3. **TTL 回收**：某 scope 超过 ttlMs 无新消息 → 提取记忆 + 落盘历史 + 销毁 Agent，仅保留磁盘数据。
 * 4. **断电续传**：磁盘上的 memory.md / session.jsonl 让下次激活恢复上下文。
 */
export class SessionManager {
	private readonly opts: Required<Omit<SessionManagerOptions, "persona" | "envFactory" | "model" | "models" | "streamFn" | "extraToolsFactory">> &
		Pick<SessionManagerOptions, "persona" | "envFactory" | "model" | "models" | "streamFn" | "extraToolsFactory">;
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
			persona: opts.persona,
		};
	}

	/** 启动后台回收扫描器。 */
	start(): void {
		if (this.reaperTimer) return;
		this.reaperTimer = setInterval(() => void this.reap(), this.opts.reaperIntervalMs);
	}

	/**
	 * 路由一条入站消息到对应 scope 的会话，返回出站回复。
	 * 自动按需激活、串行排队、刷新 TTL。
	 */
	async dispatch(message: IncomingMessage): Promise<OutgoingMessage> {
		if (this.shuttingDown) {
			return { text: "（服务正在关闭，暂时无法处理消息。）" };
		}
		const entry = await this.getOrCreate(message.scope);
		entry.lastActivityAt = Date.now();
		// 刷新回收定时器：有新消息则推迟回收。
		this.resetReaper(entry);

		const myTurn = entry.queue.then(
			() => this.runTurn(entry, message),
			() => this.runTurn(entry, message),
		);
		// 把新 promise 挂回 queue，保持串行链。失败也吞掉以免断链。
		entry.queue = myTurn.catch(() => ({ text: "" }));
		return myTurn;
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
		const env = this.opts.envFactory(scope, workspaceDir);
		const extraTools = this.opts.extraToolsFactory?.(scope) ?? [];
		const session = new ChatBotSession({
			scope,
			scopeName: scope.id,
			scopeDir,
			model: this.opts.model,
			streamFn: this.opts.streamFn,
			env,
			persona: this.opts.persona,
			extraTools,
		});
		await session.activate();

		const entry: ActiveEntry = {
			session,
			queue: Promise.resolve({ text: "" }),
			lastActivityAt: Date.now(),
			reaper: undefined as unknown as ReturnType<typeof setTimeout>,
		};
		this.resetReaper(entry);
		this.active.set(key, entry);
		return entry;
	}

	/** 执行单轮：prompt → 拼回复。 */
	private async runTurn(entry: ActiveEntry, message: IncomingMessage): Promise<OutgoingMessage> {
		const text = await entry.session.prompt(message.text);
		return { text: text || "（处理完成，但没有文字回复。）", replyToMessageId: message.platformMessageId };
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

		await entry.session.dispose(async () => this.summarize(entry.session.messages));
	}

	/** 用 pi generateSummary 把会话压缩成 Markdown 记忆。 */
	private async summarize(messages: AgentMessage[]): Promise<string | undefined> {
		if (messages.length === 0) return undefined;
		try {
			const { generateSummary } = await import("@earendil-works/pi-agent-core");
			const result = await generateSummary(
				messages,
				this.opts.models,
				this.opts.model,
				2048,
				undefined,
				"为这个群聊会话生成一段简洁的长期记忆 Markdown：保留成员关心的关键事实、未完成的任务、机器人的人设演变。避免逐条复述对话。",
			);
			return result.ok ? result.value : undefined;
		} catch {
			return undefined;
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

	/** 仅测试用：当前活跃 scope 数。 */
	get activeCount(): number {
		return this.active.size;
	}
}
