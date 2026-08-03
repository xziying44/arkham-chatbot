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
	 * @param mentionUserOpenid 群消息里要 @ 的用户 openid（通常是被回复消息的发送者）
	 */
	sendText(scope: ScopeKey, text: string, replyToMessageId?: string, mentionUserOpenid?: string): Promise<void>;
	/** 向某 scope 发送本地图片（filePath 为宿主机本地路径）。 */
	sendImage(scope: ScopeKey, filePath: string, replyToMessageId?: string, mentionUserOpenid?: string): Promise<void>;
	/** 主动断开。AsyncDisposable 也走此路径。 */
	disconnect(): Promise<void>;
	/** 连接是否处于活跃状态。 */
	readonly isConnected: boolean;
}

/** 适配器配置基类：所有 IM 适配器共享的最小配置项。 */
export interface ImAdapterConfig {
	/** 是否使用沙箱/测试环境。 */
	readonly sandbox?: boolean;
}
