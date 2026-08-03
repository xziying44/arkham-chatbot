import { Hono } from "hono";
import { readdir, readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BotManagerLike } from "../contracts.ts";

interface MemoryRoutesDeps {
	readonly botManager: BotManagerLike;
}

/**
 * 记忆审计路由。
 *
 * 路径布局: <scopeDir>/workspace/memories/<文件>.md + MEMORY.md 索引。
 * 只读 + 删除（不提供新建/编辑——记忆是 agent 自管理的，管理端只做审计/清理）。
 *
 * 安全: 路径解析只取 basename，禁止目录穿越。
 */
export function createMemoryRoutes(deps: MemoryRoutesDeps): Hono {
	const app = new Hono();
	const { botManager } = deps;

	/** 列出某 scope 的所有记忆文件 + 索引内容。 */
	app.get("/:botId/:kind/:scopeId", async (c) => {
		const { botId, kind, scopeId } = c.req.param();
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const scopeDir = botManager.getScopeDir(botId, kind as "group" | "user", scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		const memDir = join(scopeDir, "workspace", "memories");

		let index: string | null = null;
		try {
			index = await readFile(join(memDir, "MEMORY.md"), "utf8");
		} catch {
			/* 无索引 */
		}

		let files: { name: string; size: number }[] = [];
		try {
			const entries = await readdir(memDir);
			for (const e of entries) {
				if (!e.endsWith(".md")) continue;
				const s = await stat(join(memDir, e)).catch(() => null);
				files.push({ name: e, size: s?.size ?? 0 });
			}
		} catch {
			/* 目录不存在 */
		}
		return c.json({ index, files });
	});

	/** 读取某条记忆文件全文。 */
	app.get("/:botId/:kind/:scopeId/:name", async (c) => {
		const { botId, kind, scopeId } = c.req.param();
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const name = basename(c.req.param("name"));
		const scopeDir = botManager.getScopeDir(botId, kind as "group" | "user", scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		try {
			const content = await readFile(join(scopeDir, "workspace", "memories", name), "utf8");
			return c.text(content);
		} catch {
			return c.json({ error: "记忆文件不存在" }, 404);
		}
	});

	/** 删除某条记忆文件。 */
	app.delete("/:botId/:kind/:scopeId/:name", async (c) => {
		const { botId, kind, scopeId } = c.req.param();
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const name = basename(c.req.param("name"));
		const scopeDir = botManager.getScopeDir(botId, kind as "group" | "user", scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		try {
			await unlink(join(scopeDir, "workspace", "memories", name));
			return c.json({ ok: true, note: "已删除文件。注意：MEMORY.md 索引里的对应行需要 agent 下次激活时自行清理，或手动编辑。" });
		} catch {
			return c.json({ error: "文件不存在或无法删除" }, 404);
		}
	});

	return app;
}

/** 只取 basename，防目录穿越。 */
function basename(name: string): string {
	const base = name.split("/").pop() ?? name;
	return base.endsWith(".md") ? base : `${base}.md`;
}
