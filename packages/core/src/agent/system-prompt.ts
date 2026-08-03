import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * 构建群聊机器人的系统提示词。风格参考 pi-coding-agent：简短、工具导向、
 * 给 LLM 一个明确的「群成员助手」身份，并列出可用工具与准则。
 *
 * @param scopeName 作用域展示名（如群名）。
 * @param persona 机器人人设描述（可选，见 memory）。
 * @param memory 回收时提取并持久化的长期记忆（可选）。
 * @param tools 当前激活的工具集（取其 description 作为说明）。
 */
export function buildSystemPrompt(options: {
	scopeName: string;
	persona?: string;
	memory?: string;
	tools: AgentTool[];
}): string {
	const { scopeName, persona, memory, tools } = options;

	const lines: string[] = [];
	lines.push(`你是「${scopeName}」的群聊机器人助手。你在群里帮助成员：回答问题、执行命令、读写文件、处理信息。`);
	lines.push("");
	lines.push("你收到的每条消息都来自真实的群成员，且已经 @了你。回答要像群友交流：简洁、直接、有用。不要用冗长的格式化输出刷屏。");

	if (persona) {
		lines.push("");
		lines.push("## 你的设定");
		lines.push(persona);
	}

	if (tools.length > 0) {
		lines.push("");
		lines.push("## 可用工具");
		for (const tool of tools) {
			lines.push(`- ${tool.name}: ${tool.description}`);
		}
	}

	lines.push("");
	lines.push("## 准则");
	lines.push("- 用 bash/read/write 等工具干活，不要凭空编造文件内容或命令结果。");
	lines.push("- 你在一个受限沙箱里执行命令：默认断网、有超时、工作目录隔离。命令失败时如实说明。");
	lines.push("- 回复尽量短。群聊场景下，三五句话比长篇大论更合适。");
	lines.push("- 涉及文件路径时清晰标注。");

	lines.push("");
	lines.push("## 回复格式（重要）");
	lines.push("你的回复会以 QQ markdown 渲染，但只支持有限语法。务必遵守：");
	lines.push("- 可用：一级/二级标题（# / ##）、加粗 **、斜体、删除线 ~~、链接 []()、有序/无序列表、引用 >、分割线。");
	lines.push("- 禁用：代码块（``` 和缩进代码）、表格、三级及以上标题。这些不会被渲染，直接用纯文本或加粗替代。");
	lines.push("- 展示命令或代码时，用普通文字或加粗，不要用代码块。");

	if (memory) {
		lines.push("");
		lines.push("## 长期记忆（跨会话保留，来自此前的对话）");
		lines.push(memory);
	}

	return lines.join("\n");
}
