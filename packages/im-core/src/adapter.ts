import type { ScopeKey } from "@arkham/chatbot-core";
import type { ImEvent } from "./events.ts";

/**
 * 发送结果：标记是否发生降级（如 markdown→纯文本）及原因。
 *
 * 沿 sendText → onSendMessage → send_message 工具链透传，让 agent 感知
 * "这条消息格式没渲染成功"，从而在下一轮调整排版（避免代码块/表格）。
 * 无降级时返回 `{}` 或 undefined（两者等价）。
 */
export interface SendOutcome {
	/** 是否发生了降级（markdown 被拒/预校验命中不支持语法 → 转纯文本等）。 */
	degraded?: boolean;
	/** 降级原因（给 agent 的可读提示）。 */
	degradeReason?: string;
}

/**
 * 平台中立的流式输出通道：把文本增量逐片送达用户（ChatGPT 式打字机/思考可见）。
 *
 * 调用方（router）负责节流与累积；本接口只管「把一段 delta 发出去」和「定稿收尾」。
 * 实现负责隐藏平台特定的状态机（如 QQ 的 stream_msg_id / index / input_state）。
 *
 * 不可用或中途失败时，调用方应降级到 {@link ImAdapter.sendText} 批量发送。
 */
export interface StreamSink {
	/**
	 * 追加一段增量文本（调用方已节流）。
	 * 实现内部失败应自吞并标记结束，避免拖垮调用方。
	 */
	onDelta(delta: string): Promise<void>;
	/**
	 * 定稿收尾（平台的「结束」信号）。必须调用，否则用户端可能停在最后一帧。
	 * 幂等：多次调用应只发一次结束信号。
	 */
	finish(): Promise<void>;
	/**
	 * 维持「正在输入」指示（可选）。用于 agent 处理中无文字产出的间隙，
	 * 定期刷新平台的 typing 状态，避免用户以为卡住。不支持的实现可不提供。
	 */
	keepAlive?(): Promise<void>;
}

/** {@link ImAdapter.openStream} 的入参。 */
export interface OpenStreamOptions {
	/** 被动回复关联的用户消息 ID。 */
	msgId?: string;
	/** 内容类型，默认 markdown。 */
	contentType?: "text" | "markdown";
	/** 首片正文（如 "> 💭 "）。空字符串表示首片不展示内容，续片再追加。 */
	firstContent?: string;
}

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
	 * @returns 发送结果（是否降级及原因）；无降级时字段为 undefined
	 */
	sendText(scope: ScopeKey, text: string, replyToMessageId?: string): Promise<SendOutcome>;
	/** 向某 scope 发送本地图片（filePath 为宿主机本地路径）。 */
	sendImage(scope: ScopeKey, filePath: string, replyToMessageId?: string): Promise<void>;
	/**
	 * 向某 scope 发送本地文件（filePath 为宿主机本地路径）。
	 * 用于把 agent 产出的文件（如 .card 卡牌源文件）发给用户编辑。
	 * 实现负责按文件大小选单次/分片上传。
	 */
	sendFile(scope: ScopeKey, filePath: string, replyToMessageId?: string): Promise<void>;
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
	sendKeyboard?(scope: ScopeKey, content: string, keyboard: unknown, replyToMessageId?: string): Promise<SendOutcome>;
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
	/**
	 * 开启一条流式输出通道（可选）。仅 C2C 等支持流式的场景实现。
	 *
	 * 群聊或不支持流式的 IM 应返回 undefined（调用方降级到 sendText 批量发送）。
	 * 开启失败（网络/限流）也应返回 undefined，让调用方降级。
	 *
	 * @param scope 目标 scope（实现自行判断是否支持）
	 * @param opts 首片参数
	 * @returns StreamSink；不支持或失败时 undefined
	 */
	openStream?(scope: ScopeKey, opts: OpenStreamOptions): Promise<StreamSink | undefined>;
}

/** 适配器配置基类：所有 IM 适配器共享的最小配置项。 */
export interface ImAdapterConfig {
	/** 是否使用沙箱/测试环境。 */
	readonly sandbox?: boolean;
}
