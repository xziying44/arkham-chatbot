import { resolve } from "node:path";

/** 从环境变量解析出的应用配置。 */
export interface AppConfig {
	readonly qq: { appId: string; appSecret: string; apiBase: string };
	readonly model: string;
	readonly llm: {
		/** 自定义 Anthropic 兼容端点（如智谱 open.bigmodel.cn）。未设则用官方 api.anthropic.com。 */
		readonly anthropicBaseUrl?: string;
	};
	readonly session: { ttlMs: number; reaperIntervalMs: number };
	readonly sandbox: { enabled: boolean; networkDisabled: boolean; timeoutSeconds: number };
	readonly dataDir: string;
	readonly persona?: string;
}

function required(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required env: ${name}`);
	return v;
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
	return {
		qq: {
			appId: required("QQ_APP_ID"),
			appSecret: required("QQ_APP_SECRET"),
			apiBase: process.env.QQ_API_BASE ?? "https://api.sgroup.qq.com",
		},
		model: required("CHATBOT_MODEL"),
		llm: {
			anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
		},
		session: {
			ttlMs: int("CHATBOT_SESSION_TTL_MS", 3_600_000),
			reaperIntervalMs: int("CHATBOT_REAPER_INTERVAL_MS", 60_000),
		},
		sandbox: {
			enabled: bool("CHATBOT_SANDBOX_ENABLED", true),
			networkDisabled: bool("CHATBOT_SANDBOX_NETWORK_DISABLED", true),
			timeoutSeconds: int("CHATBOT_SANDBOX_TIMEOUT_SECONDS", 30),
		},
		dataDir: resolve(process.env.CHATBOT_DATA_DIR ?? "./data"),
		persona: process.env.CHATBOT_PERSONA,
	};
}
