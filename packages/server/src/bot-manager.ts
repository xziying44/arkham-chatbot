import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	ScopeCoordinator,
	createLogger,
	loadCardIndex,
	type PromptRegistry,
	type Logger,
	type IncomingMessage,
	type IndexedCard,
} from "@arkham/chatbot-core";
import { QQAdapter, type QQConnectionState } from "@arkham/chatbot-im-qq";
import type { ImAdapter } from "@arkham/chatbot-im-core";
import type {
	AgentRuntimeRepository,
	BotRecord,
	MessageRepository,
	UsageRepository,
} from "@arkham/chatbot-store";
import { createMessageRouter } from "./message-router.ts";
import type { BotConfig, BotRuntimeInfo } from "./bot-config.ts";
import { createCardRenderService } from "./card-render-service.ts";
import { createGeneralTaskService } from "./general-task-service.ts";

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
	readonly streamFn: StreamFn;
	readonly sandbox: SandboxConfig;
	/** 消息流水仓库（路由器入站/出站落库用）。可选。 */
	readonly messages?: MessageRepository;
	readonly runtime: AgentRuntimeRepository;
	readonly usage: UsageRepository;
	readonly prompts: PromptRegistry;
	/** arkham-cli 二进制路径（宿主机），供制卡服务渲染卡图。 */
	readonly arkhamBinPath?: string;
	/** arkham-cli 资产目录（宿主机绝对路径）。可选。 */
	readonly arkhamAssetsDir?: string;
	/**
	 * 卡牌数据库根目录（宿主机绝对路径，含 json/ + card_images/）。
	 * 配置后启动时加载只读索引，由编排层完成查卡和卡图定位。
	 */
	readonly cardDatabaseDir?: string;
	/**
	 * MiniMax 文生图配置。key 仅留在宿主机进程内，不进入任务沙箱。
	 */
	readonly minimax?: { readonly apiKey: string; readonly apiBase?: string };
	readonly logger?: Logger;
}

/** 一个运行中的机器人实例：adapter + 独立 session 池 + 路由器。 */
interface BotInstance {
	readonly config: BotConfig;
	readonly adapter: ImAdapter;
	readonly sessions: ScopeCoordinator;
	/** subscribe 返回的取消函数（disconnect 前调用）。 */
	unsubscribe?: () => void;
}

/**
 * 多机器人编排器：在一个进程内持有 N 个 QQ 机器人实例。
 *
 * 关键设计：
 * - **每机器人独立 ScopeCoordinator**：独立 dataDir 子树（`<dataRoot>/<botId>/`）、
 *   独立 persona、独立 adapter。避免改 ScopeKey、避免跨机器人键冲突。
 * - **共享全局 LLM**：model/streamFn 全局唯一（LLM 端点在设置页改）。
 * - **运行时增删改查**：addBot/reconfigureBot/removeBot 供管理端 CRUD 直接驱动。
 *   改 LLM 端点对活跃会话的影响：活跃会话持有旧 model 引用，需 reapAll 后新激活才生效。
 */
export class BotManager {
	private readonly instances = new Map<string, BotInstance>();
	private readonly log: Logger;
	private readonly opts: BotManagerOptions;
	/** 启动时从 cardDatabaseDir 加载的卡牌索引（所有会话共享，供 search_cards）。 */
	private cardIndex: IndexedCard[] = [];

	constructor(opts: BotManagerOptions) {
		this.opts = opts;
		this.log = opts.logger ?? createLogger("bot-manager");
	}

	/** 启动：加载卡牌索引，再为每个启用的配置构建并连接实例。 */
	async start(configs: BotConfig[]): Promise<void> {
		// 可选：加载卡牌数据库索引。失败不阻断启动，查卡能力优雅降级。
		if (this.opts.cardDatabaseDir) {
			try {
				this.cardIndex = await loadCardIndex(this.opts.cardDatabaseDir, "cards-db");
				this.log.info("卡牌数据库索引已加载", { dir: this.opts.cardDatabaseDir, count: this.cardIndex.length });
			} catch (error) {
				this.log.warn("卡牌数据库索引加载失败，search_cards 不可用", { dir: this.opts.cardDatabaseDir, error: (error as Error).message });
			}
		}
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

	/** 构建 adapter + 独立 ScopeCoordinator + 路由器，连接，登记。 */
	private async buildAndConnect(config: BotConfig): Promise<void> {
		const botDataDir = this.botDataDir(config.id);
		await mkdir(botDataDir, { recursive: true });

		const adapter: ImAdapter = new QQAdapter({
			appId: config.appId,
			appSecret: config.appSecret,
			apiBase: config.apiBase,
		});

		const botLog = this.log.child(config.id);
		const renderCards = this.opts.arkhamBinPath && this.opts.arkhamAssetsDir
			? createCardRenderService({
				arkhamBinPath: this.opts.arkhamBinPath,
				arkhamAssetsDir: this.opts.arkhamAssetsDir,
				minimax: this.opts.minimax,
			})
			: undefined;
		const runGeneralTask = createGeneralTaskService({
			model: this.opts.model,
			streamFn: this.opts.streamFn,
			prompts: this.opts.prompts,
			sandbox: this.opts.sandbox,
		});
		const sessions = new ScopeCoordinator({
			botId: config.id,
			dataDir: botDataDir,
			model: this.opts.model,
			streamFn: this.opts.streamFn,
			prompts: this.opts.prompts,
			runtime: this.opts.runtime,
			usage: this.opts.usage,
			persona: config.persona ?? undefined,
			cardIndex: this.cardIndex,
			resolveCardImage: (relativePath) => {
				const prefix = "cards-db/";
				if (!this.opts.cardDatabaseDir || !relativePath.startsWith(prefix)) return undefined;
				return join(this.opts.cardDatabaseDir, relativePath.slice(prefix.length));
			},
			renderCards,
			runGeneralTask,
			onProgress: async (scope, text, replyToMessageId) => {
				await adapter.sendText(scope, text, replyToMessageId);
			},
			onAttachment: async (scope, attachment) => {
				const inboxDir = join(this.botDataDir(config.id), scope.kind, scope.id, "workspace", "inbox");
				await mkdir(inboxDir, { recursive: true });
				const ext = attachment.filename.match(/\.[^.]+$/)?.[0] ?? ".jpg";
				const filename = (Date.now() + "_" + attachment.filename.replace(/[^\w.-]/g, "_")).slice(0, 60) || Date.now() + ext;
				const filePath = join(inboxDir, filename);
				const buffer = await adapter.downloadAttachment!(attachment.url);
				await writeFile(filePath, buffer);
				return "inbox/" + filename;
			},
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
