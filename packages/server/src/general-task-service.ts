import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	createBatchExecTool,
	createBatchWorkspaceTool,
	type CapabilityResult,
	type GeneralTaskInput,
	type PromptRegistry,
} from "@arkham/chatbot-core";
import { createExecutionEnv } from "@arkham/chatbot-sandbox";
import type { SandboxConfig } from "./bot-manager.ts";

export interface GeneralTaskServiceOptions {
	readonly model: Model<any>;
	readonly streamFn: StreamFn;
	readonly prompts: PromptRegistry;
	readonly sandbox: SandboxConfig;
}

export function createGeneralTaskService(
	opts: GeneralTaskServiceOptions,
): (input: GeneralTaskInput) => Promise<CapabilityResult> {
	return async (input) => {
		const taskWorkspace = join(input.workspaceDir, "tasks", input.taskId, "workspace");
		const env = await createExecutionEnv({
			enabled: opts.sandbox.enabled,
			cwd: taskWorkspace,
			networkDisabled: opts.sandbox.networkDisabled,
			timeoutSeconds: opts.sandbox.timeoutSeconds,
		});
		const messages: AssistantMessage[] = [];
		const toolBudget = new BatchToolCallBudget(3);
		const startedAt = Date.now();
		const agent = new Agent({
			initialState: {
				systemPrompt: opts.prompts.compose("general"),
				model: opts.model,
				tools: [
					createBatchWorkspaceTool(env),
					createBatchExecTool(env),
				],
				messages: [],
				thinkingLevel: "low",
			},
			streamFn: opts.streamFn,
			sessionId: "general:" + input.taskId,
			toolExecution: "parallel",
			beforeToolCall: async () => toolBudget.take(),
		});
		const unsubscribe = agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				messages.push(event.message);
			}
		});
		try {
			await agent.prompt(input.rawText);
		} finally {
			unsubscribe();
			await env.cleanup();
		}
		const final = [...messages].reverse().find((message) => message.stopReason !== "toolUse");
		const text = final ? assistantText(final) : "";
		const durationMs = Date.now() - startedAt;
		return {
			text: text || "任务已执行，但没有可展示的文本结果。",
			modelCalls: messages.map((message) => ({
				message,
				durationMs: Math.round(durationMs / Math.max(1, messages.length)),
			})),
			toolCalls: toolBudget.used,
		};
	};
}

export class BatchToolCallBudget {
	private attempts = 0;

	constructor(private readonly limit: number) {}

	take(): { block: true; reason: string } | undefined {
		this.attempts++;
		return this.attempts > this.limit
			? { block: true, reason: `本轮最多允许${this.limit}次批量能力调用` }
			: undefined;
	}

	get used(): number {
		return Math.min(this.attempts, this.limit);
	}
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
}
