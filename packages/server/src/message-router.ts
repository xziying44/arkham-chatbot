import type { IncomingMessage } from "@arkham/chatbot-core";
import type { SessionManager } from "@arkham/chatbot-core";
import type { Logger } from "@arkham/chatbot-core";
import type { ImEvent } from "@arkham/chatbot-im-core";
import type { ImAdapter } from "@arkham/chatbot-im-core";
import type { MessageRepository } from "@arkham/chatbot-store";

/**
 * 把入站 IM 事件路由到对应会话，并把回复发回 IM。
 *
 * ImEvent → IncomingMessage → SessionManager.dispatch → OutgoingMessage → ImAdapter.sendText。
 * 单条消息的处理失败只记日志，不向上抛（避免一条坏消息拖垮整个事件循环）。
 *
 * 同时把入站/出站消息写入 message 流水（管理端「消息列表」用）。
 */
export interface MessageRouterOptions {
	readonly adapter: ImAdapter;
	readonly sessions: SessionManager;
	/** 当前机器人 id（消息流水归属）。 */
	readonly botId: string;
	/** 消息流水仓库（可选；不传则不落库，便于测试）。 */
	readonly messages?: MessageRepository;
	readonly logger?: Logger;
}

export function createMessageRouter(opts: MessageRouterOptions) {
	const { adapter, sessions, botId, messages, logger } = opts;

	return async function handle(event: ImEvent): Promise<void> {
		if (event.type !== "message") return;
		const incoming: IncomingMessage = {
			scope: event.scope,
			text: event.text,
			senderId: event.senderId,
			senderName: event.senderName,
			mentioned: event.mentioned,
			platformMessageId: event.platformMessageId,
		};

		// 入站落库（失败仅记日志，不影响处理）。
		try {
			messages?.insert({
				botId,
				direction: "in",
				scopeKind: event.scope.kind,
				scopeId: event.scope.id,
				senderId: event.senderId,
				senderName: event.senderName,
				text: event.text,
				platformMsgId: event.platformMessageId,
			});
		} catch (e) {
			logger?.warn("入站消息落库失败", { botId, error: (e as Error).message });
		}

			try {
				const reply = await sessions.dispatch(incoming);
				if (reply.text) {
					// 用 dispatch 返回的 replyToMessageId（触发 run 的那条群消息），
					// 而非当前 event 的 messageId——群消息合并时可能不同。
					// mentionUserOpenid 让群消息回复 @ 触发送者。
					await adapter.sendText(
						event.scope,
						reply.text,
						reply.replyToMessageId ?? event.platformMessageId,
						reply.mentionUserOpenid,
					);
				// 出站落库。
				try {
					messages?.insert({
						botId,
						direction: "out",
						scopeKind: event.scope.kind,
						scopeId: event.scope.id,
						text: reply.text,
						platformMsgId: event.platformMessageId,
						status: "ok",
					});
				} catch (e) {
					logger?.warn("出站消息落库失败", { botId, error: (e as Error).message });
				}
			}
		} catch (error) {
			logger?.error("处理消息失败", {
				botId,
				scope: `${event.scope.kind}:${event.scope.id}`,
				error: (error as Error).message,
			});
			// 出站错误也落库。
			try {
				messages?.insert({
					botId,
					direction: "out",
					scopeKind: event.scope.kind,
					scopeId: event.scope.id,
					text: "（出了点问题，暂时没法处理这条消息。）",
					platformMsgId: event.platformMessageId,
					status: "error",
					error: (error as Error).message,
				});
			} catch {
				/* 落库失败忽略 */
			}
			// 兜底回复，避免群里看起来毫无响应。
			try {
				await adapter.sendText(
					event.scope,
					"（出了点问题，暂时没法处理这条消息。）",
					event.platformMessageId,
				);
			} catch {
				/* 连兜底回复都失败，只能放弃。 */
			}
		}
	};
}
