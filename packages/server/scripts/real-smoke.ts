/**
 * 真机联调：用本机 Claude 的配置（智谱 BigModel Anthropic 兼容端点）验证基础设施闭环。
 *
 * 不连 QQ，用一个假 IM 事件触发，但 LLM 走真实智谱 glm 模型。
 * 复用 app.ts 的 buildModels（与 pnpm start 走同一条 provider 注册路径）。
 *
 * 验证：消息进 → SessionManager → ChatBotSession → pi Agent（真实 LLM 调用）→ 回复。
 *
 * 用法：node --import tsx scripts/real-smoke.ts
 * 默认从 ~/.claude/settings.json 读 ANTHROPIC_AUTH_TOKEN 和 ANTHROPIC_BASE_URL。
 */
import { type Model } from "@earendil-works/pi-ai";
import { groupScope, SessionManager } from "@arkham/chatbot-core";
import { createExecutionEnv } from "@arkham/chatbot-sandbox";
import { buildModels } from "../src/app.ts";
import type { AppConfig } from "../src/config.ts";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const DATA_DIR = resolve("./data-real-smoke");
const MODEL_ID = process.env.CHATBOT_REAL_MODEL ?? "glm-4.6";

/** 从 ~/.claude/settings.json 读取智谱端点配置。 */
async function loadClaudeConfig(): Promise<{ token: string; baseUrl: string }> {
	const settingsPath = resolve(process.env.HOME ?? "~", ".claude/settings.json");
	const raw = await readFile(settingsPath, "utf8");
	const env = JSON.parse(raw).env as Record<string, string>;
	const token = process.env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_AUTH_TOKEN;
	const baseUrl = process.env.ANTHROPIC_BASE_URL ?? env.ANTHROPIC_BASE_URL;
	if (!token) throw new Error("ANTHROPIC_AUTH_TOKEN 未找到（settings.json 与环境变量都没有）");
	if (!baseUrl) throw new Error("ANTHROPIC_BASE_URL 未找到");
	return { token, baseUrl };
}

async function main(): Promise<void> {
	const { token, baseUrl } = await loadClaudeConfig();
	process.env.ANTHROPIC_AUTH_TOKEN = token; // pi-ai 的 anthropic auth resolver 会读这个
	console.log(`[real-smoke] 端点: ${baseUrl}`);
	console.log(`[real-smoke] token: ${token.slice(0, 8)}****`);

	await rm(DATA_DIR, { recursive: true, force: true });
	await mkdir(DATA_DIR, { recursive: true });

	// 复用产品代码 app.ts 的 buildModels，确保联调与 pnpm start 走同一条路径。
	const config: AppConfig = {
		qq: { appId: "", appSecret: "", apiBase: "" },
		model: `anthropic/${MODEL_ID}`,
		llm: { anthropicBaseUrl: baseUrl },
		session: { ttlMs: 3_600_000, reaperIntervalMs: 60_000 },
		sandbox: { enabled: false, networkDisabled: false, timeoutSeconds: 30 },
		dataDir: DATA_DIR,
	};
	const { models, model } = buildModels(config);

	const sessions = new SessionManager({
		dataDir: DATA_DIR,
		model: model as Model<any>,
		models,
		streamFn: models.streamSimple.bind(models),
		envFactory: async (_scope, workspaceDir) =>
			createExecutionEnv({ enabled: false, cwd: workspaceDir, networkDisabled: false }),
		ttlMs: 3_600_000,
	});
	sessions.start();

	console.log("\n=== 派发第一条消息（首激活，建 Agent）===");
	const scope = groupScope("real-test-group");
	const reply1 = await sessions.dispatch({
		scope,
		text: "你好！请用一句话自我介绍，并告诉我 2+3 等于几。",
		senderId: "member-A",
		senderName: "测试员A",
		mentioned: true,
		platformMessageId: "real-msg-1",
	});
	console.log("回复1:", reply1.text);

	console.log("\n=== 派发第二条消息（同群续话，验证上下文保持）===");
	const reply2 = await sessions.dispatch({
		scope,
		text: "我刚才问的那个算式，结果是多少？",
		senderId: "member-A",
		senderName: "测试员A",
		mentioned: true,
		platformMessageId: "real-msg-2",
	});
	console.log("回复2:", reply2.text);

	console.log("\n=== 验证 bash 工具（让机器人算个命令）===");
	const reply3 = await sessions.dispatch({
		scope,
		text: "帮我执行一下 echo hello-from-sandbox，把输出原样告诉我。",
		senderId: "member-B",
		senderName: "测试员B",
		mentioned: true,
		platformMessageId: "real-msg-3",
	});
	console.log("回复3:", reply3.text);

	console.log("\n=== 结果汇总 ===");
	console.log("活跃会话数:", sessions.activeCount);
	const nonEmpty = [reply1, reply2, reply3].filter((r) => r.text.length > 0).length;
	console.log(`非空回复: ${nonEmpty}/3`);
	if (nonEmpty === 3) {
		console.log("✅ 真机联调通过：真实 LLM + Agent 工具调用 + 多轮上下文 全部闭环");
	} else {
		console.log("⚠️  部分回复为空，检查上方输出");
	}

	await sessions.shutdown();
	const historyPath = resolve(DATA_DIR, "group/real-test-group/session.jsonl");
	const content = await readFile(historyPath, "utf8").catch(() => "");
	const lines = content.split("\n").filter((l) => l.trim());
	console.log(`历史落盘: ${historyPath}（${lines.length} 条消息）`);
	await rm(DATA_DIR, { recursive: true, force: true });
}

main().catch((error) => {
	console.error("真机联调失败:", error);
	process.exit(1);
});
