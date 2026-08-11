import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BotManagerLike } from "../contracts.ts";

interface SessionRoutesDeps {
	readonly botManager: BotManagerLike;
}

export function createSessionsRoutes(deps: SessionRoutesDeps): Hono {
	const app = new Hono();
	const { botManager } = deps;

	// 列出某机器人所有活跃会话。
	app.get("/:id/sessions", (c) => {
		const id = c.req.param("id");
		const inst = botManager.get(id);
		if (!inst) return c.json({ error: "机器人未加载或不存在" }, 404);
		return c.json({ items: inst.sessions.listActiveScopes() });
	});

	// 会话详情：systemPrompt + 工具 + 最近消息。
	app.get("/:id/sessions/:kind/:scopeId", (c) => {
		const id = c.req.param("id");
		const kind = c.req.param("kind");
		const scopeId = c.req.param("scopeId");
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const inst = botManager.get(id);
		if (!inst) return c.json({ error: "机器人未加载或不存在" }, 404);
		const detail = inst.sessions.getScopeDetail({ kind, id: scopeId });
		if (!detail) return c.json({ error: "会话不在活跃池中" }, 404);
		return c.json(detail);
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

/** 读取某 scope 的历史 session.jsonl（静态文件，路径由 server 提供辅助）。 */
export async function readScopeHistory(scopeDir: string): Promise<{ session: unknown[] }> {
	let session: unknown[] = [];
	try {
		const raw = await readFile(join(scopeDir, "session.jsonl"), "utf8");
		session = raw
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	} catch {
		/* 文件不存在 */
	}
	return { session };
}
