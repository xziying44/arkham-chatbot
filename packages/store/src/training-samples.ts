import type { DatabaseSync } from "./db.ts";
import type { SQLInputValue } from "node:sqlite";

/**
 * 训练样本归档：每次 agent run（用户一条消息 → 完整处理 → 回复）一行。
 *
 * sample_json 是自包含的训练样本，含：
 * - systemPrompt：activate 时构建的完整系统提示词
 * - messages：本次 run 的完整消息序列（user + assistant + toolResult，含工具调用参数/结果）
 * - reasoning：每轮 assistant 的 reasoning_content（DeepSeek 思考链）
 * - model / thinkingLevel / stopReason 等元信息
 *
 * 与 conversations 表的区别：conversations 是所有消息逐条平铺（浏览/搜索用）；
 * training_samples 是按 run 聚合的完整快照（训练用，自包含）。
 */
export interface TrainingSampleRecord {
	readonly id: string;
	readonly botId: string;
	readonly scopeKind: string;
	readonly scopeId: string;
	readonly memberId: string | null;
	readonly ts: number;
	readonly preview: string | null;
	readonly messageCount: number | null;
	readonly status: string | null;
	readonly sampleJson: string;
	readonly createdAt: number;
}

export interface TrainingSampleInsert {
	readonly id: string;
	readonly botId: string;
	readonly scopeKind: string;
	readonly scopeId: string;
	readonly memberId?: string | null;
	readonly ts: number;
	readonly preview?: string | null;
	readonly messageCount?: number;
	readonly status?: string | null;
	readonly sampleJson: string;
}

export interface TrainingSampleQuery {
	readonly botId?: string;
	readonly scopeKind?: string;
	readonly scopeId?: string;
	readonly fromTs?: number;
	readonly toTs?: number;
	readonly page?: number;
	readonly size?: number;
}

export interface PagedResult<T> {
	readonly items: T[];
	readonly page: number;
	readonly size: number;
	readonly total: number;
}

function rowToSample(row: Record<string, unknown>): TrainingSampleRecord {
	return {
		id: row.id as string,
		botId: row.bot_id as string,
		scopeKind: row.scope_kind as string,
		scopeId: row.scope_id as string,
		memberId: (row.member_id as string | null) ?? null,
		ts: row.ts as number,
		preview: (row.preview as string | null) ?? null,
		messageCount: (row.message_count as number | null) ?? null,
		status: (row.status as string | null) ?? null,
		sampleJson: row.sample_json as string,
		createdAt: row.created_at as number,
	};
}

export class TrainingSampleRepository {
	constructor(private readonly db: DatabaseSync) {}

	/** 插入（INSERT OR REPLACE，靠 run_id 主键）。失败静默。 */
	insert(input: TrainingSampleInsert): void {
		try {
			this.db
				.prepare(
					`INSERT OR REPLACE INTO training_samples
					 (id, bot_id, scope_kind, scope_id, member_id, ts, preview, message_count, status, sample_json, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					input.id,
					input.botId,
					input.scopeKind,
					input.scopeId,
					input.memberId ?? null,
					input.ts,
					input.preview ?? null,
					input.messageCount ?? null,
					input.status ?? null,
					input.sampleJson,
					Date.now(),
				);
		} catch (e) {
			console.warn(`[training-samples] insert 失败（忽略）: ${(e as Error).message}`);
		}
	}

	/** 分页查询（按时间倒序）。不返回 sample_json（列表展示用，详情单独取）。 */
	list(query: TrainingSampleQuery): PagedResult<Omit<TrainingSampleRecord, "sampleJson">> {
		const where: string[] = [];
		const args: SQLInputValue[] = [];
		if (query.botId) { where.push("bot_id = ?"); args.push(query.botId); }
		if (query.scopeKind) { where.push("scope_kind = ?"); args.push(query.scopeKind); }
		if (query.scopeId) { where.push("scope_id = ?"); args.push(query.scopeId); }
		if (query.fromTs) { where.push("ts >= ?"); args.push(query.fromTs); }
		if (query.toTs) { where.push("ts <= ?"); args.push(query.toTs); }
		const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
		const page = Math.max(1, query.page ?? 1);
		const size = Math.min(500, Math.max(1, query.size ?? 50));

		const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM training_samples ${whereSql}`).get(...args) as { c: number }).c;
		const rows = this.db
			.prepare(`SELECT id, bot_id, scope_kind, scope_id, member_id, ts, preview, message_count, status, created_at
			          FROM training_samples ${whereSql} ORDER BY ts DESC LIMIT ? OFFSET ?`)
			.all(...args, size, (page - 1) * size) as Record<string, unknown>[];
		return {
			items: rows.map((row) => ({
				id: row.id as string,
				botId: row.bot_id as string,
				scopeKind: row.scope_kind as string,
				scopeId: row.scope_id as string,
				memberId: (row.member_id as string | null) ?? null,
				ts: row.ts as number,
				preview: (row.preview as string | null) ?? null,
				messageCount: (row.message_count as number | null) ?? null,
				status: (row.status as string | null) ?? null,
				createdAt: row.created_at as number,
			})),
			page,
			size,
			total,
		};
	}

	/** 取单个样本的完整 JSON（详情/导出用）。 */
	get(id: string): TrainingSampleRecord | null {
		const row = this.db.prepare("SELECT * FROM training_samples WHERE id = ?").get(id) as Record<string, unknown> | undefined;
		return row ? rowToSample(row) : null;
	}
}
