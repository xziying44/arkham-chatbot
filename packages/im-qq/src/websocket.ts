import { EventEmitter } from "node:events";
import type { QQClient } from "./client.ts";
import {
	C2C_MESSAGE_CREATE,
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	DEFAULT_INTENTS,
	DEFAULT_MAX_RETRIES,
	FATAL_CLOSE_CODES,
	GROUP_AT_MESSAGE_CREATE,
	INTERACTION_CREATE,
	OpCode,
	READY_EVENT,
	RECONNECT_BASE_DELAY_MS,
	RECONNECT_MAX_DELAY_MS,
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
 * QQ Gateway WebSocket 接收器。
 *
 * 协议流程：
 *   connect ws → 收 HELLO(op10, d.heartbeat_interval)
 *   → 发 IDENTIFY(op2, token=`Bot ${appId}.${appSecret}`, intents)
 *   → 收 READY(t=READY, d.session_id, s) → 首次心跳(op1, d=s)
 *   → 收 HEARTBEAT_ACK(op11) → 定时心跳
 *   → op0 DISPATCH 事件按 t 分发
 *
 * 重连：收到 op7 RECONNECT / 非致命关闭码 → 指数退避重连（默认最多 10 次）。
 * Resume 暂未实现（首版直接重新 IDENTIFY，会丢失断线期间事件；群消息场景可接受）。
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
	private readonly maxRetries: number;

	private ws: WebSocket | undefined;
	private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
	private heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL_MS;
	private lastSeq: number | null = null;
	/** 已处理的 DISPATCH 事件 id 去重窗口（防止重连/抖动重放）。 */
	private readonly seenEventIds = new Set<string>();
	private retries = 0;
	private running = false;
	private manualClose = false;

	constructor(opts: QQWebSocketOptions) {
		super();
		this.client = opts.client;
		this.intents = opts.intents ?? DEFAULT_INTENTS;
		this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
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
		const gateway = await this.client.getGateway();
		const ws = new WebSocket(gateway.url);
		this.ws = ws;

		ws.addEventListener("open", () => {
			// 等待 HELLO。
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

		switch (payload.op) {
			case OpCode.HELLO: {
				const d = payload.d as HelloData | undefined;
				this.heartbeatInterval = d?.heartbeat_interval ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
				await this.identify();
				break;
			}
			case OpCode.HEARTBEAT_ACK: {
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
				await this.reconnect();
				break;
			}
			case OpCode.INVALID_SESSION: {
				// 重新 IDENTIFY。
				await this.reconnect();
				break;
			}
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
			this.emit("ready", d);
			// READY 后立即发首次心跳（d 为最近 seq 或 null）。
			this.send({ op: OpCode.HEARTBEAT, d: this.lastSeq });
			this.retries = 0;
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

	private scheduleHeartbeat(): void {
		this.clearHeartbeat();
		this.heartbeatTimer = setTimeout(() => {
			this.send({ op: OpCode.HEARTBEAT, d: this.lastSeq });
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

	private async onClose(code: number, _reason: string): Promise<void> {
		this.clearHeartbeat();
		this.ws = undefined;
		if (this.manualClose || !this.running) return;
		if (FATAL_CLOSE_CODES.has(code)) {
			this.emit("fatal", { code, reason: _reason });
			this.running = false;
			return;
		}
		await this.reconnect();
	}

	private async reconnect(): Promise<void> {
		if (this.retries >= this.maxRetries) {
			this.emit("fatal", { code: -1, reason: `exceeded ${this.maxRetries} retries` });
			this.running = false;
			return;
		}
		const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** this.retries, RECONNECT_MAX_DELAY_MS);
		this.retries++;
		this.emit("reconnecting", { attempt: this.retries, delayMs: delay });
		await new Promise((r) => setTimeout(r, delay));
		if (!this.running) return;
		await this.connect();
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
