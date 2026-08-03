import { Hono } from "hono";
import type { DatabaseSync } from "@arkham/chatbot-store";
import { MessageRepository } from "@arkham/chatbot-store";

interface MessageRoutesDeps {
	readonly db: DatabaseSync;
}

export function createMessagesRoutes(deps: MessageRoutesDeps): Hono {
	const app = new Hono();
	const messages = new MessageRepository(deps.db);

	app.get("/", (c) => {
		const result = messages.list({
			botId: c.req.query("botId") || undefined,
			scopeKind: c.req.query("scopeKind") || undefined,
			scopeId: c.req.query("scopeId") || undefined,
			direction: (c.req.query("direction") as "in" | "out") || undefined,
			text: c.req.query("text") || undefined,
			page: c.req.query("page") ? Number(c.req.query("page")) : 1,
			size: c.req.query("size") ? Number(c.req.query("size")) : 50,
		});
		return c.json(result);
	});

	return app;
}
