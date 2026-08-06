import { EventEmitter } from "node:events";
import type { QQClient } from "./client.ts";
import {
	C2C_MESSAGE_CREATE,
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	DEFAULT_INTENTS,
	FATAL_CLOSE_CODES,
	GROUP_AT_MESSAGE_CREATE,
	HEARTBEAT_ACK_TOLERANCE,
	INTERACTION_CREATE,
	OpCode,
	READY_EVENT,
	RECONNECT_BASE_DELAY_MS,
	RECONNECT_MAX_DELAY_MS,
	RESUMABLE_CLOSE_CODES,
	RESUMED_EVENT,
} from "./constants.ts";
import type {
	C2cMessageData,
	GroupAtMessageData,
	HelloData,
	InteractionData,
	MessageAttachment,
	ReadyData,
	WsPayload,
} from "./types.ts";

/**
 * QQ Gateway WebSocket 接收器（生产级稳定连接）。
 *
 * 协议流程：
 *   connect ws → 收 HELLO(op10, d.heartbeat_interval)
 *   → 发 IDENTIFY(op2) 或 RESUME(op6)
 *   → 收 READY(t=READY, d.session_id, s) / RESUMED(t=RESUMED) → 启动心跳
 *   → 收 HEARTBEAT_ACK(op11) → 定时心跳
 *   → op0 DISPATCH 事件按 t 分发
 *
 * 稳定性设计（解决频繁掉线）：
 * 1. **Resume 优先**：保留 session_id + lastSeq，重连先发 Resume(op6) 恢复会话，
 *    避免重新 IDENTIFY。好处：①不丢断线期间事件（QQ 服务端补发）②减少 IDENTIFY
 *    次数，降低被限频风险。Resume 失败（4006 无效 session）才清 session 走 Identify。
 * 2. **心跳 watchdog**：连续 N 次心跳没收到 ACK 就主动断开重连，不等 QQ 踢
 *    （踢的延迟更长，期间消息全丢）。
 * 3. **Gateway URL 缓存**：getGateway 有频率限制（100017），缓存首次拿到的 WSS URL，
 *    重连直接复用，不再每次调 getGateway（除非连接被拒才刷新）。
 * 4. **退避基数 3s**：避免「限频→失败→更快重试→更限频」死循环。
 * 5. **关闭码分级**：4009(resumable)→resume；4006/4007/4900-4913→清 session+identify；
 *    fatal 码→停止。
 */
export interface QQWebSocketOptions {
	readonly client: QQClient;
	readonly intents?: number;
	readonly maxRetries?: number;
}

export interface QqIncomingMessage {
	readonly kind: "group" | "c2c";
	readonly scopeId: string;
	readonly messageId: string;
	readonly text: string;
	readonly senderId: string;
	readonly timestamp: string;
	readonly attachments?: MessageAttachment[];
	readonly raw: unknown;
}

export class QQWebSocketReceiver extends EventEmitter {
	private readonly client: QQClient;
	private readonly intents: number;

	private ws: WebSocket | undefined;
	private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
	private heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL_MS;
	private lastSeq: number | null = null;
	/** READY 返回的 session_id，用于 Resume(op6)。null 表示尚未建立会话。 */
	private sessionId: string | null = null;
	/** 缓存的 Gateway WSS URL，避免每次重连都调 getGateway（100017 限频）。 */
	private cachedGatewayUrl: string | null = null;
	/** 连续未收到 HEARTBEAT_ACK 的次数；超过容忍值则主动断连重连。 */
	private missedAcks = 0;
	/** 已处理的 DISPATCH 事件 id 去重窗口（防止重连/抖动重放）。 */
	private readonly seenEventIds = new Set<string>();
	private retries = 0;
	private running = false;
	private manualClose = false;

	constructor(opts: QQWebSocketOptions) {
		super();
		this.client = opts.client;
		this.intents = opts.intents ?? DEFAULT_INTENTS;
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.manualClose = false;
		// 首次连接可能因网络抖动失败（fetch failed），用重连逻辑重试而非直接抛出。
		try {
			await this.connect();
		} catch (error) {
			console.warn("[qq-ws] 首次连接失败，进入重连流程:", (error as Error).message);
			await this.reconnect();
		}
	}

	async stop(): Promise<void> {
		this.running = false;
		this.manualClose = true;
		this.clearHeartbeat();
		// 清理会话状态，下次 start() 从全新 Identify 开始。
		this.sessionId = null;
		this.cachedGatewayUrl = null;
		this.lastSeq = null;
		this.retries = 0;
		if (this.ws) {
			try {
				this.ws.close(1000, "client shutdown");
			} catch {
				/* ignore */
			}
			this.ws = undefined;
		}
	}

	private async connect(): Promise<void> {
		// 优先用缓存的 Gateway URL（避免 getGateway 限频 100017）。
		// 仅在无缓存、或连接被服务端拒绝（URL 可能失效）时才重新获取。
		if (!this.cachedGatewayUrl) {
			try {
				const gateway = await this.client.getGateway();
				this.cachedGatewayUrl = gateway.url;
			} catch (error) {
				// getGateway 失败（限频/网络）不崩溃，抛出由 reconnect 退避重试。
				throw new Error(`connect: getGateway 失败: ${(error as Error).message}`);
			}
		}
		const ws = new WebSocket(this.cachedGatewayUrl);
		this.ws = ws;

		ws.addEventListener("open", () => {
			// 等待 HELLO，在 onMessage 里发 IDENTIFY/RESUME。
		});

		ws.addEventListener("message", (event) => this.onMessage(event));
		ws.addEventListener("close", (event) => this.onClose(event.code, event.reason));
		ws.addEventListener("error", () => {
			// close 事件会跟随，统一在那里处理重连。
		});
	}

	private async onMessage(event: MessageEvent): Promise<void> {
		const payload = this.parse(event.data);
		if (!payload) return;

		try {
			switch (payload.op) {
				case OpCode.HELLO: {
					const d = payload.d as HelloData | undefined;
					this.heartbeatInterval = d?.heartbeat_interval ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
					this.missedAcks = 0;
					// 有 session_id 优先 Resume（恢复会话，不丢断线期间事件）；
					// 否则首次连接或 session 失效后走 Identify。
					if (this.sessionId) {
						await this.resume();
					} else {
						await this.identify();
					}
					break;
				}
				case OpCode.HEARTBEAT_ACK: {
					// 收到 ACK 重置计数并排下一次心跳。
					this.missedAcks = 0;
					this.scheduleHeartbeat();
					break;
				}
				case OpCode.DISPATCH: {
					if (typeof payload.s === "number") this.lastSeq = payload.s;
					// 去重：QQ 在重连/网络抖动时会重放已推送事件（相同 seq 或事件 id），
					// 不去重会导致同一条用户消息被处理多次、回复多条。
					if (this.isDuplicate(payload)) break;
					this.dispatch(payload);
					break;
				}
				case OpCode.RECONNECT: {
					// 服务端要求重连。不断开直接重连会复用 session（走 Resume）。
					await this.forceReconnect();
					break;
				}
				case OpCode.INVALID_SESSION: {
					// session 无效，清掉后重连（重连后走 Identify）。
					this.sessionId = null;
					await this.forceReconnect();
					break;
				}
			}
		} catch (error) {
			// onMessage 里的任何错误（reconnect/identify 失败等）都不应崩溃进程。
			console.error(`[qq-ws] onMessage 处理 op=${payload.op} 时出错:`, (error as Error).message);
		}
	}

	private async identify(): Promise<void> {
		// QQ API v2 群机器人鉴权：用 access_token（由 client 从 bots.qq.com 换取），
		// 格式 `QQBot ${accessToken}`。注意与频道机器人的 `Bot appId.secret` 不同。
		const accessToken = await this.client.getAccessToken();
		const token = `QQBot ${accessToken}`;
		this.send({
			op: OpCode.IDENTIFY,
			d: {
				token,
				intents: this.intents,
				shard: [0, 1],
				properties: { $os: "linux", $browser: "arkham-chatbot", $device: "arkham-chatbot" },
			},
		});
	}

	/**
	 * 发送 Resume(op6) 恢复已有会话。
	 * 用缓存的 session_id + lastSeq，QQ 服务端会补发断线期间漏掉的事件。
	 * 需要有效的 session_id（首次连接后由 READY 获得，4006/INVALID_SESSION 会清掉）。
	 */
	private async resume(): Promise<void> {
		const accessToken = await this.client.getAccessToken();
		const token = `QQBot ${accessToken}`;
		this.send({
			op: OpCode.RESUME,
			d: {
				token,
				session_id: this.sessionId,
				seq: this.lastSeq,
			},
		});
	}

	/**
	 * 判断 DISPATCH 事件是否为重复推送。用事件 id（payload.id 优先，回退 data.id）
	 * 在有限窗口内去重。READY 等无 id 的控制事件不去重。
	 */
	private isDuplicate(payload: WsPayload): boolean {
		const d = payload.d as { id?: string } | undefined;
		const eventId = payload.id ?? d?.id;
		if (eventId === undefined) return false;
		if (this.seenEventIds.has(eventId)) {
			console.log(`[qq-ws] 丢弃重复事件 ${eventId}`);
			return true;
		}
		this.seenEventIds.add(eventId);
		// 窗口上限 200，超出清空重建（简化处理，避免无限增长）。
		if (this.seenEventIds.size > 200) this.seenEventIds.clear();
		return false;
	}

	private dispatch(payload: WsPayload): void {
		if (payload.t === READY_EVENT) {
			const d = payload.d as ReadyData;
			// 缓存 session_id 供后续 Resume 用。
			this.sessionId = d.session_id;
			this.emit("ready", d);
			// READY 后立即发首次心跳（d 为最近 seq 或 null），然后由 ACK 驱动后续心跳。
			this.send({ op: OpCode.HEARTBEAT, d: this.lastSeq });
			this.retries = 0;
			console.log(`[qq-ws] 会话已建立 (identify)，session_id=${this.sessionId?.slice(0, 8)}…`);
			return;
		}
		if (payload.t === RESUMED_EVENT) {
			// Resume 成功：漏掉的事件已补发完毕，重置重试计数。
			this.retries = 0;
			console.log(`[qq-ws] 会话已恢复 (resume)，session_id=${this.sessionId?.slice(0, 8)}…`);
			// RESUMED 后启动心跳（与 READY 后一致）。
			this.send({ op: OpCode.HEARTBEAT, d: this.lastSeq });
			return;
		}
		if (payload.t === GROUP_AT_MESSAGE_CREATE) {
			const data = payload.d as GroupAtMessageData;
			this.emit("message", {
				kind: "group",
				scopeId: data.group_openid,
				messageId: data.id,
				text: stripAtMention(data.content),
				senderId: data.author?.member_openid ?? "unknown",
				timestamp: data.timestamp,
				attachments: data.attachments,
				raw: data,
			} satisfies QqIncomingMessage);
			return;
		}
		if (payload.t === C2C_MESSAGE_CREATE) {
			const data = payload.d as C2cMessageData;
			// 真实结构：user_openid 位于 author 内（非顶层）。
			const userOpenid = data.author?.user_openid ?? "";
			this.emit("message", {
				kind: "c2c",
				scopeId: userOpenid,
				messageId: data.id,
				text: stripAtMention(data.content ?? ""),
				senderId: data.author?.member_openid ?? userOpenid,
				timestamp: data.timestamp ?? "",
				attachments: data.attachments,
				raw: data,
			} satisfies QqIncomingMessage);
			return;
		}
		if (payload.t === INTERACTION_CREATE) {
			const data = payload.d as InteractionData;
			this.emit("interaction", data);
			return;
		}
		// 其它事件忽略。
	}

	/**
	 * 排下一次心跳。发心跳后递增 missedAcks；如果连续多次没收到 ACK，
	 * 认定连接已僵死（QQ 侧 TCP 还活着但事件通道断了），主动断开重连。
	 * ACK 收到时在 onMessage 里 missedAcks 归零。
	 */
	private scheduleHeartbeat(): void {
		this.clearHeartbeat();
		this.heartbeatTimer = setTimeout(() => {
			this.missedAcks++;
			this.send({ op: OpCode.HEARTBEAT, d: this.lastSeq });
			if (this.missedAcks > HEARTBEAT_ACK_TOLERANCE) {
				console.warn(`[qq-ws] 连续 ${this.missedAcks} 次心跳未收到 ACK，连接疑似僵死，主动断开重连`);
				// 用 4009（可 resume）触发重连，优先恢复会话。
				this.forceReconnect().catch((e) => console.error("[qq-ws] 心跳超时重连失败:", (e as Error).message));
			}
		}, this.heartbeatInterval);
	}

	private clearHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearTimeout(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
	}

	private send(payload: WsPayload): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(payload));
		}
	}

	/**
	 * 主动断开当前连接并触发重连（用于 op7 RECONNECT / 心跳超时 / INVALID_SESSION）。
	 * 用 4009（可 resume）关闭码断开，让 onClose 的分级逻辑统一处理重连——
	 * 这样不会重复触发两次 reconnect（onClose 一次 + 这里一次）。
	 * 断开时不清 sessionId（4009 是 resumable），让重连走 Resume 恢复会话。
	 */
	private async forceReconnect(): Promise<void> {
		this.clearHeartbeat();
		if (this.ws) {
			try { this.ws.close(4009, "client force reconnect"); } catch { /* ignore */ }
		}
		// 不 await——onClose 会在 close 事件后异步触发 reconnect。
	}

	private async onClose(code: number, _reason: string): Promise<void> {
		this.clearHeartbeat();
		this.ws = undefined;
		if (this.manualClose || !this.running) return;
		// 分级处理关闭码（参考官方错误码表）。
		if (FATAL_CLOSE_CODES.has(code)) {
			// 4001/4002/4010-4014/4914/4915：不可恢复，停止重连。
			this.emit("fatal", { code, reason: _reason });
			this.running = false;
			return;
		}
		if (!RESUMABLE_CLOSE_CODES.has(code)) {
			// 4006（无效 session）/ 4007（seq 错误）/ 4900-4913（内部错误）等：
			// session 已失效，清掉让重连走 Identify（而非白费 Resume）。
			if (this.sessionId) {
				console.warn(`[qq-ws] 关闭码 ${code} 要求重新 identify，清除 session`);
				this.sessionId = null;
			}
			// 这些码可能意味着 gateway URL 也失效，清缓存强制重新 getGateway。
			this.cachedGatewayUrl = null;
		}
		// 4009（可 resume）：保留 session，重连走 Resume。
		try {
			await this.reconnect();
		} catch (error) {
			console.error(`[qq-ws] onClose reconnect 失败:`, (error as Error).message);
		}
	}

	private async reconnect(): Promise<void> {
		// 无限重连：QQ 服务端会周期性踢连接（4009 session 超时等），属于常态，
		// 官方期望客户端重连恢复（Resume）。退避 3s→6s→12s→...→封顶 60s，
		// 避免退避太短触发 getGateway 限频（100017）死循环。
		while (this.running) {
			const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** this.retries, RECONNECT_MAX_DELAY_MS);
			this.retries++;
			this.emit("reconnecting", { attempt: this.retries, delayMs: delay });
			await new Promise((r) => setTimeout(r, delay));
			if (!this.running) return;
			try {
				await this.connect();
				return; // 连接成功（READY/RESUMED 后会清零 retries）
			} catch (error) {
				// connect 失败（getGateway 限频/网络问题等）不崩溃进程，继续退避重试。
				console.warn(`[qq-ws] 重连失败 (第${this.retries}次): ${(error as Error).message}，${this.running ? "继续退避重试" : "已停止"}`);
				// 如果是 getGateway 限频，下一轮还是用缓存 URL（已是 null 会被重新获取）；
				// 若限频持续，退避会拉长，最终缓解。
			}
		}
	}

	private parse(data: unknown): WsPayload | undefined {
		if (typeof data !== "string") return undefined;
		try {
			return JSON.parse(data) as WsPayload;
		} catch {
			return undefined;
		}
	}
}

/** 剥离消息正文里前导的 @机器人（QQ 群@消息 content 含 `<@xxx>` 前缀）。 */
function stripAtMention(content: string): string {
	if (typeof content !== "string") return "";
	let s = content.trim();
	// QQ 群@消息的 content 通常已是纯文本（@部分被剥离），但仍兜底处理 <@!id> / @机器人 文本。
	s = s.replace(/^<@!?[^>]+>\s*/u, "");
	return s.trim();
}
