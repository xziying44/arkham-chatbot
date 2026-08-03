import type { DatabaseSync } from "./db.ts";

/** 管理端登录会话（cookie token → 过期时间）。 */
export interface AdminSessionRecord {
	readonly token: string;
	readonly createdAt: number;
	readonly expiresAt: number;
}

export class AdminSessionRepository {
	constructor(private readonly db: DatabaseSync) {}

	insert(token: string, ttlMs: number): AdminSessionRecord {
		const now = Date.now();
		const expiresAt = now + ttlMs;
		this.db
			.prepare("INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)")
			.run(token, now, expiresAt);
		return { token, createdAt: now, expiresAt };
	}

	/** 取会话；已过期返回 undefined（不自动删除，由清理任务处理）。 */
	get(token: string): AdminSessionRecord | undefined {
		const row = this.db.prepare("SELECT * FROM admin_sessions WHERE token = ?").get(token) as
			| Record<string, unknown>
			| undefined;
		if (!row) return undefined;
		const rec = { token: row.token as string, createdAt: row.created_at as number, expiresAt: row.expires_at as number };
		if (rec.expiresAt < Date.now()) return undefined;
		return rec;
	}

	delete(token: string): void {
		this.db.prepare("DELETE FROM admin_sessions WHERE token = ?").run(token);
	}

	/** 删除所有已过期会话。返回删除条数。 */
	pruneExpired(): number {
		const info = this.db.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").run(Date.now());
		return Number(info.changes);
	}
}
