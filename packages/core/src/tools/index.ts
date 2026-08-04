import type {
	AgentHarnessTool,
	AgentTool,
	ExecutionEnv,
	ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import {
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-agent-core";
import { createRestrictedBashTool } from "./restricted-bash.ts";

/**
 * 把一个 harness 工具（带 ExecutionToolContext 参数）绑定上固定 context，
 * 转成 core runtime 直接可用的 AgentTool。
 */
export function wrapHarnessTool(
	tool: AgentHarnessTool<ExecutionToolContext>,
	ctx: ExecutionToolContext,
): AgentTool {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: (toolCallId, params, signal, onUpdate) =>
			tool.execute(toolCallId, params, signal, onUpdate, ctx),
	};
}

export function wrapHarnessTools(
	tools: AgentHarnessTool<ExecutionToolContext>[],
	ctx: ExecutionToolContext,
): AgentTool[] {
	return tools.map((t) => wrapHarnessTool(t, ctx));
}

/**
 * 装配默认工具集。
 *
 * - bash → 受限 bash（createRestrictedBashTool）：只放行白名单命令（文件查看 +
 *   arkham-cli），拒绝脚本执行/网络/破坏操作。群聊场景下网友不能通过 agent
 *   执行任意命令。
 * - read/edit/write → pi-agent-core 原生文件工具（沙箱工作目录内操作）。
 *   用于记忆系统（memories/）和技能文件读取。
 */
export function createDefaultTools(env: ExecutionEnv): AgentTool[] {
	const ctx: ExecutionToolContext = { env };
	return [
		createRestrictedBashTool(env),
		...wrapHarnessTools(
			[createReadTool(), createEditTool(), createWriteTool()],
			ctx,
		),
	];
}
