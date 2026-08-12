import type { PromptLoader, BuildSystemPromptOptions } from "../prompts/prompt-loader.ts";

/**
 * 系统提示词构建入口（薄封装）。
 *
 * 实际提示词内容在 `prompts/static/*.md` 文件里（外置，方便人工查看 + 热更新）。
 * {@link PromptLoader} 负责加载文件、拼装**纯静态**系统提示词（不含 per-bot/per-scope
 * 变量，跨会话字节一致以命中 cache_control）。动态变量（persona/群 id/成员 openid）
 * 由 {@link PromptLoader.buildSessionContext} 单独产出，注入系统提示词之后的首条消息。
 * 详见 prompt-loader.ts 的文件头注释。
 *
 * 本文件只保留薄封装函数，兼容旧调用点（如 bench.ts）——传 loader 进来即可。
 *
 * **不在这里罗列工具名+描述**：pi-agent-core 走原生 function-calling，工具的
 * description 通过 tools API（Context.tools → provider 的 tools[]）单独发给 LLM。
 *
 * 安全多层防御：
 * - 提示词层（prompts/static/safety.md）：声明约束，减少误操作，挡低级 prompt injection。
 * - 代码层（更重要）：GuardedExecutionEnv 拦截泄露性命令；send_image realpath 边界 +
 *   scopeId 绑定；bwrap 断网。提示词是最弱的护栏，代码层才是硬墙。
 *
 * @param loader 已 load() 过的 PromptLoader 实例（通常由 BotManager 持有、共享给所有会话）
 * @param options scopeKind/skillsContent（系统提示词只依赖这两个）
 */
export function buildSystemPrompt(loader: PromptLoader, options: BuildSystemPromptOptions): string {
	return loader.buildSystemPrompt(options);
}
