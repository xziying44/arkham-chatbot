import type { ScopeKey } from "../identity/scope.ts";

/**
 * 进入 agent 的入站消息。IM 适配器把平台事件归一成这个结构，
 * 使 core 层不耦合任何具体 IM。
 */
export interface IncomingMessage {
	/** 该消息所属的会话作用域。 */
	readonly scope: ScopeKey;
	/** 消息正文。 */
	readonly text: string;
	/** 发送者在该平台内的稳定 ID。 */
	readonly senderId: string;
	/** 发送者展示名（群昵称优先）。 */
	readonly senderName: string;
	/** 是否 @ 了机器人。QQ 官方 API 仅投递 @机器人 的群消息，故群消息恒为 true。 */
	readonly mentioned: boolean;
	/** 平台原始消息 ID，用于被动回复时引用。 */
	readonly platformMessageId?: string;
}

/** agent 产出的出站消息。当前仅纯文本，后续可扩展为富内容。 */
export interface OutgoingMessage {
	readonly text: string;
	/** 回复时引用的入站消息平台 ID（被动回复）。 */
	readonly replyToMessageId?: string;
	/** 群消息回复时要 @ 的用户 openid（触发本轮 run 的发送者）。 */
	readonly mentionUserOpenid?: string;
}
