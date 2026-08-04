import type { ScopeKey } from "@arkham/chatbot-core";
import type { ImEvent } from "./events.ts";

/**
 * IM 平台中立的适配器接口。每个具体 IM（QQ、Telegram、Discord…）实现一个。
 *
 * 上层（server）的用法：
 *   adapter.subscribe(handler)
 *   await adapter.connect()
 *   // handler 收到 ImEvent → 交给 SessionManager → 调 adapter.sendText 回包
 */
export interface ImAdapter extends AsyncDisposable {
	/** 建立连接、开始鉴权与事件订阅。resolve 后表示已可收发。 */
	connect(): Promise<void>;
	/** 注册入站事件处理器。可在 connect 前注册。 */
	subscribe(handler: (event: ImEvent) => void | Promise<void>): () => void;
	/**
	 * 向某 scope 发送文本消息。
	 * @param replyToMessageId 被引用消息 id（被动回复/引用）
	 */
	sendText(scope: ScopeKey, text: string, replyToMessageId?: string): Promise<void>;
	/** 向某 scope 发送本地图片（filePath 为宿主机本地路径）。 */
	sendImage(scope: ScopeKey, filePath: string, replyToMessageId?: string): Promise<void>;
	/** 主动断开。AsyncDisposable 也走此路径。 */
	disconnect(): Promise<void>;
	/** 连接是否处于活跃状态。 */
	readonly isConnected: boolean;
	/**
	 * 发送带内嵌按钮的消息（可选，不支持按钮的 IM 不实现）。
	 * @param content 消息正文（markdown）
	 * @param keyboard 平台相关的按钮结构（QQ 的 KeyboardPayload）
	 * @param replyToMessageId 被引用消息 id（被动回复）
	 */
	sendKeyboard?(scope: ScopeKey, content: string, keyboard: unknown, replyToMessageId?: string): Promise<void>;
	/**
	 * 应答交互事件（可选）。收到按钮点击回调后须在平台时限内调用，
	 * 否则用户端可能一直 loading。
	 * @param interactionId 交互事件 id
	 * @param code 应答结果（0=成功 等，平台相关）
	 */
	replyInteraction?(interactionId: string, code?: number): Promise<void>;
	/**
	 * 下载消息附件（可选，用户发的图片等）为 Buffer。
	 * @param url 附件下载 URL（事件 attachments[].url）
	 */
	downloadAttachment?(url: string): Promise<Buffer>;
}

/** 适配器配置基类：所有 IM 适配器共享的最小配置项。 */
export interface ImAdapterConfig {
	/** 是否使用沙箱/测试环境。 */
	readonly sandbox?: boolean;
}
