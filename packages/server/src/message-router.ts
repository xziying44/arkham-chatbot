import type { IncomingMessage, Logger } from "@arkham/chatbot-core";
import type { SessionManager } from "@arkham/chatbot-core";
import type { ImEvent, StreamSink } from "@arkham/chatbot-im-core";
import type { ImAdapter } from "@arkham/chatbot-im-core";
import type { MessageRepository } from "@arkham/chatbot-store";

/**
 * 把入站 IM 事件路由到对应会话，并把回复发回 IM。
 *
 * ImEvent → IncomingMessage → SessionManager.dispatch → OutgoingMessage → ImAdapter.sendText。
 * 单条消息的处理失败只记日志，不向上抛（避免一条坏消息拖垮整个事件循环）。
 *
 * 同时把入站/出站消息写入 message 流水（管理端「消息列表」用）。
 *
 * 私聊（C2C）流式：c2cStreaming 开启且 scope 是 user 时，把 agent 每轮的非工具文字
 * （text_delta）实时流到 adapter.openStream 的 markdown 引用块作为「思考可见」，
 * 减少多轮工具流程的死寂等待。主回复仍走 send_message（agent 行为不变）。
 * 群聊 / 流式未开 / openStream 失败 → 退回批量 sendText。
 */
export interface MessageRouterOptions {
	readonly adapter: ImAdapter;
	readonly sessions: SessionManager;
	/** 当前机器人 id（消息流水归属）。 */
	readonly botId: string;
	/** 消息流水仓库（可选；不传则不落库，便于测试）。 */
	readonly messages?: MessageRepository;
	/** 私聊流式输出开关。默认 true；false 时一律走批量发送。 */
	readonly c2cStreaming?: boolean;
	readonly logger?: Logger;
}

/** 流式刷新节流间隔（毫秒）。LLM 事件远快于 50 QPS 上限，合并刷新避免限流 + 降闪烁。 */
const STREAM_THROTTLE_MS = 100;
/** 「正在输入」心跳间隔（毫秒）。QQ 的 typing 指示通常在收到 input_state=1 后维持数秒，
 *  4 秒一次足够续上，又不会过于频繁。 */
const KEEPALIVE_INTERVAL_MS = 4_000;

export function createMessageRouter(opts: MessageRouterOptions) {
	const { adapter, sessions, botId, messages, c2cStreaming = true, logger } = opts;

	return async function handle(event: ImEvent): Promise<void> {
		// 按钮点击回调：立即应答平台（3 秒时限），再路由到 session 消费挂起的 ask_user。
		if (event.type === "interaction") {
			// 立即 PUT /interactions/{id} 应答，避免用户端一直 loading。
			// fire-and-forget：即使应答失败也不影响 resolve ask_user。
			adapter.replyInteraction?.(event.interactionId, 0).catch((e) => {
				logger?.warn("应答交互事件失败", { interactionId: event.interactionId, error: (e as Error).message });
			});
			// resolve 对应成员会话的挂起提问（用户点了按钮 → 选择完成）。
			// 传 senderId 作为 memberId：群聊路由到点击者的成员会话。
			sessions.dispatchInteraction(event.scope, {
				interactionId: event.interactionId,
				buttonData: event.buttonData,
				buttonId: event.buttonId,
			}, event.senderId);
			return;
		}
		if (event.type !== "message") return;
		const incoming: IncomingMessage & { attachments?: typeof event.attachments } = {
			scope: event.scope,
			text: event.text,
			senderId: event.senderId,
			senderName: event.senderName,
			mentioned: event.mentioned,
			platformMessageId: event.platformMessageId,
			attachments: event.attachments,
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

		// 是否启用 C2C 流式（思考可见）：私聊 + 总开关 + adapter 实现 openStream。
		const streamEnabled = c2cStreaming && event.scope.kind === "user" && typeof adapter.openStream === "function";

		// 流式状态：懒开启（首个 delta 到才 startStream），节流累积。
		let sink: StreamSink | undefined;
		let sinkOpening: Promise<StreamSink | undefined> | undefined;
		let pending = "";                  // 节流期间累积的待 flush 文本
		let firstDelta = true;             // 首个 delta 不加换行前缀（直接续在首片 firstContent 之后）
		let throttleTimer: NodeJS.Timeout | undefined;
		let flushing = false;              // 防止 flush 重入
		// 「正在输入」心跳：sink 开启后定期调 keepAlive，维持 input_state=1 指示，
		// 填补 agent 跑 LLM（无文字产出）的间隙，避免用户以为卡住。
		let keepAliveTimer: NodeJS.Timeout | undefined;
		const startKeepAlive = (s: StreamSink): void => {
			if (!s.keepAlive) return;
			keepAliveTimer = setInterval(() => { void s.keepAlive!().catch(() => {}); }, KEEPALIVE_INTERVAL_MS);
		};
		const stopKeepAlive = (): void => {
			if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = undefined; }
		};

		const flush = async (): Promise<void> => {
			if (flushing) return;
			flushing = true;
			// 先取走 pending，清空 timer，再异步发送（避免 await 期间又触发调度）。
			const chunk = pending;
			pending = "";
			if (throttleTimer) {
				clearTimeout(throttleTimer);
				throttleTimer = undefined;
			}
			try {
				// 等 sink 开启完成（懒开启可能在途中）。
				if (sinkOpening) {
					sink = await sinkOpening;
					sinkOpening = undefined;
					// sink 首次就绪，启动「正在输入」心跳。
					if (sink) startKeepAlive(sink);
				}
				if (sink && chunk) {
					await sink.onDelta(chunk);
				}
			} catch (e) {
				logger?.warn("流式 flush 失败（已忽略，继续走批量兜底）", { error: (e as Error).message });
				sink = undefined; // 标记坏掉，后续不再尝试
			} finally {
				flushing = false;
			}
		};

		const scheduleFlush = (): void => {
			if (throttleTimer) return;
			throttleTimer = setTimeout(() => {
				void flush();
			}, STREAM_THROTTLE_MS);
		};

		const onText = streamEnabled
			? (delta: string): void => {
					if (!delta) return;
					console.log(`[stream-router] onText 触发 delta_len=${delta.length} sink=${sink ? "yes" : sinkOpening ? "opening" : "none"}`);
					// 纯文本格式（content_type=text）：QQ 私聊对 markdown 引用块(>)渲染不稳定，
					// 会间歇性「该消息类型暂不支持查看」。改用纯文本 + 💭 emoji 前缀做视觉区分。
					// 首片 firstContent 已是 "💭 "，后续 delta 前加换行续接。
					pending += firstDelta ? delta : `\n${delta}`;
					firstDelta = false;
					// 懒开启：首个 delta 到才 startStream。
					if (!sink && !sinkOpening) {
						console.log("[stream-router] 首个 delta，发起 openStream");
						sinkOpening = adapter.openStream!(event.scope, {
							msgId: event.platformMessageId,
							contentType: "text",
							firstContent: "💭 ",
						}).catch((e) => {
							logger?.warn("openStream 失败，降级批量发送", { error: (e as Error).message });
							return undefined;
						});
					}
					scheduleFlush();
				}
			: undefined;

		let reply;
		try {
			reply = await sessions.dispatch(incoming, { onText });
		} catch (error) {
			// dispatch 抛错：若已开流式，先收尾（避免用户端卡在最后一帧），再走错误回复。
			await flush().catch(() => {});
			stopKeepAlive();
			if (sink) await sink.finish().catch(() => {});
			logger?.error("处理消息失败", {
				botId,
				scope: `${event.scope.kind}:${event.scope.id}`,
				error: (error as Error).message,
			});
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
			try {
				await adapter.sendText(
					event.scope,
					"（出了点问题，暂时没法处理这条消息。）",
					event.platformMessageId,
				);
			} catch {
				/* 连兜底回复都失败，只能放弃。 */
			}
			return;
		}

		// 最后一次强制 flush（把节流期间残留的 delta 送出去）。
		await flush().catch(() => {});

		// 停止「正在输入」心跳（run 结束，不再需要维持指示）。
		stopKeepAlive();

		// 流式收尾：纯文本思考消息定稿。保证用户端不会卡在最后一帧。
		// 思考与回复的关系（用户决策「思考保留 + 回复另发」）：
		// - 思考（工具轮文字）→ 已在流式消息里，finish 收尾保留可见。
		// - 回复（最终轮文字 / send_message）→ 一条独立的新消息。
		if (sink) {
			await sink.finish().catch(() => {});
		}

		if (reply.text) {
			// 用 dispatch 返回的 replyToMessageId（触发 run 的那条群消息），
			// 而非当前 event 的 messageId——群消息合并时可能不同。
			// @ 人由 agent 自行决定（在文本里写 <qqbot-at-user> 标签），adapter 不自动 @。
			await adapter.sendText(
				event.scope,
				reply.text,
				reply.replyToMessageId ?? event.platformMessageId,
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
	};
}
