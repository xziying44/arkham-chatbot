import type {
	AgentHarnessTool,
	AgentTool,
	ExecutionEnv,
	ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-agent-core";

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

/** 装配默认工具集（bash + read + edit + write），全部绑定到同一 ExecutionEnv。 */
export function createDefaultTools(env: ExecutionEnv): AgentTool[] {
	const ctx: ExecutionToolContext = { env };
	return wrapHarnessTools(
		[createBashTool(), createReadTool(), createEditTool(), createWriteTool()],
		ctx,
	);
}
