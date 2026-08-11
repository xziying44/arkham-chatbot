/**
 * 真机压测：完整复刻生产代码路径（桥接 streamFn + 技能 + promptLoader + thinkingLevel）。
 * 用真实 DeepSeek，不连 QQ（stub send_message/send_image）。
 *
 * 在生产服务器上跑：
 *   cd packages/server && node --env-file=../../.env --import tsx scripts/stress.ts
 *
 * 验证目标（可用性回归）：
 * 1. 闲聊：一轮回复非空
 * 2. 制卡（完整输入 A 档）：多轮工具调用不 400、不空回复、send_message stub 收到消息
 * 3. 制卡（大白话 B 档）：加载 card-text-lint、多轮不 400
 *
 * 每个场景跑完打印 PASS/FAIL + 耗时 + 轮次，方便定位哪步挂。
 */
import { type Model, type Models } from "@earendil-works/pi-ai";
import {
	groupScope,
	SessionManager,
	PromptLoader,
	createSendImageTool,
	createSendCardTool,
	createAskUserTool,
	createGenerateImageTool,
	loadSkillsFromDir,
	loadCardIndex,
} from "@arkham/chatbot-core";
import { createExecutionEnv } from "@arkham/chatbot-sandbox";
import { createNonStreamStreamFn } from "../src/non-stream-bridge.ts";
import { buildModels } from "../src/app.ts";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const DATA_DIR = resolve("./data-stress");
const SKILLS_DIR = resolve("../../skills");
const PROMPTS_DIR = resolve("../../prompts");

// 从 .env 读配置（由 --env-file 注入）
const MODEL_SPEC = process.env.CHATBOT_MODEL ?? "anthropic/deepseek-v4-flash";
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
const THINKING_LEVEL = process.env.CHATBOT_THINKING_LEVEL ?? "medium";
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const CARD_DB_DIR = process.env.CHATBOT_CARD_DATABASE_DIR;
const ARKHAM_BIN = process.env.ARKHAM_CLI_PATH;
const ARKHAM_ASSETS = process.env.ARKHAM_ASSETS_DIR;

interface TestResult {
	name: string;
	pass: boolean;
	replyText: string;
	rounds: number;
	durationMs: number;
	sentMessages: string[];
	error?: string;
}

async function main(): Promise<void> {
	console.log("=== 真机压测（复刻生产路径）===");
	console.log(`模型: ${MODEL_SPEC}`);
	console.log(`端点: ${ANTHROPIC_BASE_URL}`);
	console.log(`thinking: ${THINKING_LEVEL}`);
	console.log(`MiniMax: ${MINIMAX_API_KEY ? "已配置" : "未配置"}`);

	// 清理
	await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
	await mkdir(DATA_DIR, { recursive: true });

	// 1. 构建 Models（复用 app.ts buildModels，与生产同路径）
	const { models, model } = buildModels({
		model: MODEL_SPEC,
		anthropicBaseUrl: ANTHROPIC_BASE_URL,
		openaiBaseUrl: process.env.OPENAI_BASE_URL,
		thinkingLevel: THINKING_LEVEL,
		sessionTtlMs: 3_600_000,
		reaperIntervalMs: 60_000,
		sandbox: { enabled: false, networkDisabled: false, timeoutSeconds: 60 },
	});

	// 2. 桥接 streamFn（复刻 app.ts）
	const nativeStreamFn = (m: Model<any>, ctx: any, opts?: any) =>
		models.streamSimple(m, ctx, { ...opts, timeoutMs: 120_000, maxRetries: 3, maxRetryDelayMs: 8_000 });
	const streamFn = createNonStreamStreamFn(nativeStreamFn);

	// 3. 加载技能 + promptLoader（复刻 bot-manager）
	const promptLoader = new PromptLoader(PROMPTS_DIR);
	await promptLoader.load();
	const { skills } = await loadSkillsFromDir(SKILLS_DIR);
	console.log(`技能: ${skills.length} 个 (${skills.map(s => s.name).join(", ")})`);

	const cardIndex = CARD_DB_DIR ? await loadCardIndex(CARD_DB_DIR, "cards-db").catch(() => []) : [];

	const results: TestResult[] = [];

	// === 只跑制卡 A 档，保留数据用于分析 ===
	results.push(await runScenario(models, model, streamFn, skills, promptLoader, cardIndex, {
		name: "制卡 A 档「守护者支援卡完整输入」",
		messages: ["帮我做张守护者0级支援卡，叫测试卡，2费，武器，你得到+1👊，cost2"],
		expectSend: true,
		maxRounds: 40,
	}));

	// === 汇总 ===
	console.log("\n=== 压测结果汇总 ===");
	let allPass = true;
	for (const r of results) {
		const status = r.pass ? "✅ PASS" : "❌ FAIL";
		console.log(`${status} ${r.name} | ${r.durationMs}ms | ${r.rounds}轮 | send:${r.sentMessages.length}条`);
		if (!r.pass) {
			allPass = false;
			console.log(`  原因: ${r.error ?? "回复为空"}`);
			console.log(`  回复: ${r.replyText.slice(0, 100)}`);
		}
	}
	console.log(allPass ? "\n🎉 全部通过" : "\n⚠️ 有失败场景");

	// 保留 data-stress 用于分析（调试时注释掉 rm）
	// await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
	console.log(`数据保留在: ${DATA_DIR}`);
	process.exit(allPass ? 0 : 1);
}

async function runScenario(
	models: Models,
	model: Model<any>,
	streamFn: any,
	skills: any[],
	promptLoader: PromptLoader,
	cardIndex: any[],
	opts: { name: string; messages: string[]; expectSend: boolean; maxRounds?: number },
): Promise<TestResult> {
	console.log(`\n--- 场景: ${opts.name} ---`);
	const start = Date.now();
	const sentMessages: string[] = [];

	// 每个场景独立 SessionManager（隔离历史）
	const scenarioDir = resolve(DATA_DIR, opts.name.replace(/[^\w]/g, "_"));
	await mkdir(scenarioDir, { recursive: true }).catch(() => {});

	const sessions = new SessionManager({
		dataDir: scenarioDir,
		model,
		models,
		streamFn,
		envFactory: async (_scope, workspaceDir) =>
			createExecutionEnv({ enabled: false, cwd: workspaceDir, networkDisabled: false, timeoutSeconds: 60 }),
		ttlMs: 3_600_000,
		thinkingLevel: THINKING_LEVEL,
		skills,
		promptLoader,
		extraToolsFactory: (scope, getReplyToMsgId, workspaceDir, pendingAskHolder) => {
			const tools: any[] = [
				createSendImageTool({
					scopeId: scope.id, getReplyToMsgId, workspaceDir,
					send: async () => { console.log("  [stub] send_image"); },
				}),
				createSendCardTool({
					scopeId: scope.id, getReplyToMsgId, workspaceDir,
					send: async () => { console.log("  [stub] send_card"); },
				}),
				createAskUserTool({
					getReplyToMsgId, pendingAskHolder, scopeKind: scope.kind,
					sendKeyboard: async () => {},
				}),
			];
			if (cardIndex.length > 0) {
				// search_cards 不需要在这里加（它通过 loadCardIndex 全局缓存）
			}
			if (MINIMAX_API_KEY) {
				tools.push(createGenerateImageTool({
					apiKey: MINIMAX_API_KEY,
					apiBase: process.env.MINIMAX_API_BASE,
					workspaceDir,
				}));
			}
			return tools;
		},
		onSendMessage: async (_scope, text) => {
			sentMessages.push(text);
			console.log(`  [stub] send_message: ${text.slice(0, 60)}${text.length > 60 ? "..." : ""}`);
		},
	});
	sessions.start();

	let rounds = 0;
	let lastReply = "";
	let error: string | undefined;
	const maxRounds = opts.maxRounds ?? 5;

	try {
		for (const msg of opts.messages) {
			rounds++;
			console.log(`  → 发送: ${msg.slice(0, 50)}`);
			const reply = await sessions.dispatch({
				scope: groupScope("stress-test"),
				text: msg,
				senderId: "tester",
				senderName: "测试员",
				mentioned: true,
				platformMessageId: `stress-${rounds}`,
			});
			lastReply = reply.text ?? "";
			console.log(`  ← 回复: ${lastReply.slice(0, 80) || "(空)"}${lastReply.length > 80 ? "..." : ""}`);
		}
	} catch (e) {
		error = (e as Error).message;
		console.log(`  ✗ 异常: ${error}`);
	}

	await sessions.shutdown().catch(() => {});

	const durationMs = Date.now() - start;
	const pass = !error && (opts.expectSend ? sentMessages.length > 0 : lastReply.length > 0);

	return { name: opts.name, pass, replyText: lastReply, rounds, durationMs, sentMessages, error };
}

main().catch((e) => { console.error(e); process.exit(1); });
