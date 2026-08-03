import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

/**
 * 打开/创建 SQLite 数据库并自动执行建表迁移（幂等）。
 *
 * 使用 Node 内置 `node:sqlite`（无需原生依赖）。
 * `node:sqlite` 的 API 与 better-sqlite3 高度相似（同步、预编译语句），
 * 若未来需要切换为 better-sqlite3 仅需替换导入。
 */
export async function openDb(dbPath: string): Promise<DatabaseSync> {
	// 确保父目录存在（`:memory:` 无父目录，跳过）。
	if (dbPath !== ":memory:") {
		await mkdir(dirname(dbPath), { recursive: true });
	}
	const db = new DatabaseSync(dbPath);
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 5000;
	`);
	migrate(db);
	return db;
}

/** 幂等建表迁移。 */
function migrate(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS bots (
			id          TEXT PRIMARY KEY,
			app_id      TEXT NOT NULL,
			app_secret  TEXT NOT NULL,
			name        TEXT NOT NULL,
			api_base    TEXT NOT NULL DEFAULT 'https://api.sgroup.qq.com',
			persona     TEXT,
			enabled     INTEGER NOT NULL DEFAULT 1,
			created_at  INTEGER NOT NULL,
			updated_at  INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS settings (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS messages (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			bot_id          TEXT NOT NULL,
			ts              INTEGER NOT NULL,
			direction       TEXT NOT NULL,        -- 'in' | 'out'
			scope_kind      TEXT NOT NULL,        -- 'group' | 'user'
			scope_id        TEXT NOT NULL,
			sender_id       TEXT,
			sender_name     TEXT,
			text            TEXT,
			platform_msg_id TEXT,
			status          TEXT,                 -- 'ok' | 'error'
			error           TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_messages_bot_ts ON messages(bot_id, ts DESC);
		CREATE INDEX IF NOT EXISTS idx_messages_scope  ON messages(scope_kind, scope_id, ts DESC);

		CREATE TABLE IF NOT EXISTS logs (
			id      INTEGER PRIMARY KEY AUTOINCREMENT,
			ts      INTEGER NOT NULL,
			level   TEXT NOT NULL,
			source  TEXT,
			bot_id  TEXT,
			scope   TEXT,
			message TEXT NOT NULL,
			fields  TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_logs_ts    ON logs(ts DESC);
		CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, ts DESC);

		CREATE TABLE IF NOT EXISTS admin_sessions (
			token       TEXT PRIMARY KEY,
			created_at  INTEGER NOT NULL,
			expires_at  INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS scope_labels (
			bot_id      TEXT NOT NULL,
			scope_kind  TEXT NOT NULL,
			scope_id    TEXT NOT NULL,
			label       TEXT NOT NULL,
			updated_at  INTEGER NOT NULL,
			PRIMARY KEY (bot_id, scope_kind, scope_id)
		);
	`);
}

export type { DatabaseSync } from "node:sqlite";
