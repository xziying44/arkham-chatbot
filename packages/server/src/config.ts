import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DEFAULT_DATA_DIR = resolve(PROJECT_ROOT, "data");
const DEFAULT_PROMPTS_DIR = resolve(PROJECT_ROOT, "prompts");

/**
 * 从环境变量解析出的应用配置。
 *
 * 多机器人上线后，QQ 凭证、模型、persona 等转入 SQLite（bots / settings 表），
 * 可在管理端动态增改。这里的 env 仅作 **首次启动的引导默认值**：
 * 首次起库时若 DB 为空，用 env 的 QQ 凭证种一条默认机器人，用 env 的 LLM 配置写默认设置。
 * 之后以 DB 为准。其它（端口/数据目录等基础设施）仍始终读 env。
 */
export interface AppConfig {
	/** 引导用的默认 QQ 凭证（仅首次种库用；后续以 DB 为准）。 */
	readonly qq: { appId: string; appSecret: string; apiBase: string };
	/** 引导用的默认模型规格 "<provider>/<model-id>"。 */
	readonly model: string;
	readonly llm: {
		/** 自定义 Anthropic 兼容端点（如智谱/DeepSeek）。未设则用官方 api.anthropic.com。 */
		readonly anthropicBaseUrl?: string;
		/** 自定义 OpenAI Chat Completions 兼容端点。未设则用官方 api.openai.com。 */
		readonly openaiBaseUrl?: string;
	};
	readonly session: { ttlMs: number; reaperIntervalMs: number };
	/** 思考程度默认值: off/low/medium/high/max。管理端可改。 */
	readonly thinkingLevel: string;
	readonly sandbox: { enabled: boolean; networkDisabled: boolean; timeoutSeconds: number };
	/** 运行时数据根目录（机器人 scope 工作区与持久任务产物）。 */
	readonly dataDir: string;
	/** v2 外置提示词目录。 */
	readonly promptsDir: string;
	/** arkham-workshop CLI 二进制路径（制卡服务使用）。可选。 */
	readonly arkhamBinPath?: string;
	/** arkham-workshop 资产目录（字体/图片/cardback）。可选。 */
	readonly arkhamAssetsDir?: string;
	/**
	 * 卡牌数据库根目录（宿主机绝对路径，含 json/ + card_images/）。
	 * 配置后 search_cards 工具可用，并只读挂载到沙箱 cards-db/ 供 agent 查询/发图。
	 * 未配置则 search_cards 不装配（优雅降级）。
	 */
	readonly cardDatabaseDir?: string;
	/**
	 * MiniMax 文生图（generate_image 工具）。配置了 apiKey 才装配该工具。
	 * key 只存在于宿主机进程内存（由 .env 注入），不进沙箱——沙箱断网 + 命令护栏
	 * 双重隔离，agent 只能拿到生成结果图。
	 */
	readonly minimax?: {
		readonly apiKey: string;
		readonly apiBase?: string;
	};
	/** 引导用的默认 persona（仅首次种库用）。 */
	readonly persona?: string;
	/** SQLite 数据库文件路径（机器人账号/设置/消息/日志）。 */
	readonly dbPath: string;
	/** 管理端 HTTP 服务监听地址。 */
	readonly admin: {
		readonly host: string;
		readonly port: number;
		/** admin-web 构建产物目录（SPA 静态文件）。 */
		readonly webDistDir?: string;
	};
	/** 引导管理员账号（仅首次种库用）。 */
	readonly bootstrapAdmin: {
		readonly username: string;
		readonly password?: string;
	};
}

function optional(name: string): string | undefined {
	const v = process.env[name];
	return v && v.trim() !== "" ? v : undefined;
}

function int(name: string, fallback: number): number {
	const v = process.env[name];
	if (v === undefined || v.trim() === "") return fallback;
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid env ${name}: ${v}`);
	return n;
}

function bool(name: string, fallback: boolean): boolean {
	const v = process.env[name];
	if (v === undefined) return fallback;
	return v === "true" || v === "1";
}

/** 从 process.env 读取并校验配置。 */
export function loadConfig(): AppConfig {
	const dataDir = process.env.CHATBOT_DATA_DIR
		? resolve(PROJECT_ROOT, process.env.CHATBOT_DATA_DIR)
		: DEFAULT_DATA_DIR;
	const promptsDir = process.env.CHATBOT_PROMPTS_DIR
		? resolve(PROJECT_ROOT, process.env.CHATBOT_PROMPTS_DIR)
		: DEFAULT_PROMPTS_DIR;
	// arkham-workshop 相关路径：默认从 ARKHAM_WORKSHOP_DIR 推导，或单独指定。
	const arkhamWorkshopDir = optional("ARKHAM_WORKSHOP_DIR");
	return {
		promptsDir,
		arkhamBinPath: optional("ARKHAM_CLI_PATH")
			?? (arkhamWorkshopDir ? resolve(arkhamWorkshopDir, "target/release/arkham-cli") : undefined),
		arkhamAssetsDir: optional("ARKHAM_ASSETS_DIR")
			?? (arkhamWorkshopDir ? resolve(arkhamWorkshopDir, "assets") : undefined),
		cardDatabaseDir: optional("CHATBOT_CARD_DATABASE_DIR"),
		minimax: (() => {
			const apiKey = optional("MINIMAX_API_KEY");
			return apiKey ? { apiKey, apiBase: optional("MINIMAX_API_BASE") } : undefined;
		})(),
		qq: {
			appId: optional("QQ_APP_ID") ?? "",
			appSecret: optional("QQ_APP_SECRET") ?? "",
			apiBase: process.env.QQ_API_BASE ?? "https://api.sgroup.qq.com",
		},
		model: optional("CHATBOT_MODEL") ?? "anthropic/deepseek-v4-flash",
		llm: {
			anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
			openaiBaseUrl: process.env.OPENAI_BASE_URL,
		},
		session: {
			ttlMs: int("CHATBOT_SESSION_TTL_MS", 3_600_000),
			reaperIntervalMs: int("CHATBOT_REAPER_INTERVAL_MS", 60_000),
		},
		thinkingLevel: optional("CHATBOT_THINKING_LEVEL") ?? "low",
		sandbox: {
			enabled: bool("CHATBOT_SANDBOX_ENABLED", true),
			networkDisabled: bool("CHATBOT_SANDBOX_NETWORK_DISABLED", true),
			timeoutSeconds: int("CHATBOT_SANDBOX_TIMEOUT_SECONDS", 30),
		},
		dataDir,
		persona: process.env.CHATBOT_PERSONA,
		dbPath: process.env.CHATBOT_DB_PATH
			? resolve(PROJECT_ROOT, process.env.CHATBOT_DB_PATH)
			: resolve(dataDir, "chatbot.db"),
		admin: {
			host: process.env.ADMIN_HOST ?? "127.0.0.1",
			port: int("ADMIN_PORT", 5180),
			webDistDir: optional("ADMIN_WEB_DIST"),
		},
		bootstrapAdmin: {
			username: process.env.ADMIN_USERNAME ?? "admin",
			password: optional("ADMIN_PASSWORD"),
		},
	};
}
