import { mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { StreamFn, Skill, AgentTool } from "@earendil-works/pi-agent-core";
import {
	SessionManager,
	createSendImageTool,
	createSendCardTool,
	createAskUserTool,
	createSearchCardsTool,
	createGenerateImageTool,
	createLogger,
	loadCardIndex,
	loadSkillsFromDir,
	PromptLoader,
	type Logger,
	type ScopeKey,
	type IncomingMessage,
	type IndexedCard,
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
	/** 思考程度: off/low/medium/high/max。传给 Agent 控制思考开关与强度。 */
	readonly thinkingLevel?: string;
	/** 消息流水仓库（路由器入站/出站落库用）。可选。 */
	readonly messages?: MessageRepository;
	/** 技能源文件目录（宿主机绝对路径）。启动时加载，注入所有会话。 */
	readonly skillsDir: string;
	/** 提示词源文件目录（宿主机绝对路径，prompts/static/*.md）。启动时加载，fs.watch 热更新。 */
	readonly promptsDir: string;
	/** arkham-cli 二进制路径（宿主机）。技能 diy-card 用它渲染卡图。可选。 */
	readonly arkhamBinPath?: string;
	/** arkham-cli 资产目录（宿主机绝对路径）。可选。 */
	readonly arkhamAssetsDir?: string;
	/**
	 * 卡牌数据库根目录（宿主机绝对路径，含 json/ + card_images/）。
	 * 配置后：①只读挂载到沙箱 cards-db/；②启动时加载索引供 search_cards 工具用；
	 * ③加入 send_image 的 extraAllowedRoots（dev 模式 symlink 解析放行）。
	 * 未配置则 search_cards 不装配。
	 */
	readonly cardDatabaseDir?: string;
	/**
	 * MiniMax 文生图配置。配置了 apiKey 才装配 generate_image 工具。
	 * key 仅注入工具闭包（宿主机进程内执行），不写入沙箱文件/环境变量。
	 */
	readonly minimax?: { readonly apiKey: string; readonly apiBase?: string };
	/**
	 * 启动时清除所有 scope 的对话历史（不注入 session.jsonl 到上下文）。
	 * 用于：改了提示词/技能/系统配置后，避免旧上下文污染新行为。
	 */
	readonly clearHistoryOnStart?: boolean;
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
	/** 启动时从 skillsDir 加载的技能清单（所有会话共享）。 */
	private skills: Skill[] = [];
	/** 启动时从 cardDatabaseDir 加载的卡牌索引（所有会话共享，供 search_cards）。 */
	private cardIndex: IndexedCard[] = [];
	/** 提示词加载器（所有会话共享）。读 prompts/static/*.md，fs.watch 触发 reload。 */
	private readonly promptLoader: PromptLoader;
	/** skills/ + prompts/ 目录的文件监听器（热更新）。 */
	private watchers: FSWatcher[] = [];

	constructor(opts: BotManagerOptions) {
		this.opts = opts;
		this.log = opts.logger ?? createLogger("bot-manager");
		this.promptLoader = new PromptLoader(opts.promptsDir);
	}

	/** 启动：加载提示词 → 加载技能 → 为每个 enabled 的配置构建并连接实例。失败的机器人记日志、跳过，不阻塞其它。 */
	async start(configs: BotConfig[]): Promise<void> {
		// 可选：启动时清除所有 scope 的对话历史（改配置后避免旧上下文污染）。
		if (this.opts.clearHistoryOnStart) {
			await this.markAllHistoryCleared(configs);
		}
		// 加载提示词文件（prompts/static/*.md）。所有会话共享同一 PromptLoader 实例。
		try {
			await this.promptLoader.load();
			this.log.info("提示词已加载", { dir: this.opts.promptsDir });
		} catch (error) {
			this.log.warn("提示词目录加载失败，部分提示词会缺失", { dir: this.opts.promptsDir, error: (error as Error).message });
		}
		// 加载技能（所有会话共享）。目录不存在或无技能文件不报错，只是没有技能可用。
		try {
			const { skills, diagnostics } = await loadSkillsFromDir(this.opts.skillsDir);
			this.skills = skills;
			if (skills.length > 0) {
				this.log.info("技能已加载", {
					count: skills.length,
					names: skills.map((s) => s.name).join(", "),
				});
			}
			for (const d of diagnostics) {
				this.log.warn("技能加载警告", { code: d.code, path: d.path, message: d.message });
			}
		} catch (error) {
			this.log.warn("技能目录加载失败，技能不可用", { dir: this.opts.skillsDir, error: (error as Error).message });
		}
		// 可选：加载卡牌数据库索引（search_cards 工具用）。失败不阻断启动，工具不装配。
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
		// 启动文件监听：skills/ 或 prompts/ 改动 → 重载 + reap 所有活跃会话。
		this.startWatchers();
	}

	/**
	 * 给所有 scope 目录写「清除历史」标记（.history_cleared）。
	 * ChatBotSession 激活时会消费这个标记 → 本次不注入 session.jsonl 历史。
	 *
	 * 用途：改了提示词/技能/系统配置后重启，避免旧对话上下文里的行为模式污染新配置。
	 */
	private async markAllHistoryCleared(configs: BotConfig[]): Promise<void> {
		let cleared = 0;
		for (const cfg of configs) {
			const botDir = this.botDataDir(cfg.id);
			// 遍历 <botDir>/<kind>/<scopeId>/ 三层结构
			for (const kind of ["group", "user"] as const) {
				const kindDir = join(botDir, kind);
				let scopeIds: string[];
				try {
					scopeIds = await readdir(kindDir);
				} catch {
					continue; // 目录不存在，跳过
				}
				for (const scopeId of scopeIds) {
					const flagPath = join(kindDir, scopeId, ".history_cleared");
					try {
						await writeFile(flagPath, String(Date.now()), "utf8");
						cleared++;
					} catch {
						// 写失败不阻断启动
					}
				}
			}
		}
		if (cleared > 0) {
			this.log.info("启动时已标记清除对话历史", { scopes: cleared });
		}
	}

	/** 技能源文件目录（管理端查看技能用）。 */
	get skillsDir(): string {
		return this.opts.skillsDir;
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
		for (const w of this.watchers) w.close();
		this.watchers = [];
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

	/**
	 * 热更新技能：重新读 skillsDir → 更新 this.skills + 同步到所有 SessionManager →
	 * reap 所有活跃会话。下条消息到达时重新激活，用新技能构建 systemPrompt。
	 *
	 * 由 fs.watch 自动触发，也可由管理端手动调（POST /admin/skills/reload）。
	 */
	async reloadSkills(): Promise<void> {
		try {
			const { skills, diagnostics } = await loadSkillsFromDir(this.opts.skillsDir);
			this.skills = skills;
			for (const inst of this.instances.values()) {
				inst.sessions.updateSkills(skills);
			}
			for (const d of diagnostics) {
				this.log.warn("技能加载警告", { code: d.code, path: d.path, message: d.message });
			}
			await this.reapAllSessions();
			this.log.info("技能已热更新并重新激活会话", { count: skills.length });
		} catch (error) {
			this.log.warn("技能热更新失败", { error: (error as Error).message });
		}
	}

	/**
	 * 热更新提示词：重新读 prompts/static/*.md → reap 所有活跃会话。
	 * 下条消息到达时重新激活，用新提示词构建 systemPrompt。
	 *
	 * 由 fs.watch 自动触发，也可由管理端手动调。
	 */
	async reloadPrompts(): Promise<void> {
		try {
			await this.promptLoader.reload();
			await this.reapAllSessions();
			this.log.info("提示词已热更新并重新激活会话");
		} catch (error) {
			this.log.warn("提示词热更新失败", { error: (error as Error).message });
		}
	}

	// ---- 内部 ----

	/**
	 * 监听 skills/ 和 prompts/ 目录，文件变化时 debounce 500ms 后重载 + reap。
	 *
	 * debounce 防止编辑器「保存触发多次事件」「先空后写」等抖动导致连续重载。
	 * 单目录监听 recursive（macOS/Win 支持，Linux 仅 npm chokidar——这里用原生，
	 * Linux 下子目录变化不触发，但 SKILL.md/prompt .md 改动通常在顶层，够用）。
	 */
	private startWatchers(): void {
		const debounceReload = (kind: "skills" | "prompts") => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			return () => {
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					this.log.info("检测到文件变化，触发热更新", { kind });
					if (kind === "skills") void this.reloadSkills();
					else void this.reloadPrompts();
				}, 500);
			};
		};
		try {
			const skillWatcher = watch(this.opts.skillsDir, { recursive: true }, debounceReload("skills"));
			this.watchers.push(skillWatcher);
		} catch (e) {
			this.log.warn("技能目录监听失败，技能改动需手动重启或管理端触发", { dir: this.opts.skillsDir, error: (e as Error).message });
		}
		try {
			const promptsWatcher = watch(this.opts.promptsDir, { recursive: true }, debounceReload("prompts"));
			this.watchers.push(promptsWatcher);
		} catch (e) {
			this.log.warn("提示词目录监听失败，提示词改动需手动重启或管理端触发", { dir: this.opts.promptsDir, error: (e as Error).message });
		}
	}

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
			envFactory: async (_scope, workspaceDir, scopeDir) =>
				createExecutionEnv({
					enabled: this.opts.sandbox.enabled,
					cwd: workspaceDir,
					networkDisabled: this.opts.sandbox.networkDisabled,
					timeoutSeconds: this.opts.sandbox.timeoutSeconds,
					// 只读挂载（host → 沙箱内 workspace 下固定路径）：
					// - 历史归档 → workspace/history/（agent 可查阅但无法篡改）
					// - 技能源目录 → workspace/skills/（agent 用 read 读 SKILL.md + 附件）
					// - arkham-cli 资产 → workspace/.arkham/assets（DIY 卡图技能用）
					// - arkham-cli 二进制 → workspace/.arkham/bin/arkham-cli（单文件 ro-bind）
					// - 卡牌数据库 → workspace/cards-db/（search_cards 工具查询 + 发图）
					// 用 workspace 下的相对路径而非 /opt/arkham/，避免 macOS 开发模式下
					// /opt 不可写的权限问题。bwrap 的 --ro-bind 支持嵌套在 rw workspace 内。
					readOnlyBinds: [
						[`${scopeDir}/history`, `${workspaceDir}/history`],
						[this.opts.skillsDir, `${workspaceDir}/skills`],
						...(this.opts.arkhamAssetsDir ? [[this.opts.arkhamAssetsDir, `${workspaceDir}/.arkham/assets`] as const] : []),
						...(this.opts.arkhamBinPath ? [[this.opts.arkhamBinPath, `${workspaceDir}/.arkham/bin/arkham-cli`] as const] : []),
						...(this.opts.cardDatabaseDir ? [[this.opts.cardDatabaseDir, `${workspaceDir}/cards-db`] as const] : []),
					],
				}),
			ttlMs: this.opts.sessionTtlMs,
			reaperIntervalMs: this.opts.reaperIntervalMs,
			thinkingLevel: this.opts.thinkingLevel,
			persona: config.persona ?? undefined,
			skills: this.skills,
			promptLoader: this.promptLoader,
			extraToolsFactory: (scope, getReplyToMsgId, workspaceDir, pendingAskHolder) => {
				// send_image 的路径映射：cards-db（沙箱内挂载点）→ 宿主真实数据库目录。
				// 生产 bwrap 下 cards-db 只是容器内挂载点，宿主进程看不到该路径，必须映射回
				// 宿主真实目录才能读到卡图文件并发送。
				const pathMappings = this.opts.cardDatabaseDir
					? [{ prefix: "cards-db", hostDir: this.opts.cardDatabaseDir }]
					: undefined;
				const tools: AgentTool[] = [
					createSendImageTool({
						scopeId: scope.id,
						getReplyToMsgId,
						workspaceDir,
						pathMappings,
						send: async (scopeId, filePath, replyToMsgId) => {
							const scopeKey: ScopeKey = { kind: scope.kind, id: scopeId };
							await adapter.sendImage(scopeKey, filePath, replyToMsgId);
						},
					}),
					createSendCardTool({
						scopeId: scope.id,
						getReplyToMsgId,
						workspaceDir,
						send: async (scopeId, filePath, replyToMsgId) => {
							const scopeKey: ScopeKey = { kind: scope.kind, id: scopeId };
							await adapter.sendFile(scopeKey, filePath, replyToMsgId);
						},
					}),
					createAskUserTool({
						getReplyToMsgId,
						pendingAskHolder,
						scopeKind: scope.kind,
						sendKeyboard: async (content, keyboard, replyToMsgId) => {
							await adapter.sendKeyboard?.(scope, content, keyboard, replyToMsgId);
						},
					}),
				];
				// search_cards：索引加载成功才装配（优雅降级）。
				if (this.opts.cardDatabaseDir && this.cardIndex.length > 0) {
					tools.push(createSearchCardsTool({ databaseDir: this.opts.cardDatabaseDir }));
				}
				// generate_image：配置了 MiniMax key 才装配（优雅降级）。
				// 工具在宿主机进程内调 API，key 不进沙箱；生成图落到 workspace/generated/，
				// agent 用 send_image 发送（send_image 的 workspaceDir 边界允许该目录）。
				if (this.opts.minimax) {
					tools.push(createGenerateImageTool({
						apiKey: this.opts.minimax.apiKey,
						apiBase: this.opts.minimax.apiBase,
						workspaceDir,
					}));
				}
				return tools;
			},
			// send_message 工具：agent 主动调用时发送消息（唯一对外发声渠道）。
			// agent 的纯文字输出不自动发——任何要给用户看的内容（含反馈）都靠 agent 自己调 send_message。
			onSendMessage: async (scope, text, replyToMessageId) => {
				await adapter.sendText(scope, text, replyToMessageId);
			},
			// 附件下载：用户发图片时下载到 scope 的 workspace/inbox/。
			onAttachment: async (scope, attachment) => {
				const inboxDir = join(this.botDataDir(config.id), scope.kind, scope.id, "workspace", "inbox");
				await mkdir(inboxDir, { recursive: true });
				const ext = attachment.filename.match(/\.[^.]+$/)?.[0] ?? ".jpg";
				const filename = `${Date.now()}_${attachment.filename.replace(/[^\w.-]/g, "_")}`.slice(0, 60) || `${Date.now()}${ext}`;
				const filePath = join(inboxDir, filename);
				const buffer = await adapter.downloadAttachment!(attachment.url);
				await writeFile(filePath, buffer);
				console.log(`[bot] 附件已下载 scope=${scope.kind}:${scope.id} → inbox/${filename} (${buffer.length} bytes)`);
				return `inbox/${filename}`;
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
