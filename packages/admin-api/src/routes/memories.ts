import { Hono } from "hono";
import { readdir, readFile, unlink, stat, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "@arkham/chatbot-store";
import { ScopeLabelRepository } from "@arkham/chatbot-store";
import type { BotManagerLike } from "../contracts.ts";

interface MemoryRoutesDeps {
	readonly db: DatabaseSync;
	readonly botManager: BotManagerLike;
}

type ScopeKind = "group" | "user";

/**
 * 会话管理 + 记忆审计路由。
 *
 * - 列出某 bot 所有 scope（磁盘扫描）+ 备注
 * - 设置/删除 scope 备注（32 位哈希起可读名）
 * - 查看/删除记忆文件
 * - 清除记忆目录 / 清除历史标记
 *
 * 路径注意（每成员智能体改造后）：
 * - 群聊记忆在群级共享目录 `<groupDir>/memories`（非 workspace 下）。
 * - 私聊记忆仍在 `<userDir>/workspace/memories`。
 * - 群聊 session.jsonl 是每成员的（`<groupDir>/members/<memberId>/`），「清除历史」
 *   对群聊会遍历所有成员目录写标记。
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
				const memDir = scopeDir ? memDirFor(scopeDir, s.kind) : null;
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
		labels.set(botId, kind as ScopeKind, scopeId, body.label.trim());
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
		const scopeDir = botManager.getScopeDir(botId, kind as ScopeKind, scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		const memDir = memDirFor(scopeDir, kind as ScopeKind);

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

	// ---- 读取某条记忆文件全文 ----
	app.get("/:botId/:kind/:scopeId/:name", async (c) => {
		const { botId, kind, scopeId } = c.req.param();
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const name = basename(c.req.param("name"));
		const scopeDir = botManager.getScopeDir(botId, kind as ScopeKind, scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		try {
			const content = await readFile(join(memDirFor(scopeDir, kind as ScopeKind), name), "utf8");
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
		const scopeDir = botManager.getScopeDir(botId, kind as ScopeKind, scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		const memDir = memDirFor(scopeDir, kind as ScopeKind);
		const body = await c.req.text();
		try {
			await mkdir(memDir, { recursive: true });
			await writeFile(join(memDir, name), body, "utf8");
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
		const scopeDir = botManager.getScopeDir(botId, kind as ScopeKind, scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		try {
			await unlink(join(memDirFor(scopeDir, kind as ScopeKind), name));
			return c.json({ ok: true });
		} catch {
			return c.json({ error: "文件不存在" }, 404);
		}
	});

	// ---- 清除所有记忆文件（删 memories/ 目录内容，保留目录）----
	app.post("/:botId/:kind/:scopeId/clear-memories", async (c) => {
		const { botId, kind, scopeId } = c.req.param();
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const scopeDir = botManager.getScopeDir(botId, kind as ScopeKind, scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		const memDir = memDirFor(scopeDir, kind as ScopeKind);
		try {
			await rm(memDir, { recursive: true, force: true });
			return c.json({ ok: true, note: "已清除所有记忆文件（memories/ 目录）" });
		} catch (e) {
			return c.json({ error: (e as Error).message }, 500);
		}
	});

	// ---- 清除历史（写标记，下次激活不注入 session.jsonl）----
	// 群聊：session.jsonl 是每成员的，遍历 <groupDir>/members/* 写标记，清除所有成员历史。
	// 私聊：写 <userDir>/.history_cleared。
	app.post("/:botId/:kind/:scopeId/clear-history", async (c) => {
		const { botId, kind, scopeId } = c.req.param();
		if (kind !== "group" && kind !== "user") return c.json({ error: "kind 必须是 group 或 user" }, 400);
		const scopeDir = botManager.getScopeDir(botId, kind as ScopeKind, scopeId);
		if (!scopeDir) return c.json({ error: "无法定位会话目录" }, 404);
		try {
			const targets = await historyClearedTargets(scopeDir, kind as ScopeKind);
			await Promise.all(targets.map((t) => writeFile(t, String(Date.now()), "utf8").catch(() => {})));
			return c.json({
				ok: true,
				note: kind === "group"
					? `已标记清除历史（${targets.length} 个成员会话）。下次激活时不注入 session.jsonl 历史记录。`
					: "已标记清除历史。下次会话激活时不注入 session.jsonl 历史记录（文件保留不删）。",
			});
		} catch (e) {
			return c.json({ error: (e as Error).message }, 500);
		}
	});

	return app;
}

/**
 * 记忆目录的宿主路径：
 * - 群聊：群级共享 `<scopeDir>/memories`（每成员智能体改造后，全群共享一份）。
 * - 私聊：`<scopeDir>/workspace/memories`（在用户自己的 workspace 下）。
 */
function memDirFor(scopeDir: string, kind: ScopeKind): string {
	return kind === "group" ? join(scopeDir, "memories") : join(scopeDir, "workspace", "memories");
}

/**
 * 「清除历史」标记要写的目标路径列表。
 * - 群聊：每个成员会话一个 `<groupDir>/members/<memberId>/.history_cleared`。无成员目录则返回空。
 * - 私聊：`<userDir>/.history_cleared`。
 */
async function historyClearedTargets(scopeDir: string, kind: ScopeKind): Promise<string[]> {
	if (kind === "user") return [join(scopeDir, ".history_cleared")];
	try {
		const membersDir = join(scopeDir, "members");
		const memberIds = await readdir(membersDir, { withFileTypes: true });
		return memberIds.filter((e) => e.isDirectory()).map((e) => join(membersDir, e.name, ".history_cleared"));
	} catch {
		return [];
	}
}

function basename(name: string): string {
	const base = name.split("/").pop() ?? name;
	return base.endsWith(".md") ? base : `${base}.md`;
}
