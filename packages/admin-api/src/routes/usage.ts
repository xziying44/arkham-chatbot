import { Hono } from "hono";
import type { DatabaseSync } from "@arkham/chatbot-store";
import { UsageRepository } from "@arkham/chatbot-store";

export function createUsageRoutes(deps: { readonly db: DatabaseSync }): Hono {
	const app = new Hono();
	const usage = new UsageRepository(deps.db);

	app.get("/", (c) => {
		const now = Date.now();
		return c.json({
			lastHour: usage.summary(now - 60 * 60 * 1_000),
			last24Hours: usage.summary(now - 24 * 60 * 60 * 1_000),
			last7Days: usage.summary(now - 7 * 24 * 60 * 60 * 1_000),
			all: usage.summary(0),
		});
	});

	return app;
}
