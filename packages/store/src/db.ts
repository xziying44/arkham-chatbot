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

			CREATE TABLE IF NOT EXISTS agent_tasks (
				id TEXT PRIMARY KEY,
				bot_id TEXT NOT NULL,
				scope_kind TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				scene TEXT NOT NULL,
				creator_id TEXT NOT NULL,
				title TEXT NOT NULL,
				status TEXT NOT NULL,
				state_json TEXT NOT NULL DEFAULT '{}',
				latest_artifact_id TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_agent_tasks_scope
				ON agent_tasks(bot_id, scope_kind, scope_id, updated_at DESC);
			CREATE INDEX IF NOT EXISTS idx_agent_tasks_creator
				ON agent_tasks(bot_id, scope_kind, scope_id, creator_id, updated_at DESC);

			CREATE TABLE IF NOT EXISTS conversation_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				bot_id TEXT NOT NULL,
				scope_kind TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				task_id TEXT,
				direction TEXT NOT NULL,
				sender_id TEXT,
				visible_text TEXT NOT NULL DEFAULT '',
				model_content TEXT NOT NULL DEFAULT '',
				token_count INTEGER NOT NULL DEFAULT 0,
				compacted INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_conversation_events_scope
				ON conversation_events(bot_id, scope_kind, scope_id, id DESC);
			CREATE INDEX IF NOT EXISTS idx_conversation_events_task
				ON conversation_events(task_id, id DESC);

			CREATE TABLE IF NOT EXISTS task_artifacts (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				version INTEGER NOT NULL,
				relative_path TEXT NOT NULL,
				metadata_json TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL
			);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_task_artifacts_version
				ON task_artifacts(task_id, kind, version);

			CREATE TABLE IF NOT EXISTS conversation_segments (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				bot_id TEXT NOT NULL,
				scope_kind TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				first_event_id INTEGER NOT NULL,
				last_event_id INTEGER NOT NULL,
				summary TEXT NOT NULL,
				keywords_json TEXT NOT NULL DEFAULT '[]',
				token_count INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_conversation_segments_scope
				ON conversation_segments(bot_id, scope_kind, scope_id, id DESC);

			CREATE TABLE IF NOT EXISTS memory_entries (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				bot_id TEXT NOT NULL,
				scope_kind TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				category TEXT NOT NULL,
				content TEXT NOT NULL,
				triggers_json TEXT NOT NULL DEFAULT '[]',
				source_event_id INTEGER,
				status TEXT NOT NULL DEFAULT 'active',
				use_count INTEGER NOT NULL DEFAULT 0,
				last_used_at INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_entries_scope
				ON memory_entries(bot_id, scope_kind, scope_id, status, updated_at DESC);

			CREATE TABLE IF NOT EXISTS agent_runs (
				id TEXT PRIMARY KEY,
				bot_id TEXT NOT NULL,
				scope_kind TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				task_id TEXT,
				scene TEXT NOT NULL,
				route_method TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				completed_at INTEGER,
				queue_duration_ms INTEGER NOT NULL DEFAULT 0,
				first_feedback_ms INTEGER,
				duration_ms INTEGER,
				model_call_count INTEGER NOT NULL DEFAULT 0,
				tool_call_count INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL,
				error TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC);
			CREATE INDEX IF NOT EXISTS idx_agent_runs_scene ON agent_runs(scene, started_at DESC);

			CREATE TABLE IF NOT EXISTS model_calls (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				provider TEXT NOT NULL,
				api TEXT NOT NULL,
				model TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				duration_ms INTEGER NOT NULL,
				input_tokens_total INTEGER NOT NULL DEFAULT 0,
				input_tokens_uncached INTEGER NOT NULL DEFAULT 0,
				cache_read_tokens INTEGER NOT NULL DEFAULT 0,
				cache_write_tokens INTEGER NOT NULL DEFAULT 0,
				output_tokens INTEGER NOT NULL DEFAULT 0,
				tool_call_count INTEGER NOT NULL DEFAULT 0,
				stop_reason TEXT,
				status TEXT NOT NULL,
				error TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_model_calls_run ON model_calls(run_id, sequence);
			CREATE INDEX IF NOT EXISTS idx_model_calls_started ON model_calls(started_at DESC);
	`);
}

export type { DatabaseSync } from "node:sqlite";
