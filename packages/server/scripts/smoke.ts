/**
 * 冒烟测试：不连真实 QQ，也不调真实 LLM。
 *
 * 用 pi-ai 的 faux provider（确定性回包）+ NodeExecutionEnv（macOS 开发回退），
 * 验证整条链路：IncomingMessage → SessionManager.dispatch → ChatBotSession.prompt → Agent → 回复。
 *
 * 运行：pnpm --filter @arkham/chatbot-server smoke
 * 期望：输出一条非空回复，并在 data/groups/test-scope/ 下生成 session.jsonl。
 */
import { type Model, type Models, createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { groupScope, SessionManager } from "@arkham/chatbot-core";
import { createExecutionEnv } from "@arkham/chatbot-sandbox";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const DATA_DIR = resolve("./data-smoke");
const PROVIDER_ID = "faux";
const MODEL_ID = "faux-smoke";

async function main(): Promise<void> {
	// 1) 清理上次残留。
	await rm(DATA_DIR, { recursive: true, force: true });
	await mkdir(DATA_DIR, { recursive: true });

	// 2) 用 faux provider 构造一个确定性回包的 Models。
	const models = createModels();
	const faux = fauxProvider({
		provider: PROVIDER_ID,
		models: [{ id: MODEL_ID, name: "Faux Smoke", contextWindow: 8192, maxTokens: 1024 }],
	});
	faux.setResponses([fauxAssistantMessage("你好！我是测试机器人，收到你的消息了。")]);
	(models as ReturnType<typeof createModels>).setProvider(faux.provider);
	const model = faux.getModel(MODEL_ID);
	if (!model) throw new Error("faux model not registered");

	// 3) 建 SessionManager（macOS 下 createExecutionEnv 自动回退 NodeExecutionEnv）。
	const sessions = new SessionManager({
		dataDir: DATA_DIR,
		model: model as Model<any>,
		models,
		streamFn: models.streamSimple.bind(models),
		envFactory: (_scope, workspaceDir) =>
			createExecutionEnv({ enabled: false, cwd: workspaceDir, networkDisabled: false }),
		ttlMs: 3_600_000,
	});
	sessions.start();

	// 4) 派发一条假群消息。
	const scope = groupScope("test-scope");
	const reply = await sessions.dispatch({
		scope,
		text: "你好，测试一下",
		senderId: "member-1",
		senderName: "测试成员",
		mentioned: true,
		platformMessageId: "fake-msg-1",
	});

	console.log("=== 冒烟结果 ===");
	console.log("回复文本:", JSON.stringify(reply.text));
	console.log("引用消息:", reply.replyToMessageId);
	console.log("活跃会话数:", sessions.activeCount);

	if (!reply.text || reply.text.length === 0) {
		console.error("❌ 回复为空，链路异常");
		process.exitCode = 1;
	} else {
		console.log("✅ 链路打通：消息进 → Agent 处理 → 回复出");
	}

	// 5) 验证历史落盘。
	await sessions.shutdown();
	const { readFile } = await import("node:fs/promises");
	const path = await import("node:path");
	const historyPath = path.join(DATA_DIR, "group/test-scope/session.jsonl");
	try {
		const content = await readFile(historyPath, "utf8");
		const lineCount = content.split("\n").filter((l) => l.trim()).length;
		console.log(`历史落盘：${historyPath}（${lineCount} 条消息）`);
		if (lineCount > 0) console.log("✅ 会话历史已持久化");
	} catch {
		console.error("❌ 历史未落盘");
		process.exitCode = 1;
	}

	await rm(DATA_DIR, { recursive: true, force: true });
}

main().catch((error) => {
	console.error("冒烟失败:", error);
	process.exit(1);
});
