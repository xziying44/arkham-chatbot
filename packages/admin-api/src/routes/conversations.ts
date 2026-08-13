import { Hono } from "hono";
import type { DatabaseSync } from "@arkham/chatbot-store";
import { ConversationRepository, ScopeSummaryRepository } from "@arkham/chatbot-store";

interface ConversationRoutesDeps {
	readonly db: DatabaseSync;
}

/**
 * 会话完整归档路由：后台查阅完整对话（含工具调用/结果）、关键词搜索、训练数据导出。
 *
 * 路由：
 * - GET /conversations          分页查询消息（支持 scope/时间/关键词筛选）
 * - GET /conversations/scopes   按 scope 聚合的会话列表（页面导航用）
 * - GET /conversations/export   导出为 jsonl（训练用）
 */
export function createConversationsRoutes(deps: ConversationRoutesDeps): Hono {
	const app = new Hono();
	const conversations = new ConversationRepository(deps.db);
	const scopeSummaries = new ScopeSummaryRepository(deps.db);

	/** 通用鉴权中间件：所有归档接口都要登录（含完整对话 + 工具结果，敏感）。 */
	// 分页查询完整消息
	app.get("/", (c) => {
		const result = conversations.list({
			botId: c.req.query("botId") || undefined,
			scopeKind: c.req.query("scopeKind") || undefined,
			scopeId: c.req.query("scopeId") || undefined,
			fromTs: c.req.query("fromTs") ? Number(c.req.query("fromTs")) : undefined,
			toTs: c.req.query("toTs") ? Number(c.req.query("toTs")) : undefined,
			search: c.req.query("search") || undefined,
			page: c.req.query("page") ? Number(c.req.query("page")) : 1,
			size: c.req.query("size") ? Number(c.req.query("size")) : 100,
		});
		return c.json(result);
	});

	// 按 scope 聚合的会话列表：优先返回 scope_summaries（带 dispose 时 LLM 生成的摘要），
	// 再用 conversations 表聚合补全那些还没 dispose 过（无摘要）的 scope。
	app.get("/scopes", (c) => {
		const botId = c.req.query("botId");
		if (!botId) return c.json({ error: "botId 必填" }, 400);
		const summaries = scopeSummaries.list(botId);
		const aggregated = conversations.listScopes(botId);
		// 合并：summaries 为主（有摘要），aggregated 补无摘要的 scope。
		const seen = new Set(summaries.map((s) => `${s.scopeKind}:${s.scopeId}:${s.memberId ?? ""}`));
		const extra = aggregated.filter((a) => !seen.has(`${a.scopeKind}:${a.scopeId}:${a.memberId ?? ""}`));
		return c.json([
			...summaries.map((s) => ({
				scopeKind: s.scopeKind,
				scopeId: s.scopeId,
				memberId: s.memberId,
				summary: s.summary,
				messageCount: s.messageCount,
				firstTs: s.firstTs,
				lastTs: s.lastTs,
				updatedAt: s.updatedAt,
				hasSummary: true,
			})),
			...extra.map((a) => ({
				scopeKind: a.scopeKind,
				scopeId: a.scopeId,
				memberId: a.memberId,
				summary: null,
				messageCount: a.messageCount,
				firstTs: a.firstTs,
				lastTs: a.lastTs,
				updatedAt: a.lastTs,
				hasSummary: false,
			})),
		]);
	});

	// 导出为 jsonl（训练用）。每行一条消息 JSON。
	app.get("/export", (c) => {
		const result = conversations.list({
			botId: c.req.query("botId") || undefined,
			scopeKind: c.req.query("scopeKind") || undefined,
			scopeId: c.req.query("scopeId") || undefined,
			fromTs: c.req.query("fromTs") ? Number(c.req.query("fromTs")) : undefined,
			toTs: c.req.query("toTs") ? Number(c.req.query("toTs")) : undefined,
			search: c.req.query("search") || undefined,
			page: 1,
			// 导出上限放大（单次最多 5000 条；更大用 fromTs/toTs 分批）
			size: 5000,
		});
		const jsonl = result.items
			.map((r) => JSON.stringify({
				id: r.id,
				botId: r.botId,
				scopeKind: r.scopeKind,
				scopeId: r.scopeId,
				memberId: r.memberId,
				runId: r.runId,
				ts: r.ts,
				role: r.role,
				content: JSON.parse(r.contentJson),
				stopReason: r.stopReason,
				model: r.model,
			}))
			.join("\n");
		const scopeTag = c.req.query("scopeId") ?? "all";
		c.header("Content-Type", "application/x-ndjson; charset=utf-8");
		c.header("Content-Disposition", `attachment; filename="conversations-${scopeTag}-${Date.now()}.jsonl"`);
		return c.body(jsonl);
	});

	return app;
}
