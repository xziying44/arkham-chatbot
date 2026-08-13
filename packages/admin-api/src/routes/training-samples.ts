import { Hono } from "hono";
import type { DatabaseSync } from "@arkham/chatbot-store";
import { TrainingSampleRepository } from "@arkham/chatbot-store";

interface TrainingSampleRoutesDeps {
	readonly db: DatabaseSync;
}

/**
 * 训练样本路由：每次 agent run 的完整自包含快照（systemPrompt + 完整消息序列
 * 含工具调用/结果/reasoning + 模型元信息）。
 *
 * 路由：
 * - GET /training-samples          分页列表（不含 sample_json，轻量）
 * - GET /training-samples/:id      单个样本完整 JSON（详情/导出用）
 * - GET /training-samples/export   批量导出 jsonl（每行一个样本）
 */
export function createTrainingSamplesRoutes(deps: TrainingSampleRoutesDeps): Hono {
	const app = new Hono();
	const repo = new TrainingSampleRepository(deps.db);

	// 分页列表（不含 sample_json）
	app.get("/", (c) => {
		const result = repo.list({
			botId: c.req.query("botId") || undefined,
			scopeKind: c.req.query("scopeKind") || undefined,
			scopeId: c.req.query("scopeId") || undefined,
			fromTs: c.req.query("fromTs") ? Number(c.req.query("fromTs")) : undefined,
			toTs: c.req.query("toTs") ? Number(c.req.query("toTs")) : undefined,
			page: c.req.query("page") ? Number(c.req.query("page")) : 1,
			size: c.req.query("size") ? Number(c.req.query("size")) : 50,
		});
		return c.json(result);
	});

	// 单个样本完整 JSON
	app.get("/:id", (c) => {
		const sample = repo.get(c.req.param("id"));
		if (!sample) return c.json({ error: "样本不存在" }, 404);
		return c.json(sample);
	});

	// 批量导出 jsonl（每行一个完整样本）
	app.get("/export/all", (c) => {
		const result = repo.list({
			botId: c.req.query("botId") || undefined,
			scopeKind: c.req.query("scopeKind") || undefined,
			scopeId: c.req.query("scopeId") || undefined,
			fromTs: c.req.query("fromTs") ? Number(c.req.query("fromTs")) : undefined,
			toTs: c.req.query("toTs") ? Number(c.req.query("toTs")) : undefined,
			page: 1,
			size: 5000,
		});
		// 逐个取完整 sample_json 拼成 jsonl
		const lines: string[] = [];
		for (const item of result.items) {
			const full = repo.get(item.id);
			if (full) lines.push(full.sampleJson);
		}
		const jsonl = lines.join("\n");
		c.header("Content-Type", "application/x-ndjson; charset=utf-8");
		c.header("Content-Disposition", `attachment; filename="training-samples-${Date.now()}.jsonl"`);
		return c.body(jsonl);
	});

	return app;
}
