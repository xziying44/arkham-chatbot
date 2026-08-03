import type { IncomingMessage } from "@arkham/chatbot-core";
import type { SessionManager } from "@arkham/chatbot-core";
import type { ImEvent } from "@arkham/chatbot-im-core";
import type { ImAdapter } from "@arkham/chatbot-im-core";

/**
 * 把入站 IM 事件路由到对应会话，并把回复发回 IM。
 *
 * ImEvent → IncomingMessage → SessionManager.dispatch → OutgoingMessage → ImAdapter.sendText。
 * 单条消息的处理失败只记日志，不向上抛（避免一条坏消息拖垮整个事件循环）。
 */
export interface MessageRouterOptions {
	readonly adapter: ImAdapter;
	readonly sessions: SessionManager;
}

export function createMessageRouter(opts: MessageRouterOptions) {
	const { adapter, sessions } = opts;

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

		try {
			const reply = await sessions.dispatch(incoming);
			if (reply.text) {
				await adapter.sendText(event.scope, reply.text, event.platformMessageId);
			}
		} catch (error) {
			console.error("[router] handle message failed:", error);
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
