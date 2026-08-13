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

		-- 会话完整归档：每条 agent 消息（user/assistant/toolResult）一行，content_json 存完整
		-- content blocks（含工具调用参数与结果）。用于后台查阅完整对话、搜索、训练导出。
		-- dispose 压缩 session.jsonl 不影响本表（不可变原始记录）。
		CREATE TABLE IF NOT EXISTS conversations (
			id            TEXT PRIMARY KEY,
			content_hash  TEXT NOT NULL,
			bot_id        TEXT NOT NULL,
			scope_kind    TEXT NOT NULL,
			scope_id      TEXT NOT NULL,
			member_id     TEXT,
			run_id        TEXT,
			ts            INTEGER NOT NULL,
			role          TEXT NOT NULL,
			content_json  TEXT NOT NULL,
			stop_reason   TEXT,
			model         TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_conv_scope_ts ON conversations(scope_kind, scope_id, ts DESC);
		CREATE INDEX IF NOT EXISTS idx_conv_bot_ts   ON conversations(bot_id, ts DESC);
		CREATE INDEX IF NOT EXISTS idx_conv_run      ON conversations(run_id);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_hash ON conversations(content_hash);

		-- 会话 scope 摘要：dispose 压缩时把 compactionSummary 的摘要文本存这里，
		-- 供后台「会话归档」列表展示（每个 scope 一行，带摘要 + 时间范围 + 消息数）。
		-- 点进去看该 scope 的完整消息（conversations 表）。
		CREATE TABLE IF NOT EXISTS scope_summaries (
			bot_id        TEXT NOT NULL,
			scope_kind    TEXT NOT NULL,
			scope_id      TEXT NOT NULL,
			member_id     TEXT,
			summary       TEXT NOT NULL,     -- dispose 时 compact() 生成的 LLM 摘要
			message_count INTEGER NOT NULL DEFAULT 0,
			first_ts      INTEGER,
			last_ts       INTEGER,
			updated_at    INTEGER NOT NULL,
			PRIMARY KEY (bot_id, scope_kind, scope_id, member_id)
		);
		CREATE INDEX IF NOT EXISTS idx_summaries_bot_ts ON scope_summaries(bot_id, updated_at DESC);

		-- 训练样本：每次 agent run（用户一条消息触发的完整处理）一行。
		-- sample_json 存完整快照：systemPrompt + 本次 run 的完整消息序列（user/assistant/toolResult，
		-- 含工具调用参数与结果、reasoning_content）+ 模型/参数元信息。自包含，可直接用于训练。
		CREATE TABLE IF NOT EXISTS training_samples (
			id            TEXT PRIMARY KEY,     -- run_id
			bot_id        TEXT NOT NULL,
			scope_kind    TEXT NOT NULL,
			scope_id      TEXT NOT NULL,
			member_id     TEXT,
			ts            INTEGER NOT NULL,      -- run 开始时间
			preview       TEXT,                  -- 用户消息前 N 字（列表展示用）
			message_count INTEGER,
			status        TEXT,                  -- ok / error
			sample_json   TEXT NOT NULL,         -- 完整训练样本 JSON
			created_at    INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_train_bot_ts ON training_samples(bot_id, ts DESC);
		CREATE INDEX IF NOT EXISTS idx_train_scope  ON training_samples(scope_kind, scope_id, ts DESC);
	`);
}

export type { DatabaseSync } from "node:sqlite";
