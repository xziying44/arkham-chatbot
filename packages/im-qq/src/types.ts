/** QQ Gateway WebSocket 收发的原始消息结构。 */
export interface WsPayload<T = unknown> {
	/** opcode，见 {@link OpCode}。 */
	op: number;
	/** 事件数据（op=0 时为事件体，op=10 时含 heartbeat_interval）。 */
	d?: T;
	/** 心跳唯一标识 / 事件序列号。 */
	s?: number;
	/** 事件类型（op=0 时有值，如 GROUP_AT_MESSAGE_CREATE）。 */
	t?: string;
	/** 事件 ID。 */
	id?: string;
}

/** HELLO 事件体。 */
export interface HelloData {
	heartbeat_interval: number;
}

/** READY 事件体。 */
export interface ReadyData {
	session_id: string;
	user: {
		id: string;
		username: string;
		bot: boolean;
	};
	shard?: [number, number];
	version: number;
}

/** 群@消息事件体（GROUP_AT_MESSAGE_CREATE）。 */
export interface GroupAtMessageData {
	/** 消息 ID（用于被动回复 msg_id）。 */
	id: string;
	/** 群 openid（scope id）。 */
	group_openid: string;
	/** 消息文本（含前导 @机器人，需剥离）。 */
	content: string;
	/** 作者信息。 */
	author: {
		/** 群成员 openid。 */
		member_openid: string;
		union_openid?: string;
	};
	/** 时间戳（秒，字符串）。 */
	timestamp: string;
}

/** C2C 私聊消息事件体（C2C_MESSAGE_CREATE）。字段路径以真实推送为准。 */
export interface C2cMessageData {
	/** 消息 ID（用于被动回复 msg_id）。 */
	id: string;
	content: string;
	/** 作者信息：user_openid 即私聊 scope id，位于 author 内（非顶层）。 */
	author: {
		user_openid: string;
		union_openid?: string;
		/** 部分场景下的成员 openid。 */
		member_openid?: string;
		id?: string;
		username?: string;
		bot?: boolean;
	};
	timestamp: string;
	message_type?: number;
}

/** 获取 gateway WebSocket 地址的响应。 */
export interface WsGatewayInfo {
	url: string;
	shards: number;
	session_start_limit: {
		total: number;
		remaining: number;
		reset_after: number;
		max_concurrency: number;
	};
}

/** getAppAccessToken 响应。 */
export interface AccessTokenResponse {
	access_token: string;
	/** 过期时间戳（秒）。 */
	expires_in: number;
}

/** 发消息响应（普通）。 */
export interface SendMessageResult {
	id: string;
	timestamp: number;
}

/** 发消息响应（命中审核）。 */
export interface MessageAuditResult {
	message_audit: {
		audit_id: string;
		audit_time: number;
		create_time: number;
	};
}

/** 富媒体文件类型。1=图片，2=视频，3=语音，4=文件。 */
export type FileType = 1 | 2 | 3 | 4;

/** 上传富媒体文件后返回的 file_info（字符串）。 */
export interface FileUploadResult {
	file_info: string;
	ttl: number;
}

/** QQ openapi 消息类型。0=文本，2=markdown，7=富媒体。 */
export const MSG_TYPE = {
	TEXT: 0,
	MARKDOWN: 2,
	RICH_MEDIA: 7,
} as const;

