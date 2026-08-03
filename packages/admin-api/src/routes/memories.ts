import { Hono } from "hono";
import { readdir, readFile, unlink, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "@arkham/chatbot-store";
import { ScopeLabelRepository } from "@arkham/chatbot-store";
import type { BotManagerLike } from "../contracts.ts";

interface MemoryRoutesDeps {
	readonly db: DatabaseSync;
	readonly botManager: BotManagerLike;
}

/**
 * 会话管理 + 记忆审计路由。
 *
 * - 列出某 bot 所有 scope（磁盘扫描）+ 备注
 * - 设置/删除 scope 备注（32 位哈希起可读名）
 * - 查看/删除记忆文件
 * - 清除记忆目录 / 清除历史标记
 */
export function createMemoryRoutes(deps: MemoryRoutesDeps): Hono {
	const app = new Hono();
	const { db, botManager } = deps;
	const labels = new ScopeLabelRepository(db);

	// ---- 会话列表（磁盘扫描 + 备注 + 记忆文件数）----
	app.get("/:botId/scopes", async (c) => {
		const botId = c.req.param("botId");
		const scopes = await botManager.listScopes(botId);
		const labelMap = new Map(labels.list(botId).map((l) => [`${l.scopeKind}:${l.scopeId}`, l.label]));
		const items = await Promise.all(
			scopes.map(async (s) => {
				const scopeDir = botManager.getScopeDir(botId, s.kind, s.id);
				const memDir = scopeDir ? join(scopeDir, "workspace", "memories") : null;
				let memoryCount = 0;
				if (memDir) {
					try {
						const files = await readdir(memDir);
						memoryCount = files.filter((f) => f.endsWith(".md") && f !== "MEMORY.md").length;
					} catch {
						/* 无目录 */
					}
				}
				return {
					kind: s.kind,
					id: s.id,
					label: labelMap.get(`${s.kind}:${s.id}`) ?? null,
					memoryCount,
				};
			}),
		);
		return c.json({ items });
	});

	// ---- 设置/更新 scope 备注 ----
	app.put("/:botId/scopes/:kind/:scopeId/label", async (c) => {
		const { botId, kind, scopeId } = c.req.param();
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const body = (await c.req.json().catch(() => ({}))) as { label?: string };
		if (!body.label?.trim()) return c.json({ error: "label 不能为空" }, 400);
		labels.set(botId, kind as "group" | "user", scopeId, body.label.trim());
		return c.json({ ok: true });
	});

	// ---- 删除 scope 备注 ----
	app.delete("/:botId/scopes/:kind/:scopeId/label", (c) => {
		const { botId, kind, scopeId } = c.req.param();
		labels.delete(botId, kind, scopeId);
		return c.json({ ok: true });
	});

	// ---- 列出某 scope 的记忆文件 + 索引 ----
	app.get("/:botId/:kind/:scopeId", async (c) => {
		const { botId, kind, scopeId } = c.req.param();
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const scopeDir = botManager.getScopeDir(botId, kind as "group" | "user", scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		const memDir = join(scopeDir, "workspace", "memories");

		// 会话摘要（memory.md，回收时自动生成，在 scopeDir 下不在 memories/ 内）。
		let sessionSummary: string | null = null;
		try {
			sessionSummary = await readFile(join(scopeDir, "memory.md"), "utf8");
		} catch {
			/* 无摘要 */
		}

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
		return c.json({ sessionSummary, index, files });
	});

	// ---- 读取某条记忆文件全文 ----
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

	// ---- 编辑记忆文件（写全文）----
	app.put("/:botId/:kind/:scopeId/:name", async (c) => {
		const { botId, kind, scopeId } = c.req.param();
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const name = basename(c.req.param("name"));
		const scopeDir = botManager.getScopeDir(botId, kind as "group" | "user", scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		const body = await c.req.text();
		const { writeFile: wf, mkdir: mkd } = await import("node:fs/promises");
		try {
			await mkd(join(scopeDir, "workspace", "memories"), { recursive: true });
			await wf(join(scopeDir, "workspace", "memories", name), body, "utf8");
			return c.json({ ok: true });
		} catch (e) {
			return c.json({ error: (e as Error).message }, 500);
		}
	});

	// ---- 删除某条记忆文件 ----
	app.delete("/:botId/:kind/:scopeId/:name", async (c) => {
		const { botId, kind, scopeId } = c.req.param();
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const name = basename(c.req.param("name"));
		const scopeDir = botManager.getScopeDir(botId, kind as "group" | "user", scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		try {
			await unlink(join(scopeDir, "workspace", "memories", name));
			return c.json({ ok: true });
		} catch {
			return c.json({ error: "文件不存在" }, 404);
		}
	});

	// ---- 清除所有记忆文件（删 memories/ 目录内容，保留目录）----
	app.post("/:botId/:kind/:scopeId/clear-memories", async (c) => {
		const { botId, kind, scopeId } = c.req.param();
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const scopeDir = botManager.getScopeDir(botId, kind as "group" | "user", scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		const memDir = join(scopeDir, "workspace", "memories");
		try {
			await rm(memDir, { recursive: true, force: true });
			return c.json({ ok: true, note: "已清除所有记忆文件（memories/ 目录）" });
		} catch (e) {
			return c.json({ error: (e as Error).message }, 500);
		}
	});

	// ---- 清除历史（写标记，下次激活不注入 session.jsonl）----
	app.post("/:botId/:kind/:scopeId/clear-history", async (c) => {
		const { botId, kind, scopeId } = c.req.param();
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const scopeDir = botManager.getScopeDir(botId, kind as "group" | "user", scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		const { writeFile: wf } = await import("node:fs/promises");
		try {
			await wf(join(scopeDir, ".history_cleared"), String(Date.now()), "utf8");
			return c.json({ ok: true, note: "已标记清除历史。下次会话激活时不注入 session.jsonl 历史记录（文件保留不删）。" });
		} catch (e) {
			return c.json({ error: (e as Error).message }, 500);
		}
	});

	// ---- 编辑会话摘要（memory.md）----
	app.put("/:botId/:kind/:scopeId/summary", async (c) => {
		const { botId, kind, scopeId } = c.req.param();
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const scopeDir = botManager.getScopeDir(botId, kind as "group" | "user", scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		const body = await c.req.text();
		const { writeFile: wf } = await import("node:fs/promises");
		try {
			await wf(join(scopeDir, "memory.md"), body, "utf8");
			return c.json({ ok: true });
		} catch (e) {
			return c.json({ error: (e as Error).message }, 500);
		}
	});

	// ---- 清除会话摘要（删 memory.md）----
	app.post("/:botId/:kind/:scopeId/clear-summary", async (c) => {
		const { botId, kind, scopeId } = c.req.param();
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const scopeDir = botManager.getScopeDir(botId, kind as "group" | "user", scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		try {
			await unlink(join(scopeDir, "memory.md")).catch(() => {});
			return c.json({ ok: true, note: "已删除会话摘要（memory.md）。下次激活不再加载上次会话摘要。" });
		} catch (e) {
			return c.json({ error: (e as Error).message }, 500);
		}
	});

	return app;
}

function basename(name: string): string {
	const base = name.split("/").pop() ?? name;
	return base.endsWith(".md") ? base : `${base}.md`;
}
