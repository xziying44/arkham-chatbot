import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	SessionManager,
	createSendImageTool,
	createLogger,
	type Logger,
	type ScopeKey,
	type IncomingMessage,
} from "@arkham/chatbot-core";
import { createExecutionEnv } from "@arkham/chatbot-sandbox";
import { QQAdapter, type QQConnectionState } from "@arkham/chatbot-im-qq";
import type { ImAdapter } from "@arkham/chatbot-im-core";
import type { BotRecord, MessageRepository } from "@arkham/chatbot-store";
import { createMessageRouter } from "./message-router.ts";
import type { BotConfig, BotRuntimeInfo } from "./bot-config.ts";

/** 沙箱全局配置（所有机器人共享）。 */
export interface SandboxConfig {
	readonly enabled: boolean;
	readonly networkDisabled: boolean;
	readonly timeoutSeconds: number;
}

/** BotManager 构造选项。 */
export interface BotManagerOptions {
	/** 运行时数据根目录；每机器人落在 `<dataRoot>/<botId>/`。 */
	readonly dataRoot: string;
	readonly model: Model<any>;
	readonly models: Models;
	readonly streamFn: StreamFn;
	readonly sandbox: SandboxConfig;
	readonly sessionTtlMs: number;
	readonly reaperIntervalMs: number;
	/** 消息流水仓库（路由器入站/出站落库用）。可选。 */
	readonly messages?: MessageRepository;
	readonly logger?: Logger;
}

/** 一个运行中的机器人实例：adapter + 独立 session 池 + 路由器。 */
interface BotInstance {
	readonly config: BotConfig;
	readonly adapter: ImAdapter;
	readonly sessions: SessionManager;
	/** subscribe 返回的取消函数（disconnect 前调用）。 */
	unsubscribe?: () => void;
}

/**
 * 多机器人编排器：在一个进程内持有 N 个 QQ 机器人实例。
 *
 * 关键设计：
 * - **每机器人独立 SessionManager**：独立 dataDir 子树（`<dataRoot>/<botId>/`）、
 *   独立 persona、独立 adapter。避免改 ScopeKey、避免跨机器人键冲突。
 * - **共享全局 LLM**：model/models/streamFn 全局唯一（LLM 端点在设置页改）。
 * - **运行时增删改查**：addBot/reconfigureBot/removeBot 供管理端 CRUD 直接驱动。
 *   改 LLM 端点对活跃会话的影响：活跃会话持有旧 model 引用，需 reapAll 后新激活才生效。
 */
export class BotManager {
	private readonly instances = new Map<string, BotInstance>();
	private readonly log: Logger;
	private readonly opts: BotManagerOptions;

	constructor(opts: BotManagerOptions) {
		this.opts = opts;
		this.log = opts.logger ?? createLogger("bot-manager");
	}

	/** 启动：为每个 enabled 的配置构建并连接实例。失败的机器人记日志、跳过，不阻塞其它。 */
	async start(configs: BotConfig[]): Promise<void> {
		for (const cfg of configs) {
			if (!cfg.enabled) {
				this.log.info("机器人未启用，跳过启动", { botId: cfg.id, name: cfg.name });
				continue;
			}
			try {
				await this.buildAndConnect(cfg);
			} catch (error) {
				this.log.error("机器人启动失败", { botId: cfg.id, name: cfg.name, error: (error as Error).message });
			}
		}
	}

	/** 列出所有已加载实例的运行时信息（管理端列表用）。 */
	list(): BotRuntimeInfo[] {
		return Array.from(this.instances.values()).map((inst) => this.toRuntimeInfo(inst));
	}

	get(id: string): BotInstance | undefined {
		return this.instances.get(id);
	}

	/**
	 * 取某 bot 某 scope 在磁盘上的数据目录（审计记忆/历史用）。
	 * 路径: <dataRoot>/<botId>/<kind>/<scopeId>。bot 不存在也返回路径（磁盘数据可能还在）。
	 */
	getScopeDir(botId: string, kind: "group" | "user", scopeId: string): string {
		return join(this.opts.dataRoot, botId, kind, scopeId);
	}

	/** 列出某 bot 在磁盘上的所有 scope（扫描 group/ + user/ 目录）。 */
	async listScopes(botId: string): Promise<{ kind: "group" | "user"; id: string }[]> {
		const { readdir } = await import("node:fs/promises");
		const botDir = this.botDataDir(botId);
		const out: { kind: "group" | "user"; id: string }[] = [];
		for (const kind of ["group", "user"] as const) {
			const kindDir = join(botDir, kind);
			let entries: import("node:fs").Dirent[];
			try {
				entries = await readdir(kindDir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const e of entries) {
				if (e.isDirectory()) out.push({ kind, id: e.name });
			}
		}
		return out;
	}

	/** 运行时新增并连接一个机器人。 */
	async addBot(config: BotConfig): Promise<void> {
		if (this.instances.has(config.id)) {
			throw new Error(`机器人已存在: ${config.id}`);
		}
		await this.buildAndConnect(config);
	}

	/**
	 * 重新配置一个机器人：persona/enabled/凭证等变更后重建实例。
	 * 会先断开旧实例（活跃会话走正常回收落盘），再用新配置构建。
	 */
	async reconfigureBot(id: string, config: BotConfig): Promise<void> {
		const existing = this.instances.get(id);
		if (existing) {
			await this.teardown(existing);
		}
		if (config.enabled) {
			await this.buildAndConnect(config);
		} else {
			this.log.info("机器人已禁用，仅更新配置未连接", { botId: id });
		}
	}

	/** 启用一个机器人（构建并连接）。 */
	async enable(id: string, config: BotConfig): Promise<void> {
		await this.reconfigureBot(id, { ...config, enabled: true });
	}

	/** 禁用一个机器人（断开 + 回收会话，磁盘数据保留）。 */
	async disable(id: string): Promise<void> {
		const existing = this.instances.get(id);
		if (!existing) return;
		await this.teardown(existing);
		this.log.info("机器人已禁用", { botId: id });
	}

	/**
	 * 移除一个机器人：断开 + 回收，并删除其数据目录。
	 * 通常管理端「删除」只断开+禁用保留磁盘数据；如需彻底清理调用此方法。
	 */
	async removeBot(id: string, deleteData: boolean): Promise<void> {
		const existing = this.instances.get(id);
		if (existing) {
			await this.teardown(existing);
		}
		if (deleteData) {
			const dir = this.botDataDir(id);
			await rm(dir, { recursive: true, force: true }).catch(() => {});
			this.log.info("已删除机器人数据目录", { botId: id, dir });
		}
	}

	/** 关闭所有机器人（回收会话 + 断开连接）。 */
	async shutdown(): Promise<void> {
		const all = Array.from(this.instances.values());
		await Promise.all(all.map((inst) => this.teardown(inst).catch(() => {})));
		this.log.info("所有机器人已关闭", { count: all.length });
	}

	/** 回收所有机器人的所有活跃会话（改 LLM 端点后强制应用新模型）。 */
	async reapAllSessions(): Promise<number> {
		let total = 0;
		for (const inst of this.instances.values()) {
			total += await inst.sessions.reapAll();
		}
		return total;
	}

	// ---- 内部 ----

	private botDataDir(botId: string): string {
		return join(this.opts.dataRoot, botId);
	}

	/** 构建 adapter + 独立 SessionManager + 路由器，连接，登记。 */
	private async buildAndConnect(config: BotConfig): Promise<void> {
		const botDataDir = this.botDataDir(config.id);
		await mkdir(botDataDir, { recursive: true });

		// adapter 先建：sessions 的 send_image 闭包要引用它。
		const adapter: ImAdapter = new QQAdapter({
			appId: config.appId,
			appSecret: config.appSecret,
			apiBase: config.apiBase,
		});

		const botLog = this.log.child(config.id);
		const sessions = new SessionManager({
			dataDir: botDataDir,
			model: this.opts.model,
			models: this.opts.models,
			streamFn: this.opts.streamFn,
			envFactory: (_scope, workspaceDir, scopeDir) =>
				createExecutionEnv({
					enabled: this.opts.sandbox.enabled,
					cwd: workspaceDir,
					networkDisabled: this.opts.sandbox.networkDisabled,
					timeoutSeconds: this.opts.sandbox.timeoutSeconds,
					// 历史归档只读挂载到沙箱内 workspace/history/，agent 可查阅但无法篡改。
					readOnlyBinds: [[`${scopeDir}/history`, `${workspaceDir}/history`]],
				}),
			ttlMs: this.opts.sessionTtlMs,
			reaperIntervalMs: this.opts.reaperIntervalMs,
			persona: config.persona ?? undefined,
			extraToolsFactory: (scope, getReplyToMsgId, workspaceDir) => [
				createSendImageTool({
					scopeId: scope.id,
					getReplyToMsgId,
					workspaceDir,
					send: async (scopeId, filePath, replyToMsgId) => {
						const scopeKey: ScopeKey = { kind: scope.kind, id: scopeId };
						await adapter.sendImage(scopeKey, filePath, replyToMsgId);
					},
				}),
			],
		});
		sessions.start();

		const router = createMessageRouter({
			adapter,
			sessions,
			botId: config.id,
			messages: this.opts.messages,
			logger: botLog,
		});
		const unsubscribe = adapter.subscribe(router);

		const instance: BotInstance = { config, adapter, sessions, unsubscribe };
		this.instances.set(config.id, instance);

		await adapter.connect();
		botLog.info("机器人已连接", { name: config.name, appId: config.appId });
	}

	/** 断开一个实例：取消订阅、断开 adapter、关闭 session 池（落盘）。 */
	private async teardown(inst: BotInstance): Promise<void> {
		this.instances.delete(inst.config.id);
		inst.unsubscribe?.();
		await inst.adapter.disconnect().catch(() => {});
		await inst.sessions.shutdown().catch(() => {});
	}

	private toRuntimeInfo(inst: BotInstance): BotRuntimeInfo {
		const adapter = inst.adapter as QQAdapter;
		const state = adapter.connectionState as QQConnectionState;
		return {
			id: inst.config.id,
			appId: inst.config.appId,
			name: inst.config.name,
			apiBase: inst.config.apiBase,
			persona: inst.config.persona,
			enabled: inst.config.enabled,
			loaded: true,
			connectionState: state,
			connected: state === "connected",
			activeScopeCount: inst.sessions.activeCount,
		};
	}
}

/** BotRecord（DB 行）→ BotConfig（驱动配置）。 */
export function recordToConfig(rec: BotRecord): BotConfig {
	return {
		id: rec.id,
		appId: rec.appId,
		appSecret: rec.appSecret,
		name: rec.name,
		apiBase: rec.apiBase,
		persona: rec.persona,
		enabled: rec.enabled,
	};
}

// 重新导出，供 message-router 使用 IncomingMessage 类型推导。
export type { IncomingMessage };
