import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { DatabaseSync } from "@arkham/chatbot-store";
import {
	AdminSessionRepository,
	SettingsRepository,
	SettingsKeys,
} from "@arkham/chatbot-store";
import {
	type BotManagerLike,
	type LogBusLike,
} from "./contracts.ts";
import { verifyPassword, generateSessionToken, SESSION_COOKIE, SESSION_TTL_MS } from "./auth.ts";
import { createBotsRoutes } from "./routes/bots.ts";
import { createSessionsRoutes } from "./routes/sessions.ts";
import { createMessagesRoutes } from "./routes/messages.ts";
import { createLogsRoutes } from "./routes/logs.ts";
import { createSettingsRoutes } from "./routes/settings.ts";

export interface AdminServerOptions {
	readonly db: DatabaseSync;
	readonly botManager: BotManagerLike;
	readonly logBus: LogBusLike;
	readonly host: string;
	readonly port: number;
	/** admin-web 构建产物目录（可选；未提供时只服务 API）。 */
	readonly webDistDir?: string;
}

export interface AdminServer {
	readonly port: number;
	readonly host: string;
	close(): Promise<void>;
}

/**
 * 启动管理端 HTTP 服务（Hono on @hono/node-server）。
 *
 * 路由结构：
 *   /api/auth/*    鉴权
 *   /api/bots*     机器人 CRUD + 启停
 *   /api/bots/:id/sessions*  会话查看/回收
 *   /api/messages* 消息流水
 *   /api/logs*     日志（含 SSE 实时流）
 *   /api/settings* 全局设置 + 提示词预览
 *   /*             admin-web 静态产物（SPA fallback）
 *
 * 鉴权：除 /api/auth/login 外，所有 /api/* 需有效会话 cookie。
 */
export async function startAdminServer(opts: AdminServerOptions): Promise<AdminServer> {
	const { db, botManager, logBus, host, port, webDistDir } = opts;
	const app = new Hono();
	const adminSessions = new AdminSessionRepository(db);
	const settings = new SettingsRepository(db);

	// ---- 鉴权中间件：所有 /api/*（除 login）要求有效会话 ----
	app.use("/api/*", async (c, next) => {
		const path = new URL(c.req.url).pathname;
		if (path === "/api/auth/login") return next();
		const token = getCookie(c, SESSION_COOKIE);
		if (!token || !adminSessions.get(token)) {
			return c.json({ error: "未登录" }, 401);
		}
		await next();
	});

	// ---- auth ----
	app.post("/api/auth/login", async (c) => {
		const body = await c.req.json().catch(() => null) as { username?: string; password?: string } | null;
		if (!body?.username || !body?.password) {
			return c.json({ error: "缺少用户名或密码" }, 400);
		}
		const expectedUser = settings.getOr(SettingsKeys.adminUsername, "admin");
		const storedHash = settings.get(SettingsKeys.adminPasswordHash);
		const storedSalt = settings.get(SettingsKeys.adminPasswordSalt);
		if (body.username !== expectedUser || !storedHash || !storedSalt) {
			return c.json({ error: "用户名或密码错误" }, 401);
		}
		if (!verifyPassword(body.password, storedHash, storedSalt)) {
			return c.json({ error: "用户名或密码错误" }, 401);
		}
		const token = generateSessionToken();
		adminSessions.insert(token, SESSION_TTL_MS);
		setCookie(c, SESSION_COOKIE, token, {
			httpOnly: true,
			sameSite: "Lax",
			path: "/",
			maxAge: Math.floor(SESSION_TTL_MS / 1000),
		});
		return c.json({ ok: true, username: expectedUser });
	});

	app.post("/api/auth/logout", (c) => {
		const token = getCookie(c, SESSION_COOKIE);
		if (token) adminSessions.delete(token);
		deleteCookie(c, SESSION_COOKIE, { path: "/" });
		return c.json({ ok: true });
	});

	app.get("/api/auth/me", (c) => {
		return c.json({ username: settings.getOr(SettingsKeys.adminUsername, "admin") });
	});

	// ---- 业务路由 ----
	app.route("/api/bots", createBotsRoutes({ db, botManager }));
	app.route("/api/bots", createSessionsRoutes({ botManager }));
	app.route("/api/messages", createMessagesRoutes({ db }));
	app.route("/api/logs", createLogsRoutes({ db, logBus }));
	app.route("/api/settings", createSettingsRoutes({ db, botManager }));

	// ---- 静态文件（admin-web SPA）----
	if (webDistDir) {
		const { createStaticHandler } = await import("./static.ts");
		app.get("*", createStaticHandler(webDistDir));
	}

	const server = serve({ fetch: app.fetch, port, hostname: host });
	console.info(`[admin] 管理端已启动 http://${host}:${port}`);
	return {
		host,
		port,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}
