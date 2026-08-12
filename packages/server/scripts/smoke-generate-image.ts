/**
 * generate_image 工具冒烟测试：不连 QQ，验证「用户求画 → agent 调 generate_image
 * → 图落 workspace/generated/ → agent 调 send_image 发出」全链路。
 *
 * LLM 走 .env 真实配置（CHATBOT_MODEL），MiniMax 走 .env 的 MINIMAX_API_KEY。
 * send_message / send_image 是 stub：只记录，不发 QQ。
 *
 * 用法（仓库根目录）：
 *   cd packages/server && node --env-file=../../.env --import tsx scripts/smoke-generate-image.ts
 *
 * 判 PASS 条件：agent 调用了 generate_image 且 send_image stub 收到了 generated/ 下的真实图片文件。
 */
import { type Model } from "@earendil-works/pi-ai";
import {
	SessionManager,
	createGenerateImageTool,
	createSendImageTool,
	loadSkillsFromDir,
	groupScope,
} from "@arkham/chatbot-core";
import { createExecutionEnv } from "@arkham/chatbot-sandbox";
import { buildModels } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const DATA_DIR = resolve("./data-smoke-genimg");
const SCOPE = groupScope("smoke-group");
const PROMPT =
	"帮我画一张插画：一位中年女调查员，穿风衣戴软呢帽，在堆满古籍的阴暗图书馆里手提煤油灯，火光照亮侧脸，神情凝重。";

async function main(): Promise<void> {
	const config = loadConfig();
	if (!config.minimax) throw new Error("MINIMAX_API_KEY 未配置（.env），无法冒烟 generate_image");
	console.log(`[smoke] model=${config.model}`);
	// buildModels 吃 ResolvedSettings（与 app.ts 启动路径同一签名），手工拼一份。
	const { models, model } = buildModels({
		model: config.model,
		anthropicBaseUrl: config.llm.anthropicBaseUrl,
		openaiBaseUrl: config.llm.openaiBaseUrl,
		thinkingLevel: process.env.SMOKE_THINKING_LEVEL ?? "off",
		sessionTtlMs: config.session.ttlMs,
		reaperIntervalMs: config.session.reaperIntervalMs,
		sandbox: { enabled: false, networkDisabled: false, timeoutSeconds: 30 },
	});

	await rm(DATA_DIR, { recursive: true, force: true });
	await mkdir(DATA_DIR, { recursive: true });

	const skillsDir = resolve("../../skills");
	const { skills } = await loadSkillsFromDir(skillsDir);
	console.log(`[smoke] 技能已加载: ${skills.map((s) => s.name).join(", ")}`);

	// 记录 stub 收到的调用，供最后判定。
	const sentImages: string[] = [];
	const sentMessages: string[] = [];

	// arkham-cli 资产/二进制（diy-card 技能渲染用），与 bot-manager 同样的 readOnlyBinds 布局。
	const workshopBinds: [string, string][] = [];
	if (config.arkhamAssetsDir) workshopBinds.push([config.arkhamAssetsDir, ".arkham/assets"]);
	if (config.arkhamBinPath) workshopBinds.push([config.arkhamBinPath, ".arkham/bin/arkham-cli"]);

	const sessions = new SessionManager({
		dataDir: DATA_DIR,
		model: model as Model<any>,
		models,
		streamFn: models.streamSimple.bind(models),
		envFactory: async (ctx) =>
			createExecutionEnv({
				enabled: false, // 冒烟不测沙箱本身
				cwd: ctx.workspaceDir,
				networkDisabled: false,
				timeoutSeconds: 60,
				readOnlyBinds: [[skillsDir, "skills"], ...workshopBinds],
			}),
		ttlMs: 3_600_000,
		reaperIntervalMs: 60_000,
		thinkingLevel: process.env.SMOKE_THINKING_LEVEL ?? "off",
		skills,
		extraToolsFactory: (scope, getReplyToMsgId, wsDir) => [
			createSendImageTool({
				scopeId: scope.id,
				getReplyToMsgId,
				workspaceDir: wsDir,
				send: async (_scopeId, filePath) => {
					console.log(`[stub:send_image] ${filePath}`);
					sentImages.push(filePath);
				},
			}),
			createGenerateImageTool({
				apiKey: config.minimax!.apiKey,
				apiBase: config.minimax!.apiBase,
				workspaceDir: wsDir,
			}),
		],
		onSendMessage: async (_scope, text) => {
			console.log(`[stub:send_message] ${text.slice(0, 120)}${text.length > 120 ? "…" : ""}`);
			sentMessages.push(text);
		},
	});
	sessions.start();

	console.log(`[smoke] prompt: ${PROMPT}`);
	const { text } = await sessions.dispatch({
		scope: SCOPE,
		text: PROMPT,
		senderId: "tester",
		senderName: "冒烟测试",
		mentioned: true,
		platformMessageId: "smoke-msg-1",
	});
	if (text) console.log(`[smoke] 最终回复: ${text.slice(0, 200)}`);

	// ================= 测试 2：diy-card 无图自动画插画（两轮对话） =================
	// 用户给完整卡牌信息（A 流程）但没发图 → 确认后 agent 应自动调 generate_image
	// 画插画 → arkham-cli 渲染 → send_image 发卡图。
	console.log("\n=== 测试 2：diy-card 用户无图 → 自动 generate_image 插画 ===");
	const DIY_SCOPE = groupScope("smoke-diy");
	const diyWsDir = resolve(DATA_DIR, "group", DIY_SCOPE.id, "workspace");
	const imagesBefore = sentImages.length;
	const reply1 = await sessions.dispatch({
		scope: DIY_SCOPE,
		text: "帮我做一张支援卡：名字「老式提灯」，费用3，职阶探求者，特性：道具.工具，正文：➡️【调查】。你本次检定得到+2📚。",
		senderId: "tester",
		senderName: "冒烟测试",
		mentioned: true,
		platformMessageId: "smoke-msg-2",
	});
	if (reply1.text) console.log(`[smoke] 第一轮回复: ${reply1.text.slice(0, 150)}`);
	const reply2 = await sessions.dispatch({
		scope: DIY_SCOPE,
		text: "确认，出图吧",
		senderId: "tester",
		senderName: "冒烟测试",
		mentioned: true,
		platformMessageId: "smoke-msg-3",
	});
	if (reply2.text) console.log(`[smoke] 第二轮回复: ${reply2.text.slice(0, 150)}`);

	await sessions.shutdown();

	// ---- 判定 ----
	const generatedImages = sentImages.filter((p) => p.includes("generated/") && existsSync(p));
	console.log(`\n[smoke] 测试1: send_image 调用 ${sentImages.length} 次，其中 generated/ 真实文件 ${generatedImages.length} 张`);
	const diyImages = sentImages.slice(imagesBefore);
	// generate_image 产物：diy workspace 的 generated/ 目录里的图（agent 按 skill 不直接发原图，只渲染进卡图）。
	const diyGeneratedDir = resolve(diyWsDir, "generated");
	const diyGenerated = existsSync(diyGeneratedDir)
		? await (await import("node:fs/promises")).readdir(diyGeneratedDir)
		: [];
	const cardRendered = diyImages.some((p) => /cards[/\\]out[/\\].*\.png$/.test(p) && existsSync(p));
	const cardJsonPath = resolve(diyWsDir, "cards/in/000.card");
	const artUsedAsPicture = existsSync(cardJsonPath)
		&& (await (await import("node:fs/promises")).readFile(cardJsonPath, "utf8")).includes("generated/");
	let pass = true;
	if (generatedImages.length > 0) {
		console.log(`[smoke] 测试1 PASS ✅`);
	} else {
		console.error("[smoke] 测试1 FAIL ❌ agent 没有完成「生成 → 发图」闭环");
		pass = false;
	}
	if (diyGenerated.length > 0 && cardRendered && artUsedAsPicture) {
		console.log(`[smoke] 测试2 PASS ✅ 无图制卡自动画插画（generate_image ${diyGenerated.length} 张 → picture_path 引用 → 卡图渲染发送）`);
	} else {
		console.error(`[smoke] 测试2 FAIL ❌ diy 自动插画闭环不完整: generated=${diyGenerated.length} rendered=${cardRendered} pictureRef=${artUsedAsPicture}`);
		pass = false;
	}
	if (!pass) process.exit(1);
	console.log("[smoke] 全部通过 ✅");
	console.log(`[smoke] 产物保留在 ${DATA_DIR}（调试用，可手动删除）`);
}

await main();
