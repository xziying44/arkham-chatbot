import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { PromptRegistry, TurnPlanner } from "@arkham/chatbot-core";
import { openDb } from "@arkham/chatbot-store";
import { buildModels, resolveSettings } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createNonStreamStreamFn } from "../src/non-stream-bridge.ts";
import { createCardRenderService } from "../src/card-render-service.ts";

const config = loadConfig();
const db = await openDb(config.dbPath);
try {
	const settings = resolveSettings(config, db);
	const { models, model } = buildModels(settings);
	const nativeStreamFn = (currentModel: Model<any>, context: any, options?: any) =>
		models.streamSimple(currentModel, context, {
			...options,
			timeoutMs: 120_000,
			maxRetries: 3,
			maxRetryDelayMs: 8_000,
		});
	const prompts = new PromptRegistry(config.promptsDir);
	await prompts.load();
	const planner = new TurnPlanner(model, createNonStreamStreamFn(nativeStreamFn), prompts);
	const expectedBody = [
		"你以溺于夜色之中在弃牌堆开始游戏。",
		"<反应>补给阶段开始时：你可以放弃摸牌和获得资源，改为查找弃牌堆底三张牌，抽取其中一张非弱点牌。",
		"旧印：+1，你可以将弃牌堆中最多三张牌以任意顺序放到弃牌堆底。",
	].join("\n");
	const cases = [
		{ name: "问候", text: "晚上好呀" },
		{ name: "自然查卡", text: "想瞅瞅那张叫大砍刀的牌具体写了啥" },
		{ name: "语法", text: "这段话读起来有点绕，帮我捋成官方口吻，只动表述别动任何数值：补给阶段开始时从弃牌堆底下三张里拿一张。" },
		{ name: "平衡", text: "我总觉得这个能力有点离谱，你给掂量掂量强度，但先别替我改。" },
		{
			name: "制卡",
			text: "做一张牌，名称泽耶尔·戴，职介守卫者，属性4143，血8san6\n漂泊者 天选\n能力为：\n你以溺于夜色之中在弃牌堆开始游戏。\n<反应>补给阶段开始时：你可以放弃摸牌和获得资源，改为查找弃牌堆底三张牌，抽取其中一张非弱点牌。\n旧印：+1，你可以将弃牌堆中最多三张牌以任意顺序放到弃牌堆底。\n\n牌组数量：25\n牌组构筑选项：守卫者卡牌等级0-5，资源花费为0的牌等级0，中立卡牌等级0-5。\n牌组构筑需求（不计入牌组数量）：泽耶尔的家传吊坠，无月夜的祝福，溺于夜色之中，随机基础弱点。",
		},
	];
	const selectedCase = process.env.BENCHMARK_CASE;

	for (const item of cases) {
		if (selectedCase && item.name !== selectedCase) continue;
		const result = await planner.plan({
			text: item.text,
			runtimeContext: {
				scope: { kind: "group", id: "benchmark" },
				sender: { id: "tester", name: "测试者" },
				activeTasks: [],
				memories: [],
				coldSummaries: [],
				attachments: [],
			},
			sessionId: "benchmark:v2",
		});
		const firstCard = result.plan.cards?.[0];
		if (item.name === "问候") {
			assert.equal(result.plan.scene, "chat");
			assert.equal(result.plan.action, "respond");
		}
		if (item.name === "自然查卡") {
			assert.equal(result.plan.scene, "card_search");
			assert.equal(result.plan.action, "card_search");
		}
		if (item.name === "语法") {
			assert.equal(result.plan.scene, "card_text");
			assert.equal(result.plan.action, "respond");
		}
		if (item.name === "平衡") {
			assert.equal(result.plan.scene, "card_design");
		}
		if (item.name === "制卡") {
			assert.equal(result.plan.scene, "card_render");
			assert.equal(result.plan.action, "card_render");
			assert.equal(result.plan.cards?.length, 2);
			assert.equal(firstCard?.type, "调查员卡");
			assert.equal(firstCard?.name, "泽耶尔·戴");
			assert.equal(firstCard?.class, "守卫者");
			assert.deepEqual(firstCard?.attribute, [4, 1, 4, 3]);
			assert.equal(firstCard?.health, 8);
			assert.equal(firstCard?.horror, 6);
			assert.deepEqual(firstCard?.traits, ["漂泊者", "天选"]);
			assert.equal(firstCard?.body, expectedBody);
			const backCard = result.plan.cards?.[1];
			assert.equal(backCard?.type, "调查员卡背");
			assert.equal(backCard?.name, "泽耶尔·戴");
			assert.equal(backCard?.class, "守卫者");
			const cardBack = backCard?.card_back as Record<string, unknown> | undefined;
			assert.equal(cardBack?.size, 25);
			assert.ok(Array.isArray(cardBack?.option));
			const options = (cardBack?.option as unknown[]).map(String).join("，");
			assert.ok(options.includes("守卫者卡牌等级0-5"));
			assert.ok(options.includes("资源花费为0的牌等级0"));
			assert.ok(options.includes("中立卡牌等级0-5"));
			assert.equal(cardBack?.requirement, "泽耶尔的家传吊坠，无月夜的祝福，溺于夜色之中，随机基础弱点。");
			if (process.env.BENCHMARK_RENDER === "1") {
				await verifyRealRender(config, item.text, result.plan.cards);
			}
		}
		console.log(JSON.stringify({
			name: item.name,
			durationMs: result.durationMs,
			scene: result.plan.scene,
			action: result.plan.action,
			taskMode: result.plan.taskMode,
			query: result.plan.query,
			responseLength: result.plan.response?.length ?? 0,
			input: result.message.usage.input,
			cacheRead: result.message.usage.cacheRead,
			cacheWrite: result.message.usage.cacheWrite,
			output: result.message.usage.output,
			card: firstCard ? {
				type: firstCard.type,
				name: firstCard.name,
				class: firstCard.class,
				attribute: firstCard.attribute,
				health: firstCard.health,
				horror: firstCard.horror,
				body: firstCard.body,
			} : undefined,
			cardBack: result.plan.cards?.[1],
		}));
	}
} finally {
	db.close();
}

async function verifyRealRender(
	config: ReturnType<typeof loadConfig>,
	rawText: string,
	cards: readonly Record<string, unknown>[],
): Promise<void> {
	assert.ok(config.arkhamBinPath, "ARKHAM_CLI_PATH 未配置");
	assert.ok(config.arkhamAssetsDir, "ARKHAM_ASSETS_DIR 未配置");
	const workspaceDir = await mkdtemp(join(tmpdir(), "arkham-v2-render-"));
	try {
		await mkdir(join(workspaceDir, "fixture"), { recursive: true });
		await writeFile(
			join(workspaceDir, "fixture", "art.png"),
			Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XzrzoQAAAABJRU5ErkJggg==", "base64"),
		);
		const render = createCardRenderService({
			arkhamBinPath: config.arkhamBinPath,
			arkhamAssetsDir: config.arkhamAssetsDir,
		});
		const output = await render({
			scope: { kind: "group", id: "benchmark" },
			scopeDir: workspaceDir,
			workspaceDir,
			taskId: "benchmark-render",
			rawText,
			cards,
			attachmentPaths: ["fixture/art.png"],
		});
		assert.equal(output.images?.length, 2);
		console.log(JSON.stringify({ name: "真实渲染", images: output.images?.length, artifacts: output.artifacts?.length }));
	} finally {
		await rm(workspaceDir, { recursive: true, force: true });
	}
}
