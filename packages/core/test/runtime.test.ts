import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AgentRuntimeRepository, UsageRepository, openDb } from "@arkham/chatbot-store";
import { PromptRegistry, estimateTokens } from "../src/runtime/prompt-registry.ts";
import { parseTurnPlan } from "../src/runtime/scene-router.ts";
import { ScopeCoordinator, normalizeModelUsage } from "../src/runtime/scope-coordinator.ts";

test("回合规划：解析模型语义判断，不依赖用户句式", () => {
	const search = parseTurnPlan('{"scene":"card_search","taskMode":"inline","action":"card_search","query":"大砍刀","confidence":0.98}');
	assert.equal(search.scene, "card_search");
	assert.equal(search.taskMode, "inline");
	assert.equal(search.action, "card_search");
	assert.equal(search.query, "大砍刀");
	assert.equal(search.confidence, 0.98);
	assert.equal(parseTurnPlan('{"scene":"card_render","taskMode":"new","action":"card_render","confidence":1}').scene, "card_render");
	assert.equal(parseTurnPlan('{"scene":"card_text","taskMode":"new","action":"respond","response":"优化后的文本","confidence":0.9}').response, "优化后的文本");
	const corrected = parseTurnPlan('{"scene":"card_design","taskMode":"inline","action":"card_render","confidence":0.8}');
	assert.equal(corrected.scene, "card_render");
	assert.equal(corrected.taskMode, "new");
});

test("回合规划：容错解析多个对象和紧凑枚举", () => {
	const result = parseTurnPlan([
		'{"scene":"cardsearch","taskMode":"inline","action":"cardsearch","respond":"","query":"黛西"}',
		'{"scene":"cardsearch","taskMode":"inline","action":"cardsearch","query":"黛西","response":"","confidence":0.8}',
	].join("\n"));
	assert.equal(result.scene, "card_search");
	assert.equal(result.action, "card_search");
	assert.equal(result.query, "黛西");
	assert.equal(result.confidence, 0.8);
});

test("回合规划：损坏的规划结果不会作为用户回复外泄", () => {
	const result = parseTurnPlan('{"scene":"card_search"');
	assert.equal(result.action, "respond");
	assert.equal(result.response, "我刚才没能正确理解这条消息，请再试一次。");
	assert.equal(result.response?.includes("scene"), false);
	assert.equal(result.confidence, 0);
});

test("提示词注册表：热重载原子替换且旧快照保持不变", async () => {
	const root = await mkdtemp(join(tmpdir(), "prompt-registry-"));
	const files = [
		"base.md",
		"scenes/chat.md",
		"scenes/rules.md",
		"scenes/card-search.md",
		"scenes/card-text.md",
		"scenes/card-render.md",
		"scenes/card-design.md",
		"scenes/general.md",
		"internal/router.md",
		"internal/summary.md",
		"internal/memory.md",
		"knowledge/card-language.md",
		"knowledge/card-schema.md",
		"knowledge/card-balance.md",
	];
	await Promise.all(files.map(async (file) => {
		await mkdir(join(root, file.split("/").slice(0, -1).join("/")), { recursive: true });
		await writeFile(join(root, file), `初始-${file}`, "utf8");
	}));
	const registry = new PromptRegistry(root);
	const first = await registry.load();
	await writeFile(join(root, "base.md"), "更新后的基础提示词", "utf8");
	const second = await registry.reload();

	assert.equal(first.version, 1);
	assert.equal(second.version, 2);
	assert.notEqual(first.hash, second.hash);
	assert.match(registry.compose("chat", first), /初始-base\.md/);
	assert.match(registry.compose("chat", second), /更新后的基础提示词/);
	assert.match(registry.composePlanner(second), /更新后的基础提示词/);
	assert.ok(estimateTokens("中文 abc") >= 3);
});

test("模型用量归一化：Anthropic 与 OpenAI 缓存口径不同", () => {
	const anthropic = assistant('{"scene":"chat"}', "anthropic-messages", {
		input: 40,
		cacheRead: 60,
		cacheWrite: 10,
		output: 5,
	});
	assert.deepEqual(normalizeModelUsage(anthropic), {
		inputTokensTotal: 110,
		inputTokensUncached: 40,
		cacheReadTokens: 60,
		cacheWriteTokens: 10,
		outputTokens: 5,
	});
	const openai = assistant("ok", "openai-completions", {
		input: 100,
		cacheRead: 60,
		cacheWrite: 0,
		output: 5,
	});
	assert.equal(normalizeModelUsage(openai).inputTokensTotal, 100);
	assert.equal(normalizeModelUsage(openai).inputTokensUncached, 40);
});

test("ScopeCoordinator：群级记忆会在下一轮命中并注入", async () => {
	const db = await openDb(":memory:");
	const runtime = new AgentRuntimeRepository(db);
	const usage = new UsageRepository(db);
	const seenContexts: Array<Record<string, unknown>> = [];
	let call = 0;
	const planner = {
		async plan(input: { runtimeContext?: Readonly<Record<string, unknown>> }) {
			seenContexts.push({ ...(input.runtimeContext ?? {}) });
			call++;
			const message = assistant("ok", "anthropic-messages");
			return {
				plan: {
					scene: "chat" as const,
					taskMode: "inline" as const,
					action: "respond" as const,
					response: call === 1 ? "我记住了。" : "揭示是规则术语。",
					memories: call === 1
						? [{ category: "术语", content: "‘揭示’是规则术语，不改为‘展示’。", triggers: ["揭示"] }]
						: [],
					confidence: 1,
				},
				message,
				promptHash: "test",
				durationMs: 1,
			};
		},
	};
	const coordinator = new ScopeCoordinator({
		botId: "b1",
		dataDir: "/tmp/coordinator-test",
		model: fakeModel(),
		streamFn: (() => { throw new Error("不应调用备用模型"); }) as never,
		prompts: {} as PromptRegistry,
		runtime,
		usage,
		planner,
	});
	const base = {
		scope: { kind: "group" as const, id: "g1" },
		senderId: "u1",
		senderName: "成员",
		mentioned: true,
	};
	assert.equal((await coordinator.dispatch({ ...base, text: "记住：揭示不要改词", platformMessageId: "m1" })).text, "我记住了。");
	assert.equal((await coordinator.dispatch({ ...base, text: "这个揭示怎么写", platformMessageId: "m2" })).text, "揭示是规则术语。");

	const injected = seenContexts[1].memories as Array<{ content: string }>;
	assert.equal(injected[0].content, "‘揭示’是规则术语，不改为‘展示’。");
	assert.equal(runtime.listHot({ botId: "b1", scopeKind: "group", scopeId: "g1" }).length, 4);
	assert.equal(usage.summary().runs, 2);
	await coordinator.shutdown();
	db.close();
});

test("ScopeCoordinator：规划器已有完整分析时不重复调用模型", async () => {
	const db = await openDb(":memory:");
	const usage = new UsageRepository(db);
	let fallbackCalls = 0;
	const coordinator = new ScopeCoordinator({
		botId: "b1",
		dataDir: "/tmp/coordinator-deliberate-test",
		model: fakeModel(),
		streamFn: (() => {
			fallbackCalls++;
			throw new Error("不应重复调用模型");
		}) as never,
		prompts: {} as PromptRegistry,
		runtime: new AgentRuntimeRepository(db),
		usage,
		planner: {
			async plan() {
				return {
					plan: {
						scene: "card_design" as const,
						taskMode: "inline" as const,
						action: "deliberate" as const,
						response: "这个能力的资源效率偏高，但暂时不改数值。",
						confidence: 0.95,
					},
					message: assistant("完整分析", "anthropic-messages"),
					promptHash: "test",
					durationMs: 1,
				};
			},
		},
	});
	const reply = await coordinator.dispatch({
		scope: { kind: "group", id: "g1" },
		text: "帮我评估强度，先别改",
		senderId: "u1",
		senderName: "成员",
		mentioned: true,
		platformMessageId: "m1",
	});

	assert.equal(reply.text, "这个能力的资源效率偏高，但暂时不改数值。");
	assert.equal(fallbackCalls, 0);
	assert.equal(usage.summary().modelCalls, 1);
	await coordinator.shutdown();
	db.close();
});

test("ScopeCoordinator：查卡直接返回首张卡图而不追加模型调用", async () => {
	const db = await openDb(":memory:");
	const usage = new UsageRepository(db);
	const coordinator = new ScopeCoordinator({
		botId: "b1",
		dataDir: "/tmp/coordinator-search-test",
		model: fakeModel(),
		streamFn: (() => { throw new Error("查卡后不应再次调用模型"); }) as never,
		prompts: {} as PromptRegistry,
		runtime: new AgentRuntimeRepository(db),
		usage,
		cardIndex: [{
			arkhamdb_id: "01002",
			name_zh: "黛西·沃克",
			category: "玩家卡",
			cycle: "基础游戏",
			type: "调查员",
			class: "探求者",
			traits: ["米斯卡塔尼克"],
			submit_icon: [],
			faces: [{ face: "a", imageFile: "cards-db/card_images/01002_a.jpg", type: "调查员" }],
		}],
		resolveCardImage: (path) => "/card-database/" + path,
		planner: {
			async plan() {
				return {
					plan: {
						scene: "card_search" as const,
						taskMode: "inline" as const,
						action: "card_search" as const,
						query: "黛西",
						confidence: 1,
					},
					message: assistant("查卡规划", "anthropic-messages"),
					promptHash: "test",
					durationMs: 1,
				};
			},
		},
	});
	const reply = await coordinator.dispatch({
		scope: { kind: "user", id: "u1" },
		text: "查找一下黛西调查员",
		senderId: "u1",
		senderName: "测试者",
		mentioned: true,
		platformMessageId: "m1",
	});

	assert.match(reply.text, /黛西·沃克/);
	assert.deepEqual(reply.images, ["/card-database/cards-db/card_images/01002_a.jpg"]);
	assert.equal(usage.summary().modelCalls, 1);
	await coordinator.shutdown();
	db.close();
});

function fakeModel(): Model<any> {
	return {
		id: "fake",
		name: "Fake",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

function assistant(
	text: string,
	api = "anthropic-messages",
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number } = {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
	},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api,
		provider: api === "anthropic-messages" ? "anthropic" : "openai",
		model: "fake",
		usage: {
			...usage,
			totalTokens: usage.input + usage.output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
