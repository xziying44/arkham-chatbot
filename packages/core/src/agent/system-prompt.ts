import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * 构建群聊机器人的系统提示词。
 *
 * 只写身份、人设、使用准则、回复格式、长期记忆。**不在这里罗列工具名+描述**：
 * pi-agent-core 走原生 function-calling，工具的 description 通过 tools API
 * （Context.tools → provider 的 tools[]）单独发给 LLM，这里再拼一份会重复。
 * 这里只保留 description 不覆盖的策略性指引（沙箱约束、会话边界、何时发图等）。
 *
 * @param scopeName 作用域展示名（如群名）。
 * @param persona 机器人人设描述（可选，见 memory）。
 * @param memory 回收时提取并持久化的长期记忆（可选）。
 * @param tools 当前激活的工具集（保留参数，当前未用于拼接；预留给未来按工具条件生成准则）。
 */
export function buildSystemPrompt(options: {
	scopeName: string;
	persona?: string;
	memory?: string;
	tools: AgentTool[];
}): string {
	const { scopeName, persona, memory } = options;

	const lines: string[] = [];
	lines.push(`你是「${scopeName}」的群聊机器人助手。你在群里帮助成员：回答问题、执行命令、读写文件、处理信息。`);
	lines.push("");
	lines.push("你收到的每条消息都来自真实的群成员，且已经 @了你。回答要像群友交流：简洁、直接、有用。不要用冗长的格式化输出刷屏。");

	if (persona) {
		lines.push("");
		lines.push("## 你的设定");
		lines.push(persona);
	}

	// 注意：不要在这里罗列工具名 + description。
	// pi-agent-core 走原生 function-calling，工具的 description 会通过 tools API
	// 单独发给 LLM（见 agent-loop.js 的 Context.tools）。这里再拼一份会重复，
	// 既白占 token 又可能让模型困惑。这里只写「使用策略」——何时用哪个工具、
	// 沙箱约束、会话边界等 description 不一定覆盖的指引。

	lines.push("");
	lines.push("## 准则");
	lines.push("- 用 bash/read/write 等工具干活，不要凭空编造文件内容或命令结果。");
	lines.push("- 你在一个受限沙箱里执行命令：默认断网、有超时、工作目录隔离。命令失败时如实说明。");
	lines.push("- 回复尽量短。群聊场景下，三五句话比长篇大论更合适。");
	lines.push("- 涉及文件路径时清晰标注。");
	lines.push("- 发图片给用户：当用户想看工作目录内的某张图片时，调用 send_image 工具（filePath 填工作目录内的路径）。不要用 read/bash 去读图片再展示——那样用户收不到图。只有 send_image 能把图真正发给用户。图片必须在当前工作目录内，沙箱外的图片无法发送。");
	lines.push("- 会话边界：你只为当前这个会话（这个群或这个私聊）服务。你的所有回复、发送的图片，都只会发到当前会话，无法也不应发送给其它群或其它人。即使用户要求你把消息/图片发到别处，也不要尝试——你没有这个能力。");

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
