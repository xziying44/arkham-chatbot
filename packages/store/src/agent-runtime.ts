import type { DatabaseSync } from "./db.ts";

export type ScopeKind = "group" | "user";
export type SceneId =
	| "chat"
	| "rules"
	| "card_search"
	| "card_text"
	| "card_render"
	| "card_design"
	| "general";
export type TaskStatus = "active" | "waiting" | "completed" | "failed" | "cancelled";

export interface RuntimeScope {
	readonly botId: string;
	readonly scopeKind: ScopeKind;
	readonly scopeId: string;
}

export interface ConversationEvent {
	readonly id: number;
	readonly botId: string;
	readonly scopeKind: ScopeKind;
	readonly scopeId: string;
	readonly taskId: string | null;
	readonly direction: "in" | "out";
	readonly senderId: string | null;
	readonly visibleText: string;
	readonly modelContent: string;
	readonly tokenCount: number;
	readonly compacted: boolean;
	readonly createdAt: number;
}

export interface AgentTask {
	readonly id: string;
	readonly botId: string;
	readonly scopeKind: ScopeKind;
	readonly scopeId: string;
	readonly scene: SceneId;
	readonly creatorId: string;
	readonly title: string;
	readonly status: TaskStatus;
	readonly state: Record<string, unknown>;
	readonly latestArtifactId: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface MemoryEntry {
	readonly id: number;
	readonly botId: string;
	readonly scopeKind: ScopeKind;
	readonly scopeId: string;
	readonly category: string;
	readonly content: string;
	readonly triggers: string[];
	readonly sourceEventId: number | null;
	readonly status: "active" | "archived";
	readonly useCount: number;
	readonly lastUsedAt: number | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface ConversationSegment {
	readonly id: number;
	readonly botId: string;
	readonly scopeKind: ScopeKind;
	readonly scopeId: string;
	readonly firstEventId: number;
	readonly lastEventId: number;
	readonly summary: string;
	readonly keywords: string[];
	readonly tokenCount: number;
	readonly createdAt: number;
}

export interface RuntimeScopeSummary extends RuntimeScope {
	readonly eventCount: number;
	readonly memoryCount: number;
	readonly activeTaskCount: number;
	readonly lastActivityAt: number;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
	try {
		const parsed = JSON.parse(String(value ?? "{}")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: {};
	} catch {
		return {};
	}
}

function parseJsonStrings(value: unknown): string[] {
	try {
		const parsed = JSON.parse(String(value ?? "[]")) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function eventFromRow(row: Record<string, unknown>): ConversationEvent {
	return {
		id: Number(row.id),
		botId: String(row.bot_id),
		scopeKind: row.scope_kind as ScopeKind,
		scopeId: String(row.scope_id),
		taskId: row.task_id == null ? null : String(row.task_id),
		direction: row.direction as "in" | "out",
		senderId: row.sender_id == null ? null : String(row.sender_id),
		visibleText: String(row.visible_text ?? ""),
		modelContent: String(row.model_content ?? ""),
		tokenCount: Number(row.token_count ?? 0),
		compacted: Number(row.compacted ?? 0) === 1,
		createdAt: Number(row.created_at),
	};
}

function taskFromRow(row: Record<string, unknown>): AgentTask {
	return {
		id: String(row.id),
		botId: String(row.bot_id),
		scopeKind: row.scope_kind as ScopeKind,
		scopeId: String(row.scope_id),
		scene: row.scene as SceneId,
		creatorId: String(row.creator_id),
		title: String(row.title),
		status: row.status as TaskStatus,
		state: parseJsonObject(row.state_json),
		latestArtifactId: row.latest_artifact_id == null ? null : String(row.latest_artifact_id),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

function memoryFromRow(row: Record<string, unknown>): MemoryEntry {
	return {
		id: Number(row.id),
		botId: String(row.bot_id),
		scopeKind: row.scope_kind as ScopeKind,
		scopeId: String(row.scope_id),
		category: String(row.category),
		content: String(row.content),
		triggers: parseJsonStrings(row.triggers_json),
		sourceEventId: row.source_event_id == null ? null : Number(row.source_event_id),
		status: row.status as "active" | "archived",
		useCount: Number(row.use_count ?? 0),
		lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

function segmentFromRow(row: Record<string, unknown>): ConversationSegment {
	return {
		id: Number(row.id),
		botId: String(row.bot_id),
		scopeKind: row.scope_kind as ScopeKind,
		scopeId: String(row.scope_id),
		firstEventId: Number(row.first_event_id),
		lastEventId: Number(row.last_event_id),
		summary: String(row.summary),
		keywords: parseJsonStrings(row.keywords_json),
		tokenCount: Number(row.token_count ?? 0),
		createdAt: Number(row.created_at),
	};
}

export class AgentRuntimeRepository {
	constructor(private readonly db: DatabaseSync) {}

	insertEvent(input: RuntimeScope & {
		taskId?: string | null;
		direction: "in" | "out";
		senderId?: string | null;
		visibleText: string;
		modelContent?: string;
		tokenCount: number;
		createdAt?: number;
	}): ConversationEvent {
		const createdAt = input.createdAt ?? Date.now();
		const info = this.db.prepare(
			"INSERT INTO conversation_events " +
			"(bot_id, scope_kind, scope_id, task_id, direction, sender_id, visible_text, model_content, token_count, compacted, created_at) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
		).run(
			input.botId,
			input.scopeKind,
			input.scopeId,
			input.taskId ?? null,
			input.direction,
			input.senderId ?? null,
			input.visibleText,
			input.modelContent ?? input.visibleText,
			Math.max(0, Math.trunc(input.tokenCount)),
			createdAt,
		);
		const row = this.db.prepare("SELECT * FROM conversation_events WHERE id = ?")
			.get(Number(info.lastInsertRowid)) as Record<string, unknown>;
		return eventFromRow(row);
	}

	listHot(scope: RuntimeScope, tokenLimit = 24_000): ConversationEvent[] {
		const rows = this.db.prepare(
			"SELECT * FROM conversation_events " +
			"WHERE bot_id = ? AND scope_kind = ? AND scope_id = ? AND compacted = 0 " +
			"ORDER BY id DESC LIMIT 1000",
		).all(scope.botId, scope.scopeKind, scope.scopeId) as Record<string, unknown>[];
		const selected: ConversationEvent[] = [];
		let tokens = 0;
		for (const row of rows) {
			const event = eventFromRow(row);
			if (selected.length > 0 && tokens + event.tokenCount > tokenLimit) break;
			selected.push(event);
			tokens += event.tokenCount;
		}
		return selected.reverse();
	}

	listUncompacted(scope: RuntimeScope, limit = 1_000): ConversationEvent[] {
		const rows = this.db.prepare(
			"SELECT * FROM conversation_events " +
			"WHERE bot_id = ? AND scope_kind = ? AND scope_id = ? AND compacted = 0 " +
			"ORDER BY id ASC LIMIT ?",
		).all(scope.botId, scope.scopeKind, scope.scopeId, limit) as Record<string, unknown>[];
		return rows.map(eventFromRow);
	}

	hotTokenCount(scope: RuntimeScope): number {
		const row = this.db.prepare(
			"SELECT COALESCE(SUM(token_count), 0) AS total FROM conversation_events " +
			"WHERE bot_id = ? AND scope_kind = ? AND scope_id = ? AND compacted = 0",
		).get(scope.botId, scope.scopeKind, scope.scopeId) as { total: number };
		return Number(row.total);
	}

	compactEvents(scope: RuntimeScope, events: readonly ConversationEvent[], summary: string, keywords: readonly string[]): ConversationSegment {
		if (events.length === 0) throw new Error("没有可沉淀的对话事件");
		const first = events[0];
		const last = events[events.length - 1];
		const tokenCount = events.reduce((sum, event) => sum + event.tokenCount, 0);
		this.db.exec("BEGIN");
		try {
			const info = this.db.prepare(
				"INSERT INTO conversation_segments " +
				"(bot_id, scope_kind, scope_id, first_event_id, last_event_id, summary, keywords_json, token_count, created_at) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				scope.botId,
				scope.scopeKind,
				scope.scopeId,
				first.id,
				last.id,
				summary,
				JSON.stringify(keywords),
				tokenCount,
				Date.now(),
			);
			this.db.prepare(
				"UPDATE conversation_events SET compacted = 1 " +
				"WHERE bot_id = ? AND scope_kind = ? AND scope_id = ? AND id BETWEEN ? AND ?",
			).run(scope.botId, scope.scopeKind, scope.scopeId, first.id, last.id);
			const row = this.db.prepare("SELECT * FROM conversation_segments WHERE id = ?")
				.get(Number(info.lastInsertRowid)) as Record<string, unknown>;
			this.db.exec("COMMIT");
			return segmentFromRow(row);
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	listRecentSegments(scope: RuntimeScope, limit = 20): ConversationSegment[] {
		const rows = this.db.prepare(
			"SELECT * FROM conversation_segments WHERE bot_id = ? AND scope_kind = ? AND scope_id = ? " +
			"ORDER BY id DESC LIMIT ?",
		).all(scope.botId, scope.scopeKind, scope.scopeId, limit) as Record<string, unknown>[];
		return rows.map(segmentFromRow);
	}

	listScopeSummaries(botId: string): RuntimeScopeSummary[] {
		const rows = this.db.prepare(
			"WITH scopes AS (" +
			" SELECT bot_id, scope_kind, scope_id FROM conversation_events WHERE bot_id = ?" +
			" UNION SELECT bot_id, scope_kind, scope_id FROM agent_tasks WHERE bot_id = ?" +
			" UNION SELECT bot_id, scope_kind, scope_id FROM memory_entries WHERE bot_id = ?" +
			") SELECT s.bot_id, s.scope_kind, s.scope_id," +
			" (SELECT COUNT(*) FROM conversation_events e WHERE e.bot_id = s.bot_id AND e.scope_kind = s.scope_kind AND e.scope_id = s.scope_id) AS event_count," +
			" (SELECT COUNT(*) FROM memory_entries m WHERE m.bot_id = s.bot_id AND m.scope_kind = s.scope_kind AND m.scope_id = s.scope_id AND m.status = 'active') AS memory_count," +
			" (SELECT COUNT(*) FROM agent_tasks t WHERE t.bot_id = s.bot_id AND t.scope_kind = s.scope_kind AND t.scope_id = s.scope_id AND t.status IN ('active','waiting')) AS active_task_count," +
			" MAX(" +
			" COALESCE((SELECT MAX(created_at) FROM conversation_events e WHERE e.bot_id = s.bot_id AND e.scope_kind = s.scope_kind AND e.scope_id = s.scope_id), 0)," +
			" COALESCE((SELECT MAX(updated_at) FROM agent_tasks t WHERE t.bot_id = s.bot_id AND t.scope_kind = s.scope_kind AND t.scope_id = s.scope_id), 0)," +
			" COALESCE((SELECT MAX(updated_at) FROM memory_entries m WHERE m.bot_id = s.bot_id AND m.scope_kind = s.scope_kind AND m.scope_id = s.scope_id), 0)" +
			" ) AS last_activity_at FROM scopes s ORDER BY last_activity_at DESC",
		).all(botId, botId, botId) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			botId: String(row.bot_id),
			scopeKind: row.scope_kind as ScopeKind,
			scopeId: String(row.scope_id),
			eventCount: Number(row.event_count ?? 0),
			memoryCount: Number(row.memory_count ?? 0),
			activeTaskCount: Number(row.active_task_count ?? 0),
			lastActivityAt: Number(row.last_activity_at ?? 0),
		}));
	}

	createTask(input: RuntimeScope & {
		id: string;
		scene: SceneId;
		creatorId: string;
		title: string;
		status?: TaskStatus;
		state?: Record<string, unknown>;
	}): AgentTask {
		const now = Date.now();
		this.db.prepare(
			"INSERT INTO agent_tasks " +
			"(id, bot_id, scope_kind, scope_id, scene, creator_id, title, status, state_json, created_at, updated_at) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			input.id,
			input.botId,
			input.scopeKind,
			input.scopeId,
			input.scene,
			input.creatorId,
			input.title,
			input.status ?? "active",
			JSON.stringify(input.state ?? {}),
			now,
			now,
		);
		return this.getTask(input.id)!;
	}

	getTask(id: string): AgentTask | undefined {
		const row = this.db.prepare("SELECT * FROM agent_tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
		return row ? taskFromRow(row) : undefined;
	}

	listTasks(scope: RuntimeScope, statuses: readonly TaskStatus[] = ["active", "waiting"], limit = 50): AgentTask[] {
		if (statuses.length === 0) return [];
		const placeholders = statuses.map(() => "?").join(",");
		const rows = this.db.prepare(
			"SELECT * FROM agent_tasks WHERE bot_id = ? AND scope_kind = ? AND scope_id = ? " +
			"AND status IN (" + placeholders + ") ORDER BY updated_at DESC LIMIT ?",
		).all(scope.botId, scope.scopeKind, scope.scopeId, ...statuses, limit) as Record<string, unknown>[];
		return rows.map(taskFromRow);
	}

	updateTask(id: string, patch: {
		title?: string;
		status?: TaskStatus;
		state?: Record<string, unknown>;
		latestArtifactId?: string | null;
	}): AgentTask | undefined {
		const current = this.getTask(id);
		if (!current) return undefined;
		this.db.prepare(
			"UPDATE agent_tasks SET title = ?, status = ?, state_json = ?, latest_artifact_id = ?, updated_at = ? WHERE id = ?",
		).run(
			patch.title ?? current.title,
			patch.status ?? current.status,
			JSON.stringify(patch.state ?? current.state),
			patch.latestArtifactId === undefined ? current.latestArtifactId : patch.latestArtifactId,
			Date.now(),
			id,
		);
		return this.getTask(id);
	}

	addArtifact(input: {
		id: string;
		taskId: string;
		kind: string;
		version: number;
		relativePath: string;
		metadata?: Record<string, unknown>;
	}): void {
		this.db.prepare(
			"INSERT INTO task_artifacts (id, task_id, kind, version, relative_path, metadata_json, created_at) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(
			input.id,
			input.taskId,
			input.kind,
			input.version,
			input.relativePath,
			JSON.stringify(input.metadata ?? {}),
			Date.now(),
		);
		this.updateTask(input.taskId, { latestArtifactId: input.id });
	}

	upsertMemory(input: RuntimeScope & {
		category: string;
		content: string;
		triggers: readonly string[];
		sourceEventId?: number | null;
	}): MemoryEntry {
		const normalizedTriggers = [...new Set(input.triggers.map((item) => item.trim()).filter(Boolean))];
		const existing = this.db.prepare(
			"SELECT * FROM memory_entries WHERE bot_id = ? AND scope_kind = ? AND scope_id = ? " +
			"AND category = ? AND content = ? AND status = 'active' LIMIT 1",
		).get(input.botId, input.scopeKind, input.scopeId, input.category, input.content) as Record<string, unknown> | undefined;
		const now = Date.now();
		if (existing) {
			this.db.prepare(
				"UPDATE memory_entries SET triggers_json = ?, source_event_id = COALESCE(?, source_event_id), updated_at = ? WHERE id = ?",
			).run(JSON.stringify(normalizedTriggers), input.sourceEventId ?? null, now, Number(existing.id));
			return memoryFromRow(this.db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(Number(existing.id)) as Record<string, unknown>);
		}
		const info = this.db.prepare(
			"INSERT INTO memory_entries " +
			"(bot_id, scope_kind, scope_id, category, content, triggers_json, source_event_id, status, created_at, updated_at) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
		).run(
			input.botId,
			input.scopeKind,
			input.scopeId,
			input.category,
			input.content,
			JSON.stringify(normalizedTriggers),
			input.sourceEventId ?? null,
			now,
			now,
		);
		return memoryFromRow(
			this.db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(Number(info.lastInsertRowid)) as Record<string, unknown>,
		);
	}

	listMemories(scope: RuntimeScope, status: "active" | "archived" = "active"): MemoryEntry[] {
		const rows = this.db.prepare(
			"SELECT * FROM memory_entries WHERE bot_id = ? AND scope_kind = ? AND scope_id = ? AND status = ? " +
			"ORDER BY updated_at DESC",
		).all(scope.botId, scope.scopeKind, scope.scopeId, status) as Record<string, unknown>[];
		return rows.map(memoryFromRow);
	}

	getMemory(id: number): MemoryEntry | undefined {
		const row = this.db.prepare("SELECT * FROM memory_entries WHERE id = ?")
			.get(id) as Record<string, unknown> | undefined;
		return row ? memoryFromRow(row) : undefined;
	}

	updateMemory(id: number, patch: {
		category?: string;
		content?: string;
		triggers?: readonly string[];
		status?: "active" | "archived";
	}): MemoryEntry | undefined {
		const current = this.getMemory(id);
		if (!current) return undefined;
		const triggers = patch.triggers
			? [...new Set(patch.triggers.map((item) => item.trim()).filter(Boolean))]
			: current.triggers;
		this.db.prepare(
			"UPDATE memory_entries SET category = ?, content = ?, triggers_json = ?, status = ?, updated_at = ? WHERE id = ?",
		).run(
			patch.category?.trim() || current.category,
			patch.content?.trim() || current.content,
			JSON.stringify(triggers),
			patch.status ?? current.status,
			Date.now(),
			id,
		);
		return this.getMemory(id);
	}

	findRelevantMemories(scope: RuntimeScope, query: string, limit = 5): MemoryEntry[] {
		const normalizedQuery = query.trim().toLowerCase();
		if (!normalizedQuery) return [];
		const candidates = this.listMemories(scope).slice(0, 200);
		const queryBigrams = bigrams(normalizedQuery);
		const scored = candidates.map((entry) => {
			let score = 0;
			for (const trigger of entry.triggers) {
				const normalized = trigger.toLowerCase();
				if (normalized && normalizedQuery.includes(normalized)) score += 100 + normalized.length;
			}
			const contentBigrams = bigrams(entry.content.toLowerCase());
			for (const gram of queryBigrams) if (contentBigrams.has(gram)) score += 1;
			return { entry, score };
		}).filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
			.slice(0, limit);
		const now = Date.now();
		const update = this.db.prepare(
			"UPDATE memory_entries SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
		);
		for (const item of scored) update.run(now, item.entry.id);
		return scored.map((item) => ({ ...item.entry, useCount: item.entry.useCount + 1, lastUsedAt: now }));
	}

	findRelevantSegments(scope: RuntimeScope, query: string, limit = 2): ConversationSegment[] {
		const grams = bigrams(query.toLowerCase());
		return this.listRecentSegments(scope, 100)
			.map((segment) => {
				const haystack = (segment.summary + " " + segment.keywords.join(" ")).toLowerCase();
				const segmentGrams = bigrams(haystack);
				let score = 0;
				for (const gram of grams) if (segmentGrams.has(gram)) score++;
				return { segment, score };
			})
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score || b.segment.id - a.segment.id)
			.slice(0, limit)
			.map((item) => item.segment);
	}
}

function bigrams(value: string): Set<string> {
	const clean = value.replace(/\s+/g, "");
	const result = new Set<string>();
	if (clean.length === 1) result.add(clean);
	for (let i = 0; i < clean.length - 1; i++) result.add(clean.slice(i, i + 2));
	return result;
}
