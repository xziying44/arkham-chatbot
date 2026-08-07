import { test } from "node:test";
import assert from "node:assert/strict";
import {
	openDb,
	BotRepository,
	SettingsRepository,
	MessageRepository,
	LogRepository,
	AdminSessionRepository,
	AgentRuntimeRepository,
	UsageRepository,
} from "../src/index.ts";

test("bots repository: insert/get/list/update/delete", async () => {
	const db = await openDb(":memory:");
	const bots = new BotRepository(db);
	const created = bots.insert({ id: "b1", appId: "111", appSecret: "s1", name: "Bot One", persona: "你好" });
	assert.equal(created.appId, "111");
	assert.equal(created.enabled, true);
	assert.equal(created.persona, "你好");

	const got = bots.get("b1");
	assert.ok(got);
	assert.equal(got!.name, "Bot One");

	bots.insert({ id: "b2", appId: "222", appSecret: "s2", name: "Bot Two", enabled: false });
	assert.equal(bots.list().length, 2);

	const updated = bots.update("b1", { name: "Renamed", enabled: false });
	assert.equal(updated!.name, "Renamed");
	assert.equal(updated!.enabled, false);
	assert.equal(updated!.appId, "111"); // unchanged field preserved

	assert.equal(bots.delete("b2"), true);
	assert.equal(bots.delete("missing"), false);
	assert.equal(bots.list().length, 1);
	db.close();
});

test("settings repository: get/set/getOr/getInt/getBool/setMany/all", async () => {
	const db = await openDb(":memory:");
	const s = new SettingsRepository(db);
	assert.equal(s.get("missing"), undefined);
	assert.equal(s.getOr("missing", "fallback"), "fallback");

	s.set("k", "v");
	assert.equal(s.get("k"), "v");
	s.set("k", "v2"); // upsert
	assert.equal(s.get("k"), "v2");

	s.set("n", "42");
	assert.equal(s.getInt("n", 0), 42);
	assert.equal(s.getInt("absent", 7), 7);

	s.set("flag_true", "true");
	s.set("flag_1", "1");
	s.set("flag_false", "false");
	assert.equal(s.getBool("flag_true", false), true);
	assert.equal(s.getBool("flag_1", false), true);
	assert.equal(s.getBool("flag_false", true), false);
	assert.equal(s.getBool("absent", true), true);

	s.setMany({ a: "1", b: "2", c: "3" });
	const all = s.all();
	assert.equal(all.a, "1");
	assert.equal(all.c, "3");
	assert.equal(all.k, "v2");
	db.close();
});

test("messages repository: insert + filter + paginate", async () => {
	const db = await openDb(":memory:");
	const m = new MessageRepository(db);
	m.insert({ botId: "b1", direction: "in", scopeKind: "group", scopeId: "g1", text: "hello", senderId: "u1" });
	m.insert({ botId: "b1", direction: "out", scopeKind: "group", scopeId: "g1", text: "hi there" });
	m.insert({ botId: "b2", direction: "in", scopeKind: "user", scopeId: "u2", text: "hello world" });

	const all = m.list({ botId: "b1" });
	assert.equal(all.total, 2);
	assert.equal(all.items[0].direction, "out"); // newest first by ts

	const filtered = m.list({ botId: "b1", direction: "in" });
	assert.equal(filtered.total, 1);
	assert.equal(filtered.items[0].text, "hello");

	const searched = m.list({ text: "hello" });
	assert.equal(searched.total, 2);

	const paged = m.list({ size: 1, page: 2 });
	assert.equal(paged.items.length, 1);
	assert.equal(paged.page, 2);
	assert.equal(paged.size, 1);
	db.close();
});

test("logs repository: insert + filter", async () => {
	const db = await openDb(":memory:");
	const l = new LogRepository(db);
	l.insert({ level: "info", source: "app", message: "started" });
	l.insert({ level: "error", source: "router", botId: "b1", message: "failed" });
	l.insert({ level: "warn", source: "adapter", message: "reconnecting" });

	assert.equal(l.list({}).total, 3);
	assert.equal(l.list({ level: "error" }).total, 1);
	assert.equal(l.list({ botId: "b1" }).total, 1);
	assert.equal(l.list({ q: "reconnect" }).total, 1);
	db.close();
});

test("admin sessions: insert/get/pruneExpired", async () => {
	const db = await openDb(":memory:");
	const a = new AdminSessionRepository(db);
	const session = a.insert("token-abc", 1000);
	assert.equal(session.token, "token-abc");
	assert.ok(session.expiresAt > Date.now());

	assert.ok(a.get("token-abc"));
	assert.equal(a.get("missing"), undefined);

	// expired session: ttl = -1 (already past)
	a.insert("expired", -1);
	assert.equal(a.get("expired"), undefined); // get treats expired as not-found
	const pruned = a.pruneExpired();
	assert.equal(pruned, 1);
	assert.equal(a.get("token-abc").token, "token-abc"); // valid still present

	a.delete("token-abc");
	assert.equal(a.get("token-abc"), undefined);
	db.close();
});

test("openDb creates parent directory and persists to disk", async () => {
	const tmp = `/tmp/arkham-store-test-${Date.now()}/sub/db.sqlite`;
	const db = await openDb(tmp);
	new BotRepository(db).insert({ id: "x", appId: "1", appSecret: "s", name: "X" });
	db.close();
	const { readFile } = await import("node:fs/promises");
	const stat = await readFile(tmp);
	assert.ok(stat.byteLength > 0);
});

test("agent runtime: 热窗口按 token 截断并沉淀旧事件", async () => {
	const db = await openDb(":memory:");
	const runtime = new AgentRuntimeRepository(db);
	const scope = { botId: "b1", scopeKind: "group" as const, scopeId: "g1" };
	const first = runtime.insertEvent({ ...scope, direction: "in", senderId: "u1", visibleText: "第一条", tokenCount: 10 });
	const second = runtime.insertEvent({ ...scope, direction: "out", visibleText: "第二条", tokenCount: 20 });
	const third = runtime.insertEvent({ ...scope, direction: "in", senderId: "u2", visibleText: "第三条", tokenCount: 30 });

	assert.deepEqual(runtime.listHot(scope, 45).map((event) => event.id), [third.id]);
	assert.equal(runtime.hotTokenCount(scope), 60);
	const segment = runtime.compactEvents(scope, [first, second], "前两条摘要", ["第一条", "第二条"]);
	assert.equal(segment.tokenCount, 30);
	assert.deepEqual(runtime.listHot(scope).map((event) => event.id), [third.id]);
	assert.equal(runtime.hotTokenCount(scope), 30);
	assert.equal(runtime.listRecentSegments(scope)[0].summary, "前两条摘要");
	db.close();
});

test("agent runtime: 任务 CRUD、产物和空状态过滤", async () => {
	const db = await openDb(":memory:");
	const runtime = new AgentRuntimeRepository(db);
	const scope = { botId: "b1", scopeKind: "user" as const, scopeId: "u1" };
	const created = runtime.createTask({
		...scope,
		id: "task-1",
		scene: "card_render",
		creatorId: "u1",
		title: "制作泽耶尔",
		state: { cardName: "泽耶尔·戴" },
	});
	assert.equal(created.status, "active");
	assert.equal(runtime.listTasks(scope).length, 1);
	assert.deepEqual(runtime.listTasks(scope, []), []);

	runtime.addArtifact({ id: "artifact-1", taskId: "task-1", kind: "card", version: 1, relativePath: "tasks/task-1/cards/v001.card" });
	const updated = runtime.updateTask("task-1", { status: "completed", state: { cardName: "泽耶尔·戴", done: true } });
	assert.equal(updated?.latestArtifactId, "artifact-1");
	assert.equal(updated?.status, "completed");
	assert.equal(runtime.listTasks(scope).length, 0);
	assert.equal(runtime.listTasks(scope, ["completed"])[0].state.done, true);
	db.close();
});

test("agent runtime: 触发词可以命中完整记忆并记录使用次数", async () => {
	const db = await openDb(":memory:");
	const runtime = new AgentRuntimeRepository(db);
	const scope = { botId: "b1", scopeKind: "group" as const, scopeId: "g1" };
	runtime.upsertMemory({
		...scope,
		category: "术语",
		content: "‘揭示’应保留为规则术语，不改成‘展示’。",
		triggers: ["揭示"],
	});

	const matches = runtime.findRelevantMemories(scope, "这张牌的揭示效果怎么写？");
	assert.equal(matches.length, 1);
	assert.match(matches[0].content, /不改成/);
	assert.equal(matches[0].useCount, 1);
	assert.ok(matches[0].lastUsedAt);
	db.close();
});

test("usage repository: 汇总 token、缓存命中率和 P50/P95", async () => {
	const db = await openDb(":memory:");
	const usage = new UsageRepository(db);
	const scope = { botId: "b1", scopeKind: "group" as const, scopeId: "g1" };
	for (let index = 1; index <= 20; index++) {
		const id = `run-${index}`;
		usage.startRun({ ...scope, id, scene: "chat", routeMethod: "rule", startedAt: 1_000 });
		usage.insertModelCall({
			runId: id,
			sequence: 1,
			provider: "anthropic",
			api: "anthropic-messages",
			model: "deepseek-v4-flash",
			startedAt: 1_000,
			durationMs: index * 10,
			usage: { inputTokensTotal: 100, inputTokensUncached: 40, cacheReadTokens: 60, cacheWriteTokens: 0, outputTokens: 10 },
			toolCallCount: 0,
			status: "ok",
		});
		usage.finishRun(id, { status: index === 20 ? "error" : "ok", modelCallCount: 1, toolCallCount: 0, completedAt: 1_000 + index * 10 });
	}

	const summary = usage.summary();
	assert.equal(summary.runs, 20);
	assert.equal(summary.modelCalls, 20);
	assert.equal(summary.inputTokensTotal, 2_000);
	assert.equal(summary.cacheHitRate, 0.6);
	assert.equal(summary.p50DurationMs, 100);
	assert.equal(summary.p95DurationMs, 190);
	assert.equal(summary.failures, 1);
	db.close();
});
