import { Hono } from "hono";
import type { DatabaseSync } from "@arkham/chatbot-store";
import {
	SettingsRepository,
	SettingsKeys,
} from "@arkham/chatbot-store";
import type { BotManagerLike, PromptRegistryLike } from "../contracts.ts";

interface SettingsRoutesDeps {
	readonly db: DatabaseSync;
	readonly botManager: BotManagerLike;
	readonly prompts: PromptRegistryLike;
}

/** 可在管理端改的设置 key 白名单。 */
const EDITABLE = [
	SettingsKeys.llmModel,
	SettingsKeys.llmAnthropicBaseUrl,
	SettingsKeys.llmOpenaiBaseUrl,
	SettingsKeys.sandboxEnabled,
	SettingsKeys.sandboxNetworkDisabled,
	SettingsKeys.sandboxTimeoutSeconds,
] as const;

export function createSettingsRoutes(deps: SettingsRoutesDeps): Hono {
	const app = new Hono();
	const settings = new SettingsRepository(deps.db);
	const { botManager } = deps;

	// 读全部设置（脱敏：不返回 password hash/salt）。
	app.get("/", (c) => {
		const all = settings.all();
		const safe: Record<string, string> = {};
		for (const [k, v] of Object.entries(all)) {
			if (k === SettingsKeys.adminPasswordHash || k === SettingsKeys.adminPasswordSalt) continue;
			safe[k] = v;
		}
		return c.json(safe);
	});

	// 批量更新设置（只接受白名单 key）。
	app.patch("/", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, string>;
		const updates: Record<string, string> = {};
		for (const k of EDITABLE) {
			if (body[k] !== undefined) updates[k] = String(body[k]);
		}
		// 改管理员密码（可选）。
		if (body.admin_password !== undefined && body.admin_password !== "") {
			const { hashPassword } = await import("../auth.ts");
			const { hash, salt } = hashPassword(String(body.admin_password));
			updates[SettingsKeys.adminPasswordHash] = hash;
			updates[SettingsKeys.adminPasswordSalt] = salt;
		}
		if (Object.keys(updates).length === 0) return c.json({ ok: true, changed: 0 });
		settings.setMany(updates);
		return c.json({
			ok: true,
			changed: Object.keys(updates).length,
			note: "模型端点和沙箱参数会在服务重启后生效。",
		});
	});

	// 兼容旧管理客户端：只清空当前进程的活跃 scope 视图，不删除持久数据。
	app.post("/reap-all", async (c) => {
		const count = await botManager.reapAllSessions();
		return c.json({ ok: true, reaped: count });
	});

	// v2 提示词注册表：返回 Git 跟踪的实际 Markdown 内容与缓存统计。
	app.get("/prompts", (c) => {
		return c.json({
			...deps.prompts.snapshot(),
			items: deps.prompts.list(),
		});
	});

	// 原子热重载。正在执行的回合继续使用其启动时快照。
	app.post("/prompts/reload", async (c) => {
		await deps.prompts.reload();
		return c.json({ ok: true, ...deps.prompts.snapshot() });
	});

	return app;
}
