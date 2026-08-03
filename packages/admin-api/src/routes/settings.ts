import { Hono } from "hono";
import type { DatabaseSync } from "@arkham/chatbot-store";
import {
	SettingsRepository,
	SettingsKeys,
} from "@arkham/chatbot-store";
import type { BotManagerLike } from "../contracts.ts";

interface SettingsRoutesDeps {
	readonly db: DatabaseSync;
	readonly botManager: BotManagerLike;
}

/** 可在管理端改的设置 key 白名单。 */
const EDITABLE = [
	SettingsKeys.llmModel,
	SettingsKeys.llmAnthropicBaseUrl,
	SettingsKeys.sessionTtlMs,
	SettingsKeys.sandboxEnabled,
	SettingsKeys.sandboxNetworkDisabled,
	SettingsKeys.sandboxTimeoutSeconds,
] as const;

/**
 * 系统提示词静态模板与默认工具描述（只读展示）。
 * 与 packages/core/src/agent/system-prompt.ts 的 buildSystemPrompt 保持同步。
 * 这里不复刻完整拼接逻辑（会引入对 core 工具构建的依赖），只展示骨架与占位符，
 * 真实的运行时提示词可在「会话详情」里看到完整渲染结果。
 */
const PROMPT_TEMPLATE = `你是「<群/用户 id>」的群聊机器人助手。你在群里帮助成员：回答问题、执行命令、读写文件、处理信息。

你收到的每条消息都来自真实的群成员，且已经 @了你。回答要像群友交流：简洁、直接、有用。不要用冗长的格式化输出刷屏。

## 你的设定
<机器人 persona（在机器人编辑里改）>

（工具的 name/description 由 pi-agent-core 通过 function-calling tools API 单独发给 LLM，不在此拼接）

## 准则
- 用 bash/read/write 等工具干活，不要凭空编造文件内容或命令结果。
- 你在一个受限沙箱里执行命令：默认断网、有超时、工作目录隔离。命令失败时如实说明。
- 回复尽量短。群聊场景下，三五句话比长篇大论更合适。
- 涉及文件路径时清晰标注。
- 发图片给用户：当用户想看工作目录内的某张图片时，调用 send_image 工具……
- 会话边界：你只为当前这个会话服务。所有回复、图片只会发到当前会话……

## 回复格式（重要）
你的回复会以 QQ markdown 渲染，但只支持有限语法……（禁用代码块/表格/三级以上标题）

## 长期记忆（跨会话保留，来自此前的对话）
<长期记忆，回收时自动生成>`;

const DEFAULT_TOOLS = [
	{ name: "bash", description: "执行 shell 命令（在沙箱内）" },
	{ name: "read", description: "读取文件内容" },
	{ name: "edit", description: "编辑文件（字符串替换）" },
	{ name: "write", description: "写入文件" },
	{ name: "send_image", description: "把工作目录内的一张图片发给当前会话用户" },
];

export function createSettingsRoutes(deps: SettingsRoutesDeps): Hono {
	const app = new Hono();
	const settings = new SettingsRepository(deps.db);
	const { botManager } = deps;

	// 读全部设置（脱敏：不返回 password hash/salt）。
	app.get("/", (c) => {
		const all = settings.all();
		const safe: Record<string, string> = {};
		for (const [k, v] of Object.entries(all)) {
			if (k === SettingsKeys.adminPasswordHash || k === SettingsKeys.adminPasswordSalt) continue;
			safe[k] = v;
		}
		return c.json(safe);
	});

	// 批量更新设置（只接受白名单 key）。
	app.patch("/", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, string>;
		const updates: Record<string, string> = {};
		for (const k of EDITABLE) {
			if (body[k] !== undefined) updates[k] = String(body[k]);
		}
		// 改管理员密码（可选）。
		if (body.admin_password !== undefined && body.admin_password !== "") {
			const { hashPassword } = await import("../auth.ts");
			const { hash, salt } = hashPassword(String(body.admin_password));
			updates[SettingsKeys.adminPasswordHash] = hash;
			updates[SettingsKeys.adminPasswordSalt] = salt;
		}
		if (Object.keys(updates).length === 0) return c.json({ ok: true, changed: 0 });
		settings.setMany(updates);
		return c.json({
			ok: true,
			changed: Object.keys(updates).length,
			note: "LLM/沙箱等运行参数改动后，对新激活会话生效；活跃会话需手动回收才会应用。",
		});
	});

	// 改 LLM 端点后，强制回收所有活跃会话以应用新模型。
	app.post("/reap-all", async (c) => {
		const count = await botManager.reapAllSessions();
		return c.json({ ok: true, reaped: count });
	});

	// 系统提示词预览（只读）：展示模板骨架与默认工具描述。
	app.get("/prompts", (c) => {
		return c.json({ template: PROMPT_TEMPLATE, tools: DEFAULT_TOOLS });
	});

	return app;
}
