import type { DatabaseSync } from "./db.ts";
import type { SQLInputValue } from "node:sqlite";

/** 机器人账号记录。 */
export interface BotRecord {
	readonly id: string;
	readonly appId: string;
	/** 凭证明文（本地库，gitignore；强度更高可加密，YAGNI 暂不做）。 */
	readonly appSecret: string;
	readonly name: string;
	readonly apiBase: string;
	readonly persona: string | null;
	readonly enabled: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** 新建机器人输入。 */
export interface BotInsert {
	readonly id: string;
	readonly appId: string;
	readonly appSecret: string;
	readonly name: string;
	readonly apiBase?: string;
	readonly persona?: string | null;
	readonly enabled?: boolean;
}

/** 更新机器人输入：所有字段可选（undefined 表示不改）。 */
export interface BotPatch {
	readonly appId?: string;
	readonly appSecret?: string;
	readonly name?: string;
	readonly apiBase?: string;
	readonly persona?: string | null;
	readonly enabled?: boolean;
}

function rowToBot(row: Record<string, unknown>): BotRecord {
	return {
		id: row.id as string,
		appId: row.app_id as string,
		appSecret: row.app_secret as string,
		name: row.name as string,
		apiBase: row.api_base as string,
		persona: (row.persona as string | null) ?? null,
		enabled: row.enabled === 1,
		createdAt: row.created_at as number,
		updatedAt: row.updated_at as number,
	};
}

export class BotRepository {
	constructor(private readonly db: DatabaseSync) {}

	list(): BotRecord[] {
		const rows = this.db.prepare("SELECT * FROM bots ORDER BY created_at ASC").all() as Record<string, unknown>[];
		return rows.map(rowToBot);
	}

	get(id: string): BotRecord | undefined {
		const row = this.db.prepare("SELECT * FROM bots WHERE id = ?").get(id) as Record<string, unknown> | undefined;
		return row ? rowToBot(row) : undefined;
	}

	insert(input: BotInsert): BotRecord {
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO bots (id, app_id, app_secret, name, api_base, persona, enabled, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.id,
				input.appId,
				input.appSecret,
				input.name,
				input.apiBase ?? "https://api.sgroup.qq.com",
				input.persona ?? null,
				input.enabled === false ? 0 : 1,
				now,
				now,
			);
		return this.get(input.id)!;
	}

	/** 更新：仅写入 patch 中提供的字段。 */
	update(id: string, patch: BotPatch): BotRecord | undefined {
		const sets: string[] = [];
		const args: SQLInputValue[] = [];
		if (patch.appId !== undefined) {
			sets.push("app_id = ?");
			args.push(patch.appId);
		}
		if (patch.appSecret !== undefined) {
			sets.push("app_secret = ?");
			args.push(patch.appSecret);
		}
		if (patch.name !== undefined) {
			sets.push("name = ?");
			args.push(patch.name);
		}
		if (patch.apiBase !== undefined) {
			sets.push("api_base = ?");
			args.push(patch.apiBase);
		}
		if (patch.persona !== undefined) {
			sets.push("persona = ?");
			args.push(patch.persona);
		}
		if (patch.enabled !== undefined) {
			sets.push("enabled = ?");
			args.push(patch.enabled ? 1 : 0);
		}
		if (sets.length === 0) return this.get(id);
		sets.push("updated_at = ?");
		args.push(Date.now());
		args.push(id);
		this.db.prepare(`UPDATE bots SET ${sets.join(", ")} WHERE id = ?`).run(...args);
		return this.get(id);
	}

	delete(id: string): boolean {
		const info = this.db.prepare("DELETE FROM bots WHERE id = ?").run(id);
		return Number(info.changes) > 0;
	}
}
