import type { DatabaseSync } from "./db.ts";
import type { SQLInputValue } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";

/**
 * 会话完整归档记录。每条 agent 消息（user / assistant / toolResult）一行，
 * content_json 存完整 content blocks（含工具调用参数、工具结果、思考文字）。
 *
 * 用途：①后台查阅完整对话历史（含工具调用细节，messages 表只记 text）；②关键词搜索；
 * ③训练数据导出。dispose 压缩 session.jsonl 不影响本表——归档是不可变的原始完整记录。
 *
 * 去重：靠 content_hash（sha1(botId|scopeId|ts|role|contentJson)）唯一索引 + INSERT OR IGNORE。
 * 归档点在 bot-session runPrompt 的 appendAll（只写本轮增量），天然不重复；唯一索引兜底。
 */
export interface ConversationRecord {
	readonly id: string;
	readonly botId: string;
	readonly scopeKind: string;
	readonly scopeId: string;
	/** 群聊成员 openid（仅群聊成员会话）；私聊 null。 */
	readonly memberId: string | null;
	/** 一次 prompt run 的 id（聚合一轮对话的所有消息）。 */
	readonly runId: string | null;
	readonly ts: number;
	readonly role: string;
	/** 完整 content blocks 的 JSON 字符串。 */
	readonly contentJson: string;
	readonly stopReason: string | null;
	readonly model: string | null;
}

export interface ConversationInsert {
	readonly botId: string;
	readonly scopeKind: string;
	readonly scopeId: string;
	readonly memberId?: string | null;
	readonly runId?: string | null;
	readonly ts: number;
	readonly role: string;
	readonly contentJson: string;
	readonly stopReason?: string | null;
	readonly model?: string | null;
}

export interface ConversationQuery {
	readonly botId?: string;
	readonly scopeKind?: string;
	readonly scopeId?: string;
	readonly fromTs?: number;
	readonly toTs?: number;
	/** content_json LIKE 模糊匹配（搜索）。 */
	readonly search?: string;
	readonly page?: number;
	readonly size?: number;
}

export interface PagedResult<T> {
	readonly items: T[];
	readonly page: number;
	readonly size: number;
	readonly total: number;
}

/** 会话列表项（按 scope 聚合，后台「会话归档」页用）。 */
export interface ConversationScopeSummary {
	readonly scopeKind: string;
	readonly scopeId: string;
	readonly memberId: string | null;
	readonly messageCount: number;
	readonly firstTs: number;
	readonly lastTs: number;
	readonly lastPreview: string | null;
}

function rowToConversation(row: Record<string, unknown>): ConversationRecord {
	return {
		id: row.id as string,
		botId: row.bot_id as string,
		scopeKind: row.scope_kind as string,
		scopeId: row.scope_id as string,
		memberId: (row.member_id as string | null) ?? null,
		runId: (row.run_id as string | null) ?? null,
		ts: row.ts as number,
		role: row.role as string,
		contentJson: row.content_json as string,
		stopReason: (row.stop_reason as string | null) ?? null,
		model: (row.model as string | null) ?? null,
	};
}

/** 计算 content_hash 用于去重。 */
function contentHash(input: ConversationInsert): string {
	return createHash("sha1")
		.update(`${input.botId}|${input.scopeId}|${input.ts}|${input.role}|${input.contentJson}`)
		.digest("hex");
}

export class ConversationRepository {
	constructor(private readonly db: DatabaseSync) {}

	/** 插入一条（INSERT OR IGNORE 靠 content_hash 去重）。失败静默（归档不阻断会话）。 */
	insert(input: ConversationInsert): void {
		try {
			this.db
				.prepare(
					`INSERT OR IGNORE INTO conversations
					 (id, content_hash, bot_id, scope_kind, scope_id, member_id, run_id, ts, role, content_json, stop_reason, model)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					randomUUID(),
					contentHash(input),
					input.botId,
					input.scopeKind,
					input.scopeId,
					input.memberId ?? null,
					input.runId ?? null,
					input.ts,
					input.role,
					input.contentJson,
					input.stopReason ?? null,
					input.model ?? null,
				);
		} catch (e) {
			console.warn(`[conversations] insert 失败（忽略）: ${(e as Error).message}`);
		}
	}

	/** 批量插入（一个事务，失败回滚）。 */
	insertMany(inputs: ConversationInsert[]): void {
		if (inputs.length === 0) return;
		try {
			this.db.exec("BEGIN");
			for (const input of inputs) this.insert(input);
			this.db.exec("COMMIT");
		} catch (e) {
			try { this.db.exec("ROLLBACK"); } catch { /* */ }
			console.warn(`[conversations] insertMany 失败（回滚）: ${(e as Error).message}`);
		}
	}

	/** 分页查询（按时间升序，便于阅读完整对话）。 */
	list(query: ConversationQuery): PagedResult<ConversationRecord> {
		const where: string[] = [];
		const args: SQLInputValue[] = [];
		if (query.botId) { where.push("bot_id = ?"); args.push(query.botId); }
		if (query.scopeKind) { where.push("scope_kind = ?"); args.push(query.scopeKind); }
		if (query.scopeId) { where.push("scope_id = ?"); args.push(query.scopeId); }
		if (query.fromTs) { where.push("ts >= ?"); args.push(query.fromTs); }
		if (query.toTs) { where.push("ts <= ?"); args.push(query.toTs); }
		if (query.search) { where.push("content_json LIKE ?"); args.push(`%${query.search}%`); }
		const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
		const page = Math.max(1, query.page ?? 1);
		const size = Math.min(500, Math.max(1, query.size ?? 100));

		const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM conversations ${whereSql}`).get(...args) as { c: number }).c;
		const rows = this.db
			.prepare(`SELECT * FROM conversations ${whereSql} ORDER BY ts ASC, id ASC LIMIT ? OFFSET ?`)
			.all(...args, size, (page - 1) * size) as Record<string, unknown>[];
		return { items: rows.map(rowToConversation), page, size, total };
	}

	/** 按 scope 聚合的会话列表（后台页面用）。 */
	listScopes(botId: string): ConversationScopeSummary[] {
		const rows = this.db
			.prepare(
				`SELECT scope_kind, scope_id, member_id,
				        COUNT(*) AS message_count,
				        MIN(ts) AS first_ts,
				        MAX(ts) AS last_ts
				 FROM conversations
				 WHERE bot_id = ?
				 GROUP BY scope_kind, scope_id, member_id
				 ORDER BY last_ts DESC`,
			)
			.all(botId) as Record<string, unknown>[];
		return rows.map((row) => ({
			scopeKind: row.scope_kind as string,
			scopeId: row.scope_id as string,
			memberId: (row.member_id as string | null) ?? null,
			messageCount: row.message_count as number,
			firstTs: row.first_ts as number,
			lastTs: row.last_ts as number,
			lastPreview: null,
		}));
	}
}

/** scope 摘要记录（dispose 压缩时生成）。 */
export interface ScopeSummaryRecord {
	readonly botId: string;
	readonly scopeKind: string;
	readonly scopeId: string;
	readonly memberId: string | null;
	readonly summary: string;
	readonly messageCount: number;
	readonly firstTs: number | null;
	readonly lastTs: number | null;
	readonly updatedAt: number;
}

export interface ScopeSummaryUpsert {
	readonly botId: string;
	readonly scopeKind: string;
	readonly scopeId: string;
	readonly memberId?: string | null;
	readonly summary: string;
	readonly messageCount: number;
	readonly firstTs?: number | null;
	readonly lastTs?: number | null;
}

/**
 * scope 摘要仓库：dispose 压缩时把 compactionSummary 的 LLM 摘要 upsert 进来。
 * 后台「会话归档」列表展示用——每个 scope 一行，带摘要，点进去看完整消息。
 */
export class ScopeSummaryRepository {
	constructor(private readonly db: DatabaseSync) {}

	/** upsert（按 bot+scope+member 主键覆盖）。 */
	upsert(input: ScopeSummaryUpsert): void {
		try {
			this.db
				.prepare(
					`INSERT INTO scope_summaries (bot_id, scope_kind, scope_id, member_id, summary, message_count, first_ts, last_ts, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT (bot_id, scope_kind, scope_id, member_id) DO UPDATE SET
					   summary = excluded.summary,
					   message_count = excluded.message_count,
					   first_ts = excluded.first_ts,
					   last_ts = excluded.last_ts,
					   updated_at = excluded.updated_at`,
				)
				.run(
					input.botId,
					input.scopeKind,
					input.scopeId,
					input.memberId ?? null,
					input.summary,
					input.messageCount,
					input.firstTs ?? null,
					input.lastTs ?? null,
					Date.now(),
				);
		} catch (e) {
			console.warn(`[scope-summaries] upsert 失败（忽略）: ${(e as Error).message}`);
		}
	}

	/** 列出某 bot 的所有 scope 摘要（按更新时间倒序）。 */
	list(botId: string): ScopeSummaryRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM scope_summaries WHERE bot_id = ? ORDER BY updated_at DESC")
			.all(botId) as Record<string, unknown>[];
		return rows.map((row) => ({
			botId: row.bot_id as string,
			scopeKind: row.scope_kind as string,
			scopeId: row.scope_id as string,
			memberId: (row.member_id as string | null) ?? null,
			summary: row.summary as string,
			messageCount: row.message_count as number,
			firstTs: (row.first_ts as number | null) ?? null,
			lastTs: (row.last_ts as number | null) ?? null,
			updatedAt: row.updated_at as number,
		}));
	}
}
