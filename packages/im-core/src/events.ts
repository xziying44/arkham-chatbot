import type { ScopeKey } from "@arkham/chatbot-core";

/**
 * IM 平台归一化后的入站事件。适配器把平台原生事件（如 QQ 的
 * `GROUP_AT_MESSAGE_CREATE`）翻译成此结构，使上层与具体 IM 解耦。
 */
export interface ImMessageEvent {
	readonly type: "message";
	/** 归一化的会话作用域。 */
	readonly scope: ScopeKey;
	/** 消息正文（已剥离 @机器人 前缀）。 */
	readonly text: string;
	/** 发送者平台内稳定 ID。 */
	readonly senderId: string;
	/** 发送者展示名。 */
	readonly senderName: string;
	/** 是否 @ 了机器人。 */
	readonly mentioned: boolean;
	/** 平台原生消息 ID（用于被动回复引用）。 */
	readonly platformMessageId: string;
	/** 平台原始事件载荷（适配器内部用）。 */
	readonly raw: unknown;
}

export type ImEvent = ImMessageEvent;
