import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { DatabaseSync } from "@arkham/chatbot-store";
import { LogRepository } from "@arkham/chatbot-store";
import type { LogBusLike } from "../contracts.ts";

interface LogRoutesDeps {
	readonly db: DatabaseSync;
	readonly logBus: LogBusLike;
}

export function createLogsRoutes(deps: LogRoutesDeps): Hono {
	const app = new Hono();
	const logs = new LogRepository(deps.db);
	const { logBus } = deps;

	// 分页查询历史日志。
	app.get("/", (c) => {
		const result = logs.list({
			level: (c.req.query("level") as "debug" | "info" | "warn" | "error") || undefined,
			source: c.req.query("source") || undefined,
			botId: c.req.query("botId") || undefined,
			q: c.req.query("q") || undefined,
			page: c.req.query("page") ? Number(c.req.query("page")) : 1,
			size: c.req.query("size") ? Number(c.req.query("size")) : 100,
		});
		return c.json(result);
	});

	// SSE 实时尾随：先回放缓冲里最近的，再实时推。
	app.get("/stream", (c) => {
		return streamSSE(c, async (stream) => {
			// 先回放缓冲。
			for (const entry of logBus.recent()) {
				await stream.writeSSE({ event: "log", data: JSON.stringify(entry) });
			}
			// 实时订阅。
			let closed = false;
			const queue: string[] = [];
			const unsubscribe = logBus.subscribe((entry) => {
				if (!closed) queue.push(JSON.stringify(entry));
			});
			try {
				while (!closed) {
					while (queue.length > 0) {
						const data = queue.shift()!;
						await stream.writeSSE({ event: "log", data });
					}
					// Hono 的 stream 没有 waitForClose，用短暂 sleep 轮询。
					await stream.sleep(200);
					// 检查连接是否仍在（writeSSE 抛错则退出）。
					if ((c.env as { aborted?: boolean } | undefined)?.aborted) closed = true;
				}
			} finally {
				closed = true;
				unsubscribe();
			}
		});
	});

	return app;
}
