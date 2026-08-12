import { groupScope, userScope } from "@arkham/chatbot-core";
import type { ImAdapter } from "@arkham/chatbot-im-core";
import type { ImEvent } from "@arkham/chatbot-im-core";
import { QQClient, groupTarget, userTarget, type ScopeTarget } from "./client.ts";
import { QQWebSocketReceiver, type QqIncomingMessage } from "./websocket.ts";
import type { InteractionData, KeyboardPayload } from "./types.ts";

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
		this.receiver.on("interaction", (data: InteractionData) => this.onInteraction(data));
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

	async sendText(scope: { kind: "group" | "user"; id: string }, text: string, replyToMessageId?: string): Promise<void> {
		const target = this.toTarget(scope);
		// agent 自行决定是否在文本里写 <qqbot-at-user id="openid" /> 标签来 @ 人。
		// adapter 不再自动拼接 @ ——由 agent 根据语境判断（显性对某人说才 @，闲聊不 @）。
		// 优先发 Markdown（msg_type=2），失败则降级为纯文本（msg_type=0）。
		// 若因 msg_id 过期（11244）失败，去掉 msg_id 重试（发主动消息）。
		try {
			await this.client.sendMarkdown(target, text, replyToMessageId);
		} catch (mdError) {
			const mdMsg = (mdError as Error).message;
			console.warn("[qq-adapter] markdown 发送失败，降级纯文本:", mdMsg);
			// msg_id 过期 → 不带 msg_id 重试
			const expired = mdMsg.includes("11244") || mdMsg.includes("token not exist");
			const retryMsgId = expired ? undefined : replyToMessageId;
			try {
				await this.client.sendText(target, text, retryMsgId);
			} catch (textError) {
				const textMsg = (textError as Error).message;
				if (textMsg.includes("11244") || textMsg.includes("token not exist")) {
					// 纯文本也因 msg_id 过期失败 → 最后一次尝试：不带 msg_id
					console.warn("[qq-adapter] msg_id 过期，尝试主动消息（不带 msg_id）");
					await this.client.sendText(target, text, undefined);
				} else {
					throw textError;
				}
			}
		}
	}

	async sendImage(scope: { kind: "group" | "user"; id: string }, filePath: string, replyToMessageId?: string): Promise<void> {
		const target = this.toTarget(scope);
		const { readFile } = await import("node:fs/promises");
		const buffer = await readFile(filePath);
		const base64 = buffer.toString("base64");
		await this.client.sendImageBase64(target, base64, replyToMessageId);
	}

	/**
	 * 发送本地文件（file_type=4）。
	 *
	 * 按文件大小自动选择上传方式：
	 * - < 5MB：单次 base64 上传（sendFileBase64）
	 * - 5MB–50MB：四步分片上传（uploadFileChunked）
	 * - > 50MB：拒绝（QQ 文件软限制 200MB，这里更保守设 50MB）
	 *
	 * 上传拿到 file_info 后用 sendMedia（msg_type=7）发消息引用。
	 */
	async sendFile(scope: { kind: "group" | "user"; id: string }, filePath: string, replyToMessageId?: string): Promise<void> {
		const target = this.toTarget(scope);
		const { readFile } = await import("node:fs/promises");
		const { basename } = await import("node:path");
		const buffer = await readFile(filePath);
		const fileName = basename(filePath);
		const sizeMb = buffer.length / (1024 * 1024);
		if (sizeMb > 50) {
			throw new Error(`文件过大（${sizeMb.toFixed(1)}MB），上限 50MB`);
		}
		if (buffer.length >= 5 * 1024 * 1024) {
			// 大文件分片上传
			const fileInfo = await this.client.uploadFileChunked(target, buffer, fileName);
			await this.client.sendMedia(target, fileInfo, replyToMessageId);
		} else {
			await this.client.sendFileBase64(target, buffer.toString("base64"), fileName, replyToMessageId);
		}
	}

	/**
	 * 发送带按钮的消息（markdown 正文 + 内嵌 keyboard）。
	 * 失败时降级为纯文本（不含按钮）。
	 */
	async sendKeyboard(scope: { kind: "group" | "user"; id: string }, content: string, keyboard: KeyboardPayload, replyToMessageId?: string): Promise<void> {
		const target = this.toTarget(scope);
		try {
			await this.client.sendKeyboard(target, content, keyboard, replyToMessageId);
		} catch (kbError) {
			const err = kbError as Error;
			console.warn(`[qq-adapter] keyboard 发送失败 scope=${scope.kind}:${scope.id} name=${err.name} msg=${err.message} cause=${err.cause ?? "无"}`);
			// 群消息 msg_id 过期（11244）→ 去掉 msg_id 重试（发主动消息）
			if (err.message.includes("11244") || err.message.includes("token not exist")) {
				try {
					await this.client.sendKeyboard(target, content, keyboard, undefined);
					return;
				} catch (retryErr) {
					console.warn("[qq-adapter] keyboard 去 msg_id 重试也失败:", (retryErr as Error).message);
				}
			}
			// 降级为纯文本（把选项列出来，至少文字能到）
			const fallback = content + "\n（按钮不可用）";
			try {
				await this.client.sendMarkdown(target, fallback, replyToMessageId);
			} catch {
				await this.client.sendText(target, fallback, replyToMessageId);
			}
		}
	}

	/**
	 * 应答交互事件（按钮点击后 3 秒内必须调用，否则用户端一直转圈）。
	 */
	async replyInteraction(interactionId: string, code?: 0 | 1 | 2 | 3 | 4 | 5): Promise<void> {
		await this.client.replyInteraction(interactionId, code ?? 0);
	}

	/**
	 * 下载消息附件（用户发的图片等）为 Buffer。
	 */
	async downloadAttachment(url: string): Promise<Buffer> {
		return this.client.downloadAttachment(url);
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
		console.log(`[qq-adapter] 收到 ${msg.kind} 消息 id=${msg.messageId} text=${msg.text.slice(0, 30)}${msg.attachments?.length ? ` attachments=${msg.attachments.length}` : ""}`);
		const event: ImEvent = {
			type: "message",
			scope: msg.kind === "group" ? groupScope(msg.scopeId) : userScope(msg.scopeId),
			text: msg.text,
			senderId: msg.senderId,
			senderName: msg.senderId, // QQ 仅给 openid，无展示名；用 id 兜底
			mentioned: msg.kind === "group", // 群消息恒为 @机器人 触发
			platformMessageId: msg.messageId,
			attachments: msg.attachments?.map((a) => ({
				url: a.url,
				filename: a.filename,
				contentType: a.content_type,
				width: a.width,
				height: a.height,
			})),
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

	/**
	 * 收到按钮点击回调（INTERACTION_CREATE），归一成 ImInteractionEvent 分发。
	 */
	private async onInteraction(data: InteractionData): Promise<void> {
		console.log(`[qq-adapter] 收到按钮回调 id=${data.id} button_data=${data.data?.resolved?.button_data ?? "?"}`);
		// 推导 scope：群聊用 group_openid，单聊用 user_openid。
		const scope = data.scene === "group" || data.chat_type === 1
			? groupScope(data.group_openid ?? "")
			: userScope(data.user_openid ?? "");
		const event: ImEvent = {
			type: "interaction",
			scope,
			// 点击按钮的用户 openid：群聊用 group_member_openid，单聊用 user_openid。
			// 上层据此路由到对应成员会话，resolve 其挂起的 ask_user。
			senderId: data.group_member_openid ?? data.user_openid ?? "",
			interactionId: data.id,
			buttonData: data.data?.resolved?.button_data,
			buttonId: data.data?.resolved?.button_id,
			raw: data,
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
