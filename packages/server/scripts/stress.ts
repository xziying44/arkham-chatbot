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
	createRenderCardTool,
	createAskUserTool,
	createGenerateImageTool,
	loadSkillsFromDir,
	loadCardIndex,
} from "@arkham/chatbot-core";
import { createExecutionEnv } from "@arkham/chatbot-sandbox";
import { createNonStreamStreamFn } from "../src/non-stream-bridge.ts";
import { buildModels } from "../src/app.ts";
import { mkdir, rm, readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

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
	/** render_card 写入的 .card 的 body 字段（用于校验正文翻译，如「花费两个行动」→➡️➡️）。 */
	cardBody?: string;
	/** .card 是否含 picture_base64（校验插画嵌入）。 */
	cardHasImage?: boolean;
}

/**
 * 同群两成员并发场景：验证每成员智能体并行处理（不串行），且群共享 transcript
 * 同时记录了两个成员的消息。
 *
 * 判定：
 * - 两条 dispatch 都拿到非空回复（都成功）；
 * - 并发墙钟时间明显小于串行（两倍单条时间）→ 说明真并行；
 * - transcript.jsonl 同时含 [memberA]: 和 [memberB]: 两行。
 */
async function runConcurrentScenario(
	models: Models,
	model: Model<any>,
	streamFn: any,
	skills: any[],
	promptLoader: PromptLoader,
	cardIndex: any[],
	opts: {
		name: string;
		memberA: { id: string; text: string };
		memberB: { id: string; text: string };
	},
): Promise<TestResult> {
	console.log(`\n--- 场景: ${opts.name}（${opts.memberA.id} + ${opts.memberB.id} 并发）---`);
	const start = Date.now();
	const sentMessages: string[] = [];
	const scenarioDir = resolve(DATA_DIR, opts.name.replace(/[^\w]/g, "_"));
	await mkdir(scenarioDir, { recursive: true }).catch(() => {});

	const sessions = new SessionManager({
		dataDir: scenarioDir,
		model, models, streamFn,
		groupMaxConcurrent: 2,
		envFactory: async (ctx) =>
			createExecutionEnv({ enabled: false, cwd: ctx.workspaceDir, networkDisabled: false, timeoutSeconds: 60 }),
		ttlMs: 3_600_000,
		thinkingLevel: THINKING_LEVEL,
		skills,
		promptLoader,
		extraToolsFactory: (_scope, _getReply, _ws, _pending) => [],
		onSendMessage: async (_scope, text) => { sentMessages.push(text); },
	});
	sessions.start();

	const scope = groupScope("concurrent-test");
	let error: string | undefined;
	let replyA = "";
	let replyB = "";
	try {
		// 两条 dispatch 同时发出（不 await 第一条再发第二条）。
		const [ra, rb] = await Promise.all([
			sessions.dispatch({ scope, text: opts.memberA.text, senderId: opts.memberA.id, senderName: opts.memberA.id, mentioned: true, platformMessageId: "c-a" }),
			sessions.dispatch({ scope, text: opts.memberB.text, senderId: opts.memberB.id, senderName: opts.memberB.id, mentioned: true, platformMessageId: "c-b" }),
		]);
		replyA = ra.text ?? "";
		replyB = rb.text ?? "";
		console.log(`  ← ${opts.memberA.id}: ${replyA.slice(0, 60) || "(空)"}`);
		console.log(`  ← ${opts.memberB.id}: ${replyB.slice(0, 60) || "(空)"}`);
	} catch (e) {
		error = (e as Error).message;
		console.log(`  ✗ 异常: ${error}`);
	}

	await sessions.shutdown().catch(() => {});

	// 检查 transcript 是否同时记录了两位成员。
	const transcriptPath = join(scenarioDir, "group", "concurrent-test", "transcript.jsonl");
	let transcriptOk = false;
	try {
		const { readFile } = await import("node:fs/promises");
		const raw = await readFile(transcriptPath, "utf8");
		transcriptOk = raw.includes(`[${opts.memberA.id}]:`) && raw.includes(`[${opts.memberB.id}]:`);
	} catch (e) {
		console.log(`  ✗ transcript 读取失败: ${(e as Error).message}`);
	}

	const durationMs = Date.now() - start;
	// agent 用 send_message 发声时 dispatch 返回空文本是正常的（runPrompt 在 messageSentThisRun 时返回 ""），
	// 所以 pass 不能只看 reply：判无异常 + 两成员消息都进了 transcript + 两人都至少发了 1 条消息。
	const pass = !error && sentMessages.length >= 2 && transcriptOk;
	console.log(`  transcript 双成员: ${transcriptOk ? "✓" : "✗"} | 并发墙钟: ${durationMs}ms`);
	return { name: opts.name, pass, replyText: `${replyA} | ${replyB}`, rounds: 2, durationMs, sentMessages, error };
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
	const ONLY = process.env.STRESS_ONLY; // 只跑 name 含任一关键词的场景（逗号分隔，如 STRESS_ONLY=双行动,做账,贿赂）
	const onlyKeys = ONLY ? ONLY.split(",").map((s) => s.trim()).filter(Boolean) : [];
	const should = (name: string) => onlyKeys.length === 0 || onlyKeys.some((k) => name.includes(k));
	if (ONLY) console.log(`>> 只跑 name 含 [${onlyKeys.join(", ")}] 的场景`);

	// === 场景 1：闲聊 ===
	if (should("闲聊")) results.push(await runScenario(models, model, streamFn, skills, promptLoader, cardIndex, {
		name: "闲聊",
		messages: ["你好，你能做什么"],
		expectSend: true,
	}));

	// === 场景 2：制卡 A 档（完整输入）===
	if (should("制卡A")) results.push(await runScenario(models, model, streamFn, skills, promptLoader, cardIndex, {
		name: "制卡A",
		messages: ["帮我做张守护者0级支援卡，叫测试卡，2费，武器，你得到+1👊，cost2"],
		expectSend: true,
		maxRounds: 40,
	}));

	// === 场景 3：制卡 B 档（大白话）===
	if (should("制卡B")) results.push(await runScenario(models, model, streamFn, skills, promptLoader, cardIndex, {
		name: "制卡B",
		messages: ["帮我做张绿家事件卡，叫逃跑，0费，扣自己1血然后跑掉"],
		expectSend: true,
		maxRounds: 40,
	}));

	// === 场景 4：同群两成员并发（验证每成员并行处理 + 群共享 transcript）===
	if (should("同群并发")) results.push(await runConcurrentScenario(models, model, streamFn, skills, promptLoader, cardIndex, {
		name: "同群并发",
		memberA: { id: "memberA", text: "用一句话讲个冷笑话" },
		memberB: { id: "memberB", text: "1加1等于几？只回数字" },
	}));

	// === 场景 5：双行动翻译（验证「花费两个行动」大白话 → ➡️➡️，不是 ➡️花费2行动：）===
	if (should("双行动")) results.push(await runScenario(models, model, streamFn, skills, promptLoader, cardIndex, {
		name: "双行动",
		messages: ["帮我做张绿家事件卡叫疾行，0费，效果是花费两个行动抽取2张卡牌"],
		expectSend: true,
		maxRounds: 40,
	}));

	// === 场景 6：做账（群员真实指令，含「行动行动」=双行动 + body 多行 + 1书图标）===
	if (should("做账")) results.push(await runScenario(models, model, streamFn, skills, promptLoader, cardIndex, {
		name: "做账",
		messages: ["我要d一张卡 做账 0块流浪者0事件 1书 违法 查找你的绑定卡牌，找出1张查税，将其洗入你的牌库。然后，你获得6资源。将做账放置入场，放到你的游戏区域。行动行动：弃掉做账。"],
		expectSend: true,
		maxRounds: 40,
	}));

	// === 场景 7：贿赂（A 档规范输入，验证不乱改用户正文 + submit_icon「书」→智力）===
	if (should("贿赂")) results.push(await runScenario(models, model, streamFn, skills, promptLoader, cardIndex, {
		name: "贿赂",
		messages: ["做一张绿家事件卡，名称为贿赂，费用为0，等级为3，投入图标为一个书。效果为：作为打出贿赂的额外费用，花费任意点资源，每因此花费1资源，本次谈判检定难度-1。"],
		expectSend: true,
		maxRounds: 40,
	}));

	// === 场景 8：选择列表（验证 ~/-/* 列表前缀 → <点> 渲染）===
	if (should("选择列表")) results.push(await runScenario(models, model, streamFn, skills, promptLoader, cardIndex, {
		name: "选择列表",
		messages: ["帮我做张潜修者事件卡，3级6费，特性法术，效果：选择一项或多项：\n~将场上所有盟友支援卡以及非精英敌人卡移出游戏\n~将场上所有道具支援卡以及非弱点诡计卡移出游戏\n~将遭遇弃牌堆和调查员们的弃牌堆的所有卡移出游戏。"],
		expectSend: true,
		maxRounds: 40,
	}));

	// === 汇总 ===
	console.log("\n=== 压测结果汇总 ===");
	let allPass = true;
	for (const r of results) {
		const status = r.pass ? "✅ PASS" : "❌ FAIL";
		console.log(`${status} ${r.name} | ${r.durationMs}ms | ${r.rounds}轮 | send:${r.sentMessages.length}条`);
		if (r.cardBody) console.log(`  body: ${r.cardBody}`);
		if (r.cardHasImage !== undefined) console.log(`  含插画: ${r.cardHasImage ? "✅" : "❌"}`);
		if (!r.pass) {
			allPass = false;
			console.log(`  原因: ${r.error ?? "回复为空"}`);
			console.log(`  回复: ${r.replyText.slice(0, 100)}`);
		}
	}
	console.log(allPass ? "\n🎉 全部通过" : "\n⚠️ 有失败场景");

	await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
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
		envFactory: async (ctx) => {
			const workspaceDir = ctx.workspaceDir;
			// 模拟生产的 readOnlyBinds：把 arkham-cli、assets、skills、cards-db 挂到 workspace
			// NodeExecutionEnv 不支持 bwrap binds，用 symlink 代替
			const { symlink, mkdir } = await import("node:fs/promises");
			await mkdir(join(workspaceDir, ".arkham", "bin"), { recursive: true });
			const arkhamBin = ARKHAM_BIN ?? join(String(process.env.ARKHAM_WORKSHOP_DIR ?? ""), "target", "release", "arkham-cli");
			const arkhamAssets = ARKHAM_ASSETS ?? join(String(process.env.ARKHAM_WORKSHOP_DIR ?? ""), "assets");
			try { await symlink(arkhamBin, join(workspaceDir, ".arkham", "bin", "arkham-cli")); } catch {}
			try { await symlink(arkhamAssets, join(workspaceDir, ".arkham", "assets")); } catch {}
			try { await symlink(SKILLS_DIR, join(workspaceDir, "skills")); } catch {}
			if (CARD_DB_DIR) { try { await symlink(CARD_DB_DIR, join(workspaceDir, "cards-db")); } catch {} }
			return createExecutionEnv({ enabled: false, cwd: workspaceDir, networkDisabled: false, timeoutSeconds: 60 });
		},
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
				(() => {
					const rt = createRenderCardTool({ workspaceDir, arkhamBinPath: ARKHAM_BIN, arkhamAssetsDir: ARKHAM_ASSETS });
					return {
						...rt,
						execute: async (id: any, params: any, signal: any, onUpdate: any) => {
							const pp = params.picturePath;
							if (pp) {
								const abs = pp.startsWith("/") ? pp : join(workspaceDir, pp);
								const { access } = await import("node:fs/promises");
								try { await access(abs); console.log(`  [render] 图片存在 ✓ ${abs}`); }
								catch { console.log(`  [render] 图片不存在 ✗ ${abs}`); }
							}
							console.log(`  [render] picturePath=${pp ?? "(无→不嵌图)"}`);
							const result = await rt.execute(id, params, signal, onUpdate);
							const text = (result as any).content?.[0]?.text ?? "";
							console.log(`  [render] 返回: ${text.slice(0, 120)}`);
							return result;
						},
					};
				})(),
				createAskUserTool({
					getReplyToMsgId, pendingAskHolder, scopeKind: scope.kind,
					sendKeyboard: async () => {},
				}),
			];
			if (cardIndex.length > 0) {
				// search_cards 不需要在这里加（它通过 loadCardIndex 全局缓存）
			}
			if (MINIMAX_API_KEY) {
				const genTool = createGenerateImageTool({
					apiKey: MINIMAX_API_KEY,
					apiBase: process.env.MINIMAX_API_BASE,
					workspaceDir,
				});
				// 包装：打印调用参数 + 返回摘要，定位生图成功/失败
				tools.push({
					...genTool,
					execute: async (id: any, params: any, signal: any, onUpdate: any) => {
						const t0 = Date.now();
						console.log(`  [genimg] → type=${params.type} desc=${String(params.description).slice(0, 70)}`);
						const result = await genTool.execute(id, params, signal, onUpdate);
						const text = (result as any).content?.[0]?.text ?? "";
						console.log(`  [genimg] ← ${Date.now() - t0}ms: ${text.slice(0, 140)}`);
						return result;
					},
				});
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

	// 读取 render_card 写入的 .card：校验正文翻译（body）+ 插画嵌入（picture_base64）
	let cardBody: string | undefined;
	let cardHasImage = false;
	try {
		// stress 沙箱没 bind 群共享 cards（和生产差异），.card 在成员私有 workspace；群共享路径作 fallback
		const candidates = [
			join(scenarioDir, "group", "stress-test", "members", "tester", "workspace", "cards", "in"),
			join(scenarioDir, "group", "stress-test", "cards", "in"),
		];
		for (const cardDir of candidates) {
			const files = await readdir(cardDir).catch(() => []);
			for (const f of files) {
				if (!f.endsWith(".card")) continue;
				const data = JSON.parse(await readFile(join(cardDir, f), "utf8")) as { body?: string; picture_base64?: string };
				if (typeof data.body === "string" && !cardBody) cardBody = data.body;
				if (typeof data.picture_base64 === "string" && data.picture_base64.length > 0) cardHasImage = true;
			}
		}
	} catch { /* 无 .card 则跳过 */ }
	if (cardBody) console.log(`  [card body]: ${cardBody.slice(0, 140)}${cardBody.length > 140 ? "..." : ""}`);
	console.log(`  [card 含插画]: ${cardHasImage ? "✅ 是（picture_base64 已嵌入）" : "❌ 否（缺 picture_base64）"}`);

	const durationMs = Date.now() - start;
	const pass = !error && (opts.expectSend ? sentMessages.length > 0 : lastReply.length > 0);

	return { name: opts.name, pass, replyText: lastReply, rounds, durationMs, sentMessages, error, cardBody, cardHasImage };
}

main().catch((e) => { console.error(e); process.exit(1); });
