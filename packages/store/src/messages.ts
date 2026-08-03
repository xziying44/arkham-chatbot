import type { DatabaseSync } from "./db.ts";
import type { SQLInputValue } from "node:sqlite";

/** 消息流水记录（入站 + 出站）。 */
export interface MessageRecord {
	readonly id: number;
	readonly botId: string;
	readonly ts: number;
	/** "in" 入站（用户发的）；"out" 出站（机器人回的）。 */
	readonly direction: "in" | "out";
	readonly scopeKind: "group" | "user";
	readonly scopeId: string;
	readonly senderId: string | null;
	readonly senderName: string | null;
	readonly text: string | null;
	readonly platformMsgId: string | null;
	/** "ok" | "error"；入站通常 null。 */
	readonly status: string | null;
	readonly error: string | null;
}

export interface MessageInsert {
	readonly botId: string;
	readonly ts?: number;
	readonly direction: "in" | "out";
	readonly scopeKind: "group" | "user";
	readonly scopeId: string;
	readonly senderId?: string | null;
	readonly senderName?: string | null;
	readonly text?: string | null;
	readonly platformMsgId?: string | null;
	readonly status?: string | null;
	readonly error?: string | null;
}

export interface MessageQuery {
	readonly botId?: string;
	readonly scopeKind?: string;
	readonly scopeId?: string;
	readonly direction?: "in" | "out";
	readonly text?: string; // LIKE 模糊匹配
	readonly page?: number; // 从 1 开始，默认 1
	readonly size?: number; // 默认 50
}

export interface PagedResult<T> {
	readonly items: T[];
	readonly page: number;
	readonly size: number;
	readonly total: number;
}

function rowToMessage(row: Record<string, unknown>): MessageRecord {
	return {
		id: row.id as number,
		botId: row.bot_id as string,
		ts: row.ts as number,
		direction: row.direction as "in" | "out",
		scopeKind: row.scope_kind as "group" | "user",
		scopeId: row.scope_id as string,
		senderId: (row.sender_id as string | null) ?? null,
		senderName: (row.sender_name as string | null) ?? null,
		text: (row.text as string | null) ?? null,
		platformMsgId: (row.platform_msg_id as string | null) ?? null,
		status: (row.status as string | null) ?? null,
		error: (row.error as string | null) ?? null,
	};
}

export class MessageRepository {
	constructor(private readonly db: DatabaseSync) {}

	insert(input: MessageInsert): MessageRecord {
		const ts = input.ts ?? Date.now();
		const stmt = this.db.prepare(
			`INSERT INTO messages (bot_id, ts, direction, scope_kind, scope_id, sender_id, sender_name, text, platform_msg_id, status, error)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const info = stmt.run(
			input.botId,
			ts,
			input.direction,
			input.scopeKind,
			input.scopeId,
			input.senderId ?? null,
			input.senderName ?? null,
			input.text ?? null,
			input.platformMsgId ?? null,
			input.status ?? null,
			input.error ?? null,
		);
		const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(Number(info.lastInsertRowid)) as Record<string, unknown>;
		return rowToMessage(row);
	}

	list(query: MessageQuery): PagedResult<MessageRecord> {
		const where: string[] = [];
		const args: SQLInputValue[] = [];
		if (query.botId) {
			where.push("bot_id = ?");
			args.push(query.botId);
		}
		if (query.scopeKind) {
			where.push("scope_kind = ?");
			args.push(query.scopeKind);
		}
		if (query.scopeId) {
			where.push("scope_id = ?");
			args.push(query.scopeId);
		}
		if (query.direction) {
			where.push("direction = ?");
			args.push(query.direction);
		}
		if (query.text) {
			where.push("text LIKE ?");
			args.push(`%${query.text}%`);
		}
		const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
		const page = Math.max(1, query.page ?? 1);
		const size = Math.min(200, Math.max(1, query.size ?? 50));

		const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM messages ${whereSql}`).get(...args) as { c: number }).c;
		const rows = this.db
			.prepare(`SELECT * FROM messages ${whereSql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
			.all(...args, size, (page - 1) * size) as Record<string, unknown>[];
		return { items: rows.map(rowToMessage), page, size, total };
	}
}
