import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, BotRepository, SettingsRepository, MessageRepository, LogRepository, AdminSessionRepository } from "../src/index.ts";

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
