import type { DatabaseSync } from "./db.ts";

/**
 * 全局设置 KV 表。
 *
 * key 命名约定（`SettingsKeys` 常量集中定义）：
 *   llm_model                       — "<provider>/<model-id>"
 *   llm_anthropic_base_url          — 自定义 Anthropic 兼容端点（可选）
 *   session_ttl_ms                  — 会话回收阈值（毫秒）
 *   sandbox_enabled                 — "true"|"false"
 *   sandbox_network_disabled        — "true"|"false"
 *   sandbox_timeout_seconds         — 沙箱命令超时（秒）
 *   admin_username                  — 管理端用户名
 *   admin_password_hash             — scrypt 哈希（hex）
 *   admin_password_salt             — scrypt 盐（hex）
 */
export const SettingsKeys = {
	llmModel: "llm_model",
	llmAnthropicBaseUrl: "llm_anthropic_base_url",
	sessionTtlMs: "session_ttl_ms",
	sandboxEnabled: "sandbox_enabled",
	sandboxNetworkDisabled: "sandbox_network_disabled",
	sandboxTimeoutSeconds: "sandbox_timeout_seconds",
	adminUsername: "admin_username",
	adminPasswordHash: "admin_password_hash",
	adminPasswordSalt: "admin_password_salt",
} as const;

export type SettingsMap = Record<string, string>;

export class SettingsRepository {
	constructor(private readonly db: DatabaseSync) {}

	get(key: string): string | undefined {
		const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
			| { value: string }
			| undefined;
		return row?.value;
	}

	/** 取值，缺失时返回 fallback。 */
	getOr(key: string, fallback: string): string {
		return this.get(key) ?? fallback;
	}

	getInt(key: string, fallback: number): number {
		const v = this.get(key);
		if (v === undefined) return fallback;
		const n = Number.parseInt(v, 10);
		return Number.isFinite(n) ? n : fallback;
	}

	getBool(key: string, fallback: boolean): boolean {
		const v = this.get(key);
		if (v === undefined) return fallback;
		return v === "true" || v === "1";
	}

	set(key: string, value: string): void {
		this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
	}

	/** 批量设置（单事务）。 */
	setMany(entries: Record<string, string>): void {
		const stmt = this.db.prepare(
			"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		);
		this.db.exec("BEGIN");
		try {
			for (const [k, v] of Object.entries(entries)) stmt.run(k, v);
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	all(): SettingsMap {
		const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
		const out: SettingsMap = {};
		for (const r of rows) out[r.key] = r.value;
		return out;
	}
}
