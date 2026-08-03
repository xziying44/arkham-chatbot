import { groupScope, userScope } from "@arkham/chatbot-core";
import type { ImAdapter } from "@arkham/chatbot-im-core";
import type { ImEvent } from "@arkham/chatbot-im-core";
import { QQClient, groupTarget, userTarget, type ScopeTarget } from "./client.ts";
import { QQWebSocketReceiver, type QqIncomingMessage } from "./websocket.ts";

/**
 * QQ 官方 API v2 适配器，实现平台中立的 {@link ImAdapter}。
 *
 * 把 QQ 的 GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE 事件归一成 {@link ImEvent}，
 * 把 {@link sendText} 映射到 /v2/groups/{group_openid}/messages 或 /v2/users/{openid}/messages。
 */
export interface QQAdapterOptions {
	readonly appId: string;
	readonly appSecret: string;
	/** 正式: https://api.sgroup.qq.com  沙箱: https://sandbox.api.sgroup.qq.com */
	readonly apiBase: string;
	/** 连接模式（v2 默认 WebSocket）。 */
	readonly intents?: number;
}

/** 连接状态机阶段（管理端展示用）。 */
export type QQConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "fatal";

export class QQAdapter implements ImAdapter {
	private readonly client: QQClient;
	private readonly receiver: QQWebSocketReceiver;
	private readonly handlers = new Set<(event: ImEvent) => void | Promise<void>>();
	private connected = false;
	private receiverReady = false;
	/** 最近一次 receiver 上报的阶段（连接中/重连中/致命）。 */
	private phase: QQConnectionState = "disconnected";

	constructor(opts: QQAdapterOptions) {
		this.client = new QQClient({
			appId: opts.appId,
			appSecret: opts.appSecret,
			apiBase: opts.apiBase,
		});
		this.receiver = new QQWebSocketReceiver({
			client: this.client,
			intents: opts.intents,
		});
		this.receiver.on("message", (msg: QqIncomingMessage) => this.onIncoming(msg));
		// 把 receiver 的生命周期事件映射到 phase，供管理端展示。
		this.receiver.on("reconnecting", () => {
			this.phase = "reconnecting";
		});
		this.receiver.on("fatal", () => {
			this.phase = "fatal";
		});
	}

	get isConnected(): boolean {
		return this.connected && this.receiverReady;
	}

	/** AppID（管理端展示用）。 */
	get appId(): string {
		return this.client.appId;
	}

	/** 当前连接阶段（比 isConnected 更细粒度）。 */
	get connectionState(): QQConnectionState {
		if (this.phase === "fatal") return "fatal";
		if (this.isConnected) return "connected";
		if (this.phase === "reconnecting") return "reconnecting";
		if (this.connected) return "connecting"; // connect() 已调用但 READY 未到
		return "disconnected";
	}

	async connect(): Promise<void> {
		// 启动 WebSocket；READY 事件后视为连通。
		const ready = new Promise<void>((resolve, reject) => {
			const onReady = () => {
				this.receiverReady = true;
				this.phase = "connected";
				resolve();
			};
			const onFatal = (info: { reason: string }) => {
				this.phase = "fatal";
				this.receiver.off("ready", onReady);
				reject(new Error(`QQ adapter fatal: ${info.reason}`));
			};
			this.receiver.once("ready", onReady);
			this.receiver.once("fatal", onFatal);
		});
		this.phase = "connecting";
		await this.receiver.start();
		this.connected = true;
		await ready;
	}

	subscribe(handler: (event: ImEvent) => void | Promise<void>): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	async sendText(scope: { kind: "group" | "user"; id: string }, text: string, replyToMessageId?: string, mentionUserOpenid?: string): Promise<void> {
		const target = this.toTarget(scope);
		// 群消息且指定了 @ 对象时，在内容前插入官方 @ 标签（<qqbot-at-user id="openid" />）。
		// 该标签在文本(msg_type=0)和 markdown(msg_type=2)消息里都生效。
		const content = this.withMention(text, scope.kind, mentionUserOpenid);
		// 优先发 Markdown（msg_type=2），失败则降级为纯文本（msg_type=0）。
		try {
			await this.client.sendMarkdown(target, content, replyToMessageId);
		} catch (mdError) {
			console.warn("[qq-adapter] markdown 发送失败，降级纯文本:", (mdError as Error).message);
			await this.client.sendText(target, content, replyToMessageId);
		}
	}

	async sendImage(scope: { kind: "group" | "user"; id: string }, filePath: string, replyToMessageId?: string, mentionUserOpenid?: string): Promise<void> {
		const target = this.toTarget(scope);
		const { readFile } = await import("node:fs/promises");
		const buffer = await readFile(filePath);
		const base64 = buffer.toString("base64");
		await this.client.sendImageBase64(target, base64, replyToMessageId);
		// 群消息发图后，若需 @ 人，补一条带 @ 标签的文本（图片消息本身不支持 @ 标签）。
		if (scope.kind === "group" && mentionUserOpenid) {
			// 不补额外文本，避免刷屏；@ 依赖引用关系体现。
		}
	}

	/** 群消息时在文本前插入 @ 标签；私聊不插。 */
	private withMention(text: string, scopeKind: "group" | "user", mentionUserOpenid?: string): string {
		if (scopeKind !== "group" || !mentionUserOpenid) return text;
		return `<qqbot-at-user id="${mentionUserOpenid}" />${text}`;
	}

	private toTarget(scope: { kind: "group" | "user"; id: string }): ScopeTarget {
		return scope.kind === "group" ? groupTarget(scope.id) : userTarget(scope.id);
	}

	async disconnect(): Promise<void> {
		this.connected = false;
		this.receiverReady = false;
		this.phase = "disconnected";
		await this.receiver.stop();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.disconnect();
	}

	private async onIncoming(msg: QqIncomingMessage): Promise<void> {
		console.log(`[qq-adapter] 收到 ${msg.kind} 消息 id=${msg.messageId} text=${msg.text.slice(0, 30)}`);
		const event: ImEvent = {
			type: "message",
			scope: msg.kind === "group" ? groupScope(msg.scopeId) : userScope(msg.scopeId),
			text: msg.text,
			senderId: msg.senderId,
			senderName: msg.senderId, // QQ 仅给 openid，无展示名；用 id 兜底
			mentioned: msg.kind === "group", // 群消息恒为 @机器人 触发
			platformMessageId: msg.messageId,
			raw: msg.raw,
		};
		for (const handler of this.handlers) {
			try {
				await handler(event);
			} catch {
				// 单个处理器失败不影响其它。
			}
		}
	}
}
