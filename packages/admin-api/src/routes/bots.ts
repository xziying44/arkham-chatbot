import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "@arkham/chatbot-store";
import { BotRepository } from "@arkham/chatbot-store";
import type { BotManagerLike, BotConfigInput } from "../contracts.ts";

interface BotRoutesDeps {
	readonly db: DatabaseSync;
	readonly botManager: BotManagerLike;
}

/** 把请求体里的 appSecret 处理成「空串=不改」的语义。 */
function resolveSecret(body: { appSecret?: string }, current: string): string {
	if (body.appSecret === undefined || body.appSecret === "") return current;
	return body.appSecret;
}

export function createBotsRoutes(deps: BotRoutesDeps): Hono {
	const app = new Hono();
	const bots = new BotRepository(deps.db);
	const { botManager } = deps;

	// 列表（含运行时信息）。
	app.get("/", (c) => {
		const records = bots.list();
		const runtime = new Map(botManager.list().map((b) => [b.id, b]));
		const merged = records.map((r) => {
			const rt = runtime.get(r.id);
			return {
				...r,
				loaded: rt?.loaded ?? false,
				connectionState: rt?.connectionState ?? "disconnected",
				connected: rt?.connected ?? false,
				activeScopeCount: rt?.activeScopeCount ?? 0,
			};
		});
		return c.json({ items: merged });
	});

	// 详情。
	app.get("/:id", (c) => {
		const rec = bots.get(c.req.param("id"));
		if (!rec) return c.json({ error: "机器人不存在" }, 404);
		const rt = botManager.list().find((b) => b.id === rec.id);
		return c.json({ ...rec, loaded: rt?.loaded ?? false, connectionState: rt?.connectionState ?? "disconnected", connected: rt?.connected ?? false, activeScopeCount: rt?.activeScopeCount ?? 0 });
	});

	// 新建。
	app.post("/", async (c) => {
		const body = await c.req.json().catch(() => null) as {
			appId?: string;
			appSecret?: string;
			name?: string;
			apiBase?: string;
			persona?: string | null;
			enabled?: boolean;
		} | null;
		if (!body?.appId || !body.appSecret || !body.name) {
			return c.json({ error: "缺少必填字段: appId, appSecret, name" }, 400);
		}
		const id = randomUUID();
		const apiBase = body.apiBase ?? "https://api.sgroup.qq.com";
		const persona = body.persona ?? null;
		const enabled = body.enabled !== false;
		bots.insert({ id, appId: body.appId, appSecret: body.appSecret, name: body.name, apiBase, persona, enabled });
		if (enabled) {
			const config: BotConfigInput = { id, appId: body.appId, appSecret: body.appSecret, name: body.name, apiBase, persona, enabled };
			try {
				await botManager.addBot(config);
			} catch (e) {
				return c.json({ error: `已入库但启动失败: ${(e as Error).message}` }, 201);
			}
		}
		return c.json(bots.get(id), 201);
	});

	// 更新。
	app.patch("/:id", async (c) => {
		const id = c.req.param("id");
		const rec = bots.get(id);
		if (!rec) return c.json({ error: "机器人不存在" }, 404);
		const body = await c.req.json().catch(() => ({})) as {
			appId?: string;
			appSecret?: string;
			name?: string;
			apiBase?: string;
			persona?: string | null;
			enabled?: boolean;
		};
		const updated = bots.update(id, {
			appId: body.appId,
			appSecret: body.appSecret ? resolveSecret(body, rec.appSecret) : undefined,
			name: body.name,
			apiBase: body.apiBase,
			persona: body.persona,
			enabled: body.enabled,
		})!;
		// 应用到运行时：重建实例。
		const config: BotConfigInput = {
			id: updated.id,
			appId: updated.appId,
			appSecret: updated.appSecret,
			name: updated.name,
			apiBase: updated.apiBase,
			persona: updated.persona,
			enabled: updated.enabled,
		};
		try {
			await botManager.reconfigureBot(id, config);
		} catch (e) {
			return c.json({ error: `已更新但重配置失败: ${(e as Error).message}` }, 200);
		}
		return c.json(updated);
	});

	// 启用。
	app.post("/:id/start", async (c) => {
		const id = c.req.param("id");
		const rec = bots.get(id);
		if (!rec) return c.json({ error: "机器人不存在" }, 404);
		bots.update(id, { enabled: true });
		const config: BotConfigInput = { id: rec.id, appId: rec.appId, appSecret: rec.appSecret, name: rec.name, apiBase: rec.apiBase, persona: rec.persona, enabled: true };
		try {
			await botManager.enable(id, config);
		} catch (e) {
			return c.json({ error: (e as Error).message }, 500);
		}
		return c.json({ ok: true });
	});

	// 禁用（断开连接，保留磁盘数据）。
	app.post("/:id/stop", async (c) => {
		const id = c.req.param("id");
		const rec = bots.get(id);
		if (!rec) return c.json({ error: "机器人不存在" }, 404);
		bots.update(id, { enabled: false });
		await botManager.disable(id);
		return c.json({ ok: true });
	});

	// 删除（默认保留磁盘数据；?deleteData=true 清理）。
	app.delete("/:id", async (c) => {
		const id = c.req.param("id");
		const rec = bots.get(id);
		if (!rec) return c.json({ error: "机器人不存在" }, 404);
		const deleteData = c.req.query("deleteData") === "true";
		await botManager.removeBot(id, deleteData);
		bots.delete(id);
		return c.json({ ok: true });
	});

	return app;
}
