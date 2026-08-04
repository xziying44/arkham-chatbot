import { type Model, type Models, createModels, createProvider } from "@earendil-works/pi-ai";
import * as builtinProviders from "@earendil-works/pi-ai/providers/all";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
	createLogger,
	addSink,
	createConsoleSink,
	setLogLevel,
	type LogEntry,
} from "@arkham/chatbot-core";
import {
	openDb,
	BotRepository,
	SettingsRepository,
	MessageRepository,
	LogRepository,
	SettingsKeys,
	type DatabaseSync,
} from "@arkham/chatbot-store";
import { LogBus, startAdminServer, type AdminServer } from "@arkham/chatbot-admin-api";
import { BotManager, type SandboxConfig } from "./bot-manager.ts";
import { createNonStreamStreamFn } from "./non-stream-bridge.ts";
import { loadConfig, type AppConfig } from "./config.ts";
import { bootstrapIfEmpty, loadBotConfigs } from "./bootstrap.ts";

/** DB 驱动的设置快照（启动时读一次，关键运行参数）。 */
export interface ResolvedSettings {
	readonly model: string;
	readonly anthropicBaseUrl?: string;
	readonly openaiBaseUrl?: string;
	readonly sessionTtlMs: number;
	readonly reaperIntervalMs: number;
	readonly sandbox: SandboxConfig;
}

/** 从 settings 表解析运行参数（env 仅作 fallback）。 */
export function resolveSettings(config: AppConfig, db: DatabaseSync): ResolvedSettings {
	const s = new SettingsRepository(db);
	return {
		model: s.getOr(SettingsKeys.llmModel, config.model),
		anthropicBaseUrl: s.get(SettingsKeys.llmAnthropicBaseUrl) ?? config.llm.anthropicBaseUrl,
		openaiBaseUrl: s.get(SettingsKeys.llmOpenaiBaseUrl) ?? config.llm.openaiBaseUrl,
		sessionTtlMs: s.getInt(SettingsKeys.sessionTtlMs, config.session.ttlMs),
		reaperIntervalMs: config.session.reaperIntervalMs, // 不在管理端改，用 env
		sandbox: {
			enabled: s.getBool(SettingsKeys.sandboxEnabled, config.sandbox.enabled),
			networkDisabled: s.getBool(SettingsKeys.sandboxNetworkDisabled, config.sandbox.networkDisabled),
			timeoutSeconds: s.getInt(SettingsKeys.sandboxTimeoutSeconds, config.sandbox.timeoutSeconds),
		},
	};
}

/**
 * 应用启动入口：DB 驱动的多机器人 + 管理端组装。
 *
 *   读 env → 开 DB → 引导默认值 → 解析设置 → 建 Models
 *   → 建 BotManager（多机器人）→ 启动 AdminServer（管理端 HTTP）
 *   → 等待信号
 *
 * 返回 shutdown 句柄。
 */
export interface AppRuntime {
	readonly db: DatabaseSync;
	readonly botManager: BotManager;
	readonly settings: ResolvedSettings;
	readonly models: Models;
	readonly admin: AdminServer;
	readonly shutdown: () => Promise<void>;
}

export async function startApp(): Promise<AppRuntime> {
	const config = loadConfig();

	// 结构化日志：LogBus（内存广播供 SSE）+ DB sink（落库）+ 控制台 sink（开发）。
	const logBus = new LogBus(1000);
	addSink(logBus); // Logger 产生的日志都汇入 bus，再由 SSE 推送
	addSink(createConsoleSink());
	setLogLevel("info");
	const appLog = createLogger("app");

	// 开 DB + 引导。
	const db = await openDb(config.dbPath);
	appLog.info("数据库已就绪", { path: config.dbPath });

	// DB 日志 sink：把日志写进 logs 表（在 db 就绪后注册）。
	const logRepo = new LogRepository(db);
	addSink({
		write(entry: LogEntry) {
			try {
				logRepo.insert({
					ts: entry.ts,
					level: entry.level,
					source: entry.source ?? null,
					botId: entry.botId ?? null,
					scope: entry.scope ?? null,
					message: entry.message,
					fields: entry.fields ? JSON.stringify(entry.fields) : null,
				});
			} catch {
				/* DB 写失败不影响日志产生 */
			}
		},
	});

	bootstrapIfEmpty(db, config);

	// 解析运行设置。
	const settings = resolveSettings(config, db);
	const { models, model } = buildModels(settings);
	const messages = new MessageRepository(db);

	// 多机器人编排器。
	// streamFn 策略：
	// - OpenAI Chat Completions 端点：用非流式桥接（某些端点流式模式有 bug，
	//   推理模型只输出 reasoning_content 不输出 content；非流式正常）
	// - 其它端点（Anthropic 等）：走原始流式 + 2分钟超时
	const LLM_TIMEOUT_MS = 120_000;
	const nonStreamFn = createNonStreamStreamFn(
		(model: Model<any>, context: any, options?: any) =>
			models.streamSimple(model, context, { ...options, timeoutMs: LLM_TIMEOUT_MS }),
	);
	const botManager = new BotManager({
		dataRoot: config.dataDir,
		model,
		models,
		streamFn: nonStreamFn,
		sandbox: settings.sandbox,
		sessionTtlMs: settings.sessionTtlMs,
		reaperIntervalMs: settings.reaperIntervalMs,
		messages,
		skillsDir: config.skillsDir,
		arkhamBinPath: config.arkhamBinPath,
		arkhamAssetsDir: config.arkhamAssetsDir,
		logger: appLog,
	});

	const botConfigs = loadBotConfigs(db);
	await botManager.start(botConfigs);
	appLog.info("机器人已启动", {
		total: botConfigs.length,
		enabled: botConfigs.filter((b) => b.enabled).length,
		model: settings.model,
	});

	// 管理端 HTTP（Hono）。
	const admin = await startAdminServer({
		db,
		botManager,
		logBus,
		host: config.admin.host,
		port: config.admin.port,
		webDistDir: config.admin.webDistDir,
	});

	const shutdown = async () => {
		appLog.info("关闭中...");
		await admin.close().catch(() => {});
		await botManager.shutdown().catch(() => {});
		// WAL 模式下直接关闭即可。
		try {
			db.close();
		} catch {
			/* ignore */
		}
	};

	return { db, botManager, settings, models, admin, shutdown };
}

/**
 * 创建 Models 实例并注册 provider：
 * - 注册全部内置 provider（Anthropic 官方/OpenAI/DeepSeek/...）。
 * - 当配置了自定义 Anthropic 兼容端点（如 DeepSeek/智谱）时，用该端点重建 anthropic provider，
 *   并把 model 指定的模型注册进去。
 * - 当配置了自定义 OpenAI Chat Completions 兼容端点时，用该端点重建 openai provider。
 */
export function buildModels(settings: ResolvedSettings): { models: Models; model: Model<any> } {
	const models = createModels();
	for (const provider of builtinProviders.builtinProviders()) {
		(models as ReturnType<typeof createModels>).setProvider(provider);
	}

	if (settings.anthropicBaseUrl) {
		const { provider: providerId, modelId } = parseModelSpec(settings.model);
		if (providerId === "anthropic") {
			const base = anthropicProvider();
			const customModel: Model<"anthropic-messages"> = {
				id: modelId,
				name: modelId,
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: settings.anthropicBaseUrl,
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 8192,
			};
			const customProvider = createProvider({
				id: "anthropic",
				name: "Anthropic (custom endpoint)",
				baseUrl: settings.anthropicBaseUrl,
				auth: base.auth,
				models: [customModel],
				api: anthropicMessagesApi(),
			});
			(models as ReturnType<typeof createModels>).setProvider(customProvider);
		}
	}

	// 自定义 OpenAI Chat Completions 兼容端点（如 OpenRouter / 各种代理）。
	// model 格式: openai/<model-id>，baseUrl 去 /v1/chat/completions 后缀。
	if (settings.openaiBaseUrl) {
		const { provider: providerId, modelId } = parseModelSpec(settings.model);
		if (providerId === "openai") {
			const customModel: Model<"openai-completions"> = {
				id: modelId,
				name: modelId,
				api: "openai-completions",
				provider: "openai",
				baseUrl: settings.openaiBaseUrl,
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 8192,
			};
			const customProvider = createProvider({
				id: "openai",
				name: "OpenAI (custom endpoint)",
				baseUrl: settings.openaiBaseUrl,
				auth: openaiProvider().auth,
				models: [customModel],
				api: openAICompletionsApi(),
			});
			(models as ReturnType<typeof createModels>).setProvider(customProvider);
		}
	}

	const model = resolveModel(models, settings.model);
	return { models, model };
}

/** 解析 `provider/model` 形式的模型字符串为 { provider, modelId }。 */
export function parseModelSpec(spec: string): { provider: string; modelId: string } {
	const slash = spec.indexOf("/");
	if (slash <= 0) {
		throw new Error(`Invalid model spec "${spec}", expected "<provider>/<model-id>"`);
	}
	return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/** 解析 `provider/model` 形式的模型字符串为 Model 对象。 */
function resolveModel(models: Models, spec: string): Model<any> {
	const { provider, modelId } = parseModelSpec(spec);
	const model = models.getModel(provider, modelId);
	if (!model) {
		const available = models.getModels(provider).map((m) => m.id).slice(0, 20).join(", ");
		throw new Error(`Model not found: ${spec}. Available in ${provider}: ${available || "(none)"}`);
	}
	return model;
}

// 重新导出供 admin-api 使用。
export { BotRepository, SettingsRepository };
