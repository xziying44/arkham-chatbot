import { Type, type Static } from "typebox";
import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core";

const workspaceOperation = Type.Union([
	Type.Object({ action: Type.Literal("list"), path: Type.String() }),
	Type.Object({ action: Type.Literal("read"), path: Type.String() }),
	Type.Object({ action: Type.Literal("write"), path: Type.String(), content: Type.String() }),
	Type.Object({ action: Type.Literal("append"), path: Type.String(), content: Type.String() }),
	Type.Object({ action: Type.Literal("mkdir"), path: Type.String() }),
]);

const workspaceSchema = Type.Object({
	operations: Type.Array(workspaceOperation, { minItems: 1, maxItems: 20 }),
});

const execSchema = Type.Object({
	commands: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
});

type WorkspaceInput = Static<typeof workspaceSchema>;
type ExecInput = Static<typeof execSchema>;

export function createBatchWorkspaceTool(env: ExecutionEnv): AgentTool<typeof workspaceSchema> {
	return {
		name: "workspace_batch",
		label: "workspace_batch",
		description: "一次批量列目录、读文件、写文件、追加内容或建目录。所有路径都受当前任务沙箱边界限制。",
		parameters: workspaceSchema,
		async execute(_toolCallId, input: WorkspaceInput, signal) {
			const results = await Promise.all(input.operations.map(async (operation) => {
				if (operation.action === "list") {
					const result = await env.listDir(operation.path, signal);
					return result.ok
						? { action: operation.action, path: operation.path, entries: result.value }
						: { action: operation.action, path: operation.path, error: result.error.message };
				}
				if (operation.action === "read") {
					const result = await env.readTextFile(operation.path, signal);
					return result.ok
						? { action: operation.action, path: operation.path, content: result.value }
						: { action: operation.action, path: operation.path, error: result.error.message };
				}
				if (operation.action === "mkdir") {
					const result = await env.createDir(operation.path, { recursive: true, abortSignal: signal });
					return result.ok
						? { action: operation.action, path: operation.path, ok: true }
						: { action: operation.action, path: operation.path, error: result.error.message };
				}
				if (operation.content.length > 256 * 1024) {
					return { action: operation.action, path: operation.path, error: "单次写入不能超过 256KB" };
				}
				const result = operation.action === "write"
					? await env.writeFile(operation.path, operation.content, signal)
					: await env.appendFile(operation.path, operation.content, signal);
				return result.ok
					? { action: operation.action, path: operation.path, ok: true }
					: { action: operation.action, path: operation.path, error: result.error.message };
			}));
			return {
				content: [{ type: "text", text: JSON.stringify(results) }],
				details: results,
			};
		},
	};
}

export function createBatchExecTool(env: ExecutionEnv): AgentTool<typeof execSchema> {
	return {
		name: "sandbox_exec_batch",
		label: "sandbox_exec_batch",
		description: "并行执行最多三条彼此独立的受限命令。命令仍受断网、超时、允许列表和文件边界硬护栏约束。",
		parameters: execSchema,
		async execute(_toolCallId, input: ExecInput, signal) {
			const results = await Promise.all(input.commands.map(async (command) => {
				const result = await env.exec(command, { abortSignal: signal });
				return result.ok
					? { command, ...result.value }
					: { command, error: result.error.message };
			}));
			return {
				content: [{ type: "text", text: JSON.stringify(results) }],
				details: results,
			};
		},
	};
}
