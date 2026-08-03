import { readFile, stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { Context } from "hono";

/**
 * 为 SPA 提供静态文件服务。
 *
 * 策略：
 * - 把 URL 路径映射到 webDistDir 下（规范化防越界）。
 * - 文件存在 → 返回内容（按扩展名设 Content-Type）。
 * - 不存在 → 返回 index.html（SPA 客户端路由 fallback）。
 *
 * 仅用于内部管理端，但仍做基本的路径越界防护。
 */
export function createStaticHandler(webDistDir: string) {
	const root = normalize(webDistDir);
	return async (c: Context): Promise<Response> => {
		let rel = decodeURIComponent(new URL(c.req.url).pathname);
		if (rel === "/") rel = "/index.html";
		// 规范化并确保不跳出 root。
		const abs = normalize(join(root, rel));
		if (!abs.startsWith(root)) {
			return c.text("Forbidden", 403);
		}
		// 文件存在？
		const exists = await stat(abs)
			.then((s) => s.isFile())
			.catch(() => false);
		const target = exists ? abs : join(root, "index.html");
		try {
			const body = await readFile(target);
			return new Response(body, {
				status: exists ? 200 : 200, // SPA fallback 也返回 200
				headers: { "Content-Type": contentType(target) },
			});
		} catch {
			return c.text("Not Found", 404);
		}
	};
}

function contentType(path: string): string {
	if (path.endsWith(".html")) return "text/html; charset=utf-8";
	if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
	if (path.endsWith(".css")) return "text/css; charset=utf-8";
	if (path.endsWith(".json")) return "application/json; charset=utf-8";
	if (path.endsWith(".svg")) return "image/svg+xml";
	if (path.endsWith(".png")) return "image/png";
	if (path.endsWith(".ico")) return "image/x-icon";
	if (path.endsWith(".woff2")) return "font/woff2";
	return "application/octet-stream";
}
