import type { PromptLoader } from "../prompts/prompt-loader.ts";

/**
 * 系统提示词构建入口（薄封装）。
 *
 * 实际提示词内容在 `prompts/static/*.md` 文件里（外置，方便人工查看 + 热更新）。
 * {@link PromptLoader} 负责加载文件、缓存、按缓存友好的顺序拼装（静态前缀在前，
 * 动态 persona/scopeName 在后）。详见 prompt-loader.ts 的文件头注释。
 *
 * 本文件只保留一个薄封装函数，兼容旧调用点（如 bench.ts）——传 loader 进来即可。
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
 * @param options scopeName/scopeKind/persona/skillsBlock
 */
export function buildSystemPrompt(
	loader: PromptLoader,
	options: {
		scopeName: string;
		scopeKind: "group" | "user";
		persona?: string;
		/** formatSkillsForSystemPrompt 的输出（已格式化好的技能清单 XML 块）。空则技能段不输出列表。 */
		skillsBlock?: string;
	},
): string {
	return loader.buildSystemPrompt(options);
}
