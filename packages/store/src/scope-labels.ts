import type { DatabaseSync } from "./db.ts";

/**
 * 会话备注（scope label）仓库。
 *
 * scope_id 是 32 位哈希（QQ openid），人类不可读。管理端给每个 scope 起可读名字。
 * 主键 (bot_id, scope_kind, scope_id) 唯一。
 */
export interface ScopeLabelRecord {
	readonly botId: string;
	readonly scopeKind: "group" | "user";
	readonly scopeId: string;
	readonly label: string;
	readonly updatedAt: number;
}

export class ScopeLabelRepository {
	constructor(private readonly db: DatabaseSync) {}

	/** 取某 bot 下所有 scope 备注。 */
	list(botId: string): ScopeLabelRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM scope_labels WHERE bot_id = ? ORDER BY updated_at DESC")
			.all(botId) as Record<string, unknown>[];
		return rows.map((r) => ({
			botId: r.bot_id as string,
			scopeKind: r.scope_kind as "group" | "user",
			scopeId: r.scope_id as string,
			label: r.label as string,
			updatedAt: r.updated_at as number,
		}));
	}

	/** 取单条备注。 */
	get(botId: string, scopeKind: string, scopeId: string): ScopeLabelRecord | undefined {
		const row = this.db
			.prepare("SELECT * FROM scope_labels WHERE bot_id = ? AND scope_kind = ? AND scope_id = ?")
			.get(botId, scopeKind, scopeId) as Record<string, unknown> | undefined;
		if (!row) return undefined;
		return {
			botId: row.bot_id as string,
			scopeKind: row.scope_kind as "group" | "user",
			scopeId: row.scope_id as string,
			label: row.label as string,
			updatedAt: row.updated_at as number,
		};
	}

	/** 设置/更新备注（upsert）。 */
	set(botId: string, scopeKind: "group" | "user", scopeId: string, label: string): void {
		this.db
			.prepare(
				`INSERT INTO scope_labels (bot_id, scope_kind, scope_id, label, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(bot_id, scope_kind, scope_id) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`,
			)
			.run(botId, scopeKind, scopeId, label, Date.now());
	}

	/** 删除备注。 */
	delete(botId: string, scopeKind: string, scopeId: string): boolean {
		const info = this.db
			.prepare("DELETE FROM scope_labels WHERE bot_id = ? AND scope_kind = ? AND scope_id = ?")
			.run(botId, scopeKind, scopeId);
		return Number(info.changes) > 0;
	}
}
