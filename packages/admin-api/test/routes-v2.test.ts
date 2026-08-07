import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeRepository, openDb } from "@arkham/chatbot-store";
import type { BotManagerLike } from "../src/contracts.ts";
import { createMemoryRoutes } from "../src/routes/memories.ts";
import { createUsageRoutes } from "../src/routes/usage.ts";

const botManager = {
	getScopeDir: () => undefined,
	listScopes: async () => [],
} as unknown as BotManagerLike;

test("记忆 v2 路由优先于旧动态路由", async () => {
	const db = await openDb(":memory:");
	const runtime = new AgentRuntimeRepository(db);
	runtime.insertEvent({
		botId: "bot-1",
		scopeKind: "group",
		scopeId: "group-1",
		direction: "in",
		senderId: "user-1",
		visibleText: "测试消息",
		tokenCount: 4,
	});

	const app = createMemoryRoutes({ db, botManager });
	const listResponse = await app.request("/v2/bot-1/scopes");
	assert.equal(listResponse.status, 200);
	const list = await listResponse.json() as {
		items: Array<{ kind: string; id: string; eventCount: number }>;
	};
	assert.equal(list.items.length, 1);
	assert.deepEqual({
		kind: list.items[0]?.kind,
		id: list.items[0]?.id,
		eventCount: list.items[0]?.eventCount,
	}, {
		kind: "group",
		id: "group-1",
		eventCount: 1,
	});

	const detailResponse = await app.request("/v2/bot-1/group/group-1");
	assert.equal(detailResponse.status, 200);
	const detail = await detailResponse.json() as { memories: unknown[]; segments: unknown[]; tasks: unknown[] };
	assert.deepEqual(detail, { memories: [], archivedMemories: [], segments: [], tasks: [] });
	db.close();
});

test("用量接口始终返回四个完整时间窗口", async () => {
	const db = await openDb(":memory:");
	const response = await createUsageRoutes({ db }).request("/");
	assert.equal(response.status, 200);
	const body = await response.json() as Record<string, { runs: number; byScene: unknown[] }>;
	assert.deepEqual(Object.keys(body), ["lastHour", "last24Hours", "last7Days", "all"]);
	for (const summary of Object.values(body)) {
		assert.equal(summary.runs, 0);
		assert.deepEqual(summary.byScene, []);
	}
	db.close();
});
