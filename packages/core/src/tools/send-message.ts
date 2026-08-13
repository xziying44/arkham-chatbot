import { type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";

/**
 * send_message 工具：让 agent 主动决定何时发送消息给用户。
 *
 * agent 的文字输出（assistant content）不再自动发送给用户——只是思考过程。
 * agent 想发消息时调用此工具。这样 agent 可以在多轮工具调用中自由思考，
 * 只在准备好回复时才发消息，避免中间步骤刷屏。
 */

const sendMessageSchema = Type.Object({
	text: Type.String({ description: "要发送给用户的消息文本。支持 QQ markdown 语法（加粗、列表、引用等）。" }),
});

export type SendMessageInput = Static<typeof sendMessageSchema>;

export interface CreateSendMessageToolOptions {
	/** 实际发送消息的回调（调用 adapter.sendText）。 */
	send: (text: string) => Promise<void>;
}

export function createSendMessageTool(opts: CreateSendMessageToolOptions): AgentTool<typeof sendMessageSchema, undefined> {
	return {
		name: "send_message",
		label: "send_message",
		description:
			"发送一条正式回复给当前会话的用户。用于闲聊回复、长任务的开头反馈与最终结果。" +
		 "你的其它文字输出（工作过程描述）不是正式回复——私聊里它们会实时流给用户作思考可见，但正式结论用本工具发。" +
		 "不要把回复拆成多条消息，一条说清楚。" +
		 "支持 QQ markdown：加粗 **、列表、引用 >、标题 # 等。",
		parameters: sendMessageSchema,
		async execute(_toolCallId, params) {
			try {
				await opts.send(params.text);
				return {
					content: [{ type: "text", text: "消息已发送。" }],
					details: undefined,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `发送失败: ${(error as Error).message}` }],
					details: undefined,
				};
			}
		},
	};
}
