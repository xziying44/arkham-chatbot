import type { DatabaseSync } from "./db.ts";
import type { PagedResult } from "./messages.ts";
import type { SQLInputValue } from "node:sqlite";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
	readonly id: number;
	readonly ts: number;
	readonly level: LogLevel;
	readonly source: string | null;
	readonly botId: string | null;
	readonly scope: string | null;
	readonly message: string;
	/** 附加字段（JSON 字符串）。 */
	readonly fields: string | null;
}

export interface LogInsert {
	readonly ts?: number;
	readonly level: LogLevel;
	readonly source?: string | null;
	readonly botId?: string | null;
	readonly scope?: string | null;
	readonly message: string;
	readonly fields?: string | null;
}

export interface LogQuery {
	readonly level?: LogLevel;
	readonly source?: string;
	readonly botId?: string;
	readonly q?: string; // message LIKE
	readonly page?: number;
	readonly size?: number;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function rowToLog(row: Record<string, unknown>): LogRecord {
	return {
		id: row.id as number,
		ts: row.ts as number,
		level: row.level as LogLevel,
		source: (row.source as string | null) ?? null,
		botId: (row.bot_id as string | null) ?? null,
		scope: (row.scope as string | null) ?? null,
		message: row.message as string,
		fields: (row.fields as string | null) ?? null,
	};
}

export class LogRepository {
	constructor(private readonly db: DatabaseSync) {}

	insert(input: LogInsert): LogRecord {
		const ts = input.ts ?? Date.now();
		const info = this.db
			.prepare(
				`INSERT INTO logs (ts, level, source, bot_id, scope, message, fields)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(ts, input.level, input.source ?? null, input.botId ?? null, input.scope ?? null, input.message, input.fields ?? null);
		const row = this.db.prepare("SELECT * FROM logs WHERE id = ?").get(Number(info.lastInsertRowid)) as Record<string, unknown>;
		return rowToLog(row);
	}

	list(query: LogQuery): PagedResult<LogRecord> {
		const where: string[] = [];
		const args: SQLInputValue[] = [];
		if (query.level) {
			where.push("level = ?");
			args.push(query.level);
		}
		if (query.source) {
			where.push("source = ?");
			args.push(query.source);
		}
		if (query.botId) {
			where.push("bot_id = ?");
			args.push(query.botId);
		}
		if (query.q) {
			where.push("message LIKE ?");
			args.push(`%${query.q}%`);
		}
		const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
		const page = Math.max(1, query.page ?? 1);
		const size = Math.min(500, Math.max(1, query.size ?? 100));
		const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM logs ${whereSql}`).get(...args) as { c: number }).c;
		const rows = this.db
			.prepare(`SELECT * FROM logs ${whereSql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
			.all(...args, size, (page - 1) * size) as Record<string, unknown>[];
		return { items: rows.map(rowToLog), page, size, total };
	}
}

export { LEVEL_RANK };
