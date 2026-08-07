import { Hono } from "hono";
import type { DatabaseSync } from "@arkham/chatbot-store";
import { AgentRuntimeRepository } from "@arkham/chatbot-store";
import type { BotManagerLike } from "../contracts.ts";

interface SessionRoutesDeps {
	readonly db: DatabaseSync;
	readonly botManager: BotManagerLike;
}

export function createSessionsRoutes(deps: SessionRoutesDeps): Hono {
	const app = new Hono();
	const { botManager } = deps;
	const runtime = new AgentRuntimeRepository(deps.db);

	// 列出某机器人所有持久会话，并标记当前进程中近期活跃的 scope。
	app.get("/:id/sessions", (c) => {
		const id = c.req.param("id");
		const activeKeys = new Set(botManager.get(id)?.sessions.listActiveScopes().map((item) => item.key) ?? []);
		const items = runtime.listScopeSummaries(id).map((scope) => ({
			key: scope.scopeKind + ":" + scope.scopeId,
			scope: { kind: scope.scopeKind, id: scope.scopeId },
			lastActivityAt: scope.lastActivityAt,
			ttlRemainingMs: 0,
			messageCount: scope.eventCount,
			memoryCount: scope.memoryCount,
			activeTaskCount: scope.activeTaskCount,
			active: activeKeys.has(scope.scopeKind + ":" + scope.scopeId),
		}));
		return c.json({ items });
	});

	// 会话详情：systemPrompt + 工具 + 最近消息。
	app.get("/:id/sessions/:kind/:scopeId", (c) => {
		const id = c.req.param("id");
		const kind = c.req.param("kind");
		const scopeId = c.req.param("scopeId");
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const scope = { botId: id, scopeKind: kind as "group" | "user", scopeId };
		const live = botManager.get(id)?.sessions.getScopeDetail({ kind, id: scopeId });
		const summary = runtime.listScopeSummaries(id)
			.find((item) => item.scopeKind === kind && item.scopeId === scopeId);
		return c.json({
			scope: { kind, id: scopeId },
			systemPrompt: live?.systemPrompt ?? "",
			tools: [],
			messages: runtime.listHot(scope),
			messageCount: summary?.eventCount ?? 0,
			lastActivityAt: summary?.lastActivityAt ?? 0,
			tasks: runtime.listTasks(scope, ["active", "waiting", "completed", "failed", "cancelled"], 50),
			memories: runtime.listMemories(scope),
			segments: runtime.listRecentSegments(scope),
		});
	});

	// 强制回收一个会话。
	app.delete("/:id/sessions/:kind/:scopeId", async (c) => {
		const id = c.req.param("id");
		const kind = c.req.param("kind");
		const scopeId = c.req.param("scopeId");
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const inst = botManager.get(id);
		if (!inst) return c.json({ error: "机器人未加载或不存在" }, 404);
		const ok = await inst.sessions.forceReap({ kind, id: scopeId });
		return c.json({ ok });
	});

	return app;
}
