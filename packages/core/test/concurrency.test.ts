import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Semaphore } from "../src/session/semaphore.ts";
import { TranscriptStore } from "../src/session/transcript-store.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ---- Semaphore ----

test("Semaphore: 名额内 acquire 立即返回，超出则阻塞到 release", async () => {
	const sem = new Semaphore(2);
	const log: string[] = [];
	const task = async (id: string, ms: number) => {
		await sem.acquire();
		log.push(`start-${id}`);
		await new Promise((r) => setTimeout(r, ms));
		log.push(`end-${id}`);
		sem.release();
	};
	// 三个任务，并发跑：前两个立即开始，第三个必须等一个 release。
	await Promise.all([task("a", 10), task("b", 10), task("c", 10)]);
	// 全程不会同时有 3 个 start；c 的 start 必在 a 或 b 的 end 之后。
	const startC = log.indexOf("start-c");
	const endA = log.indexOf("end-a");
	const endB = log.indexOf("end-b");
	assert.ok(startC > endA || startC > endB, `c 应在某任务结束后才开始: ${JSON.stringify(log)}`);
});

test("Semaphore: release 把名额直接转交给队首等待者（不超额）", async () => {
	const sem = new Semaphore(1);
	let active = 0;
	let maxActive = 0;
	const task = async () => {
		await sem.acquire();
		active++;
		maxActive = Math.max(maxActive, active);
		await new Promise((r) => setTimeout(r, 5));
		active--;
		sem.release();
	};
	// 5 个任务争 1 个名额 → 任意时刻最多 1 个在跑。
	await Promise.all(Array.from({ length: 5 }, () => task()));
	assert.equal(maxActive, 1, `maxActive 应为 1，实际 ${maxActive}`);
});

// ---- TranscriptStore ----

test("TranscriptStore: append 写入 JSONL，每行一条消息", async () => {
	const dir = await mkdtemp(join(tmpdir(), "transcript-"));
	const store = new TranscriptStore(dir);
	const msgs: AgentMessage[] = [
		{ role: "user", content: "hi", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 },
	];
	await store.append(msgs);
	const raw = await readFile(store.path, "utf8");
	const lines = raw.trim().split("\n");
	assert.equal(lines.length, 2);
	assert.deepEqual(JSON.parse(lines[0]), msgs[0]);
	assert.deepEqual(JSON.parse(lines[1]), msgs[1]);
	await rm(dir, { recursive: true, force: true });
});

test("TranscriptStore: 并发 append 串行化，不交错损坏（每行仍是合法 JSON）", async () => {
	const dir = await mkdtemp(join(tmpdir(), "transcript-"));
	const store = new TranscriptStore(dir);
	// 20 个并发批次，每批 5 条消息 → 100 条。串行化保证每行完整。
	const batches = Array.from({ length: 20 }, (_, i) =>
		store.append(Array.from({ length: 5 }, (_, j) => ({
			role: "user" as const,
			content: `m-${i}-${j}`,
			timestamp: i * 100 + j,
		}))),
	);
	await Promise.all(batches);
	const raw = await readFile(store.path, "utf8");
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	assert.equal(lines.length, 100, `应有 100 行，实际 ${lines.length}`);
	// 每行都能单独 JSON.parse（没被交错写坏）。
	for (const l of lines) {
		const parsed = JSON.parse(l) as { content: string };
		assert.match(parsed.content, /^m-\d+-\d+$/);
	}
	await rm(dir, { recursive: true, force: true });
});

test("TranscriptStore: 空 append 是 no-op（不改文件）", async () => {
	const dir = await mkdtemp(join(tmpdir(), "transcript-"));
	const store = new TranscriptStore(dir);
	await store.append([]);
	// path getter 给出文件路径，但没写过 → 文件不存在。
	await assert.rejects(() => readFile(store.path, "utf8"));
	await rm(dir, { recursive: true, force: true });
});
