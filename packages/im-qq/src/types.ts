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
	/** 附件列表（图片/视频/文件）。用户发图片时在此字段。 */
	attachments?: MessageAttachment[];
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
	/** 附件列表（图片/视频/文件）。 */
	attachments?: MessageAttachment[];
}

/**
 * 消息附件（图片/视频/文件）。
 * 用户在群里发图片时，QQ 推送的事件 attachments 字段含此结构。
 * url 是临时下载链接，需尽快下载（有效期有限）。
 */
export interface MessageAttachment {
	/** MIME 类型，如 "image/jpeg" | "image/png" | "image/gif"。 */
	content_type: string;
	/** 文件名。 */
	filename: string;
	/** 附件下载 URL（临时链接）。 */
	url: string;
	/** 图片宽度（像素，非图片附件无此字段）。 */
	width?: number;
	/** 图片高度（像素）。 */
	height?: number;
	/** 文件大小（字节）。 */
	size?: number;
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
	/** 有效期（秒）。QQ 线上接口实际可能返回数字字符串。 */
	expires_in: number | string;
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

/** upload_prepare 返回的单个分片预签名信息。 */
export interface UploadPart {
	/** 分片序号（从 0 开始）。 */
	index: number;
	/** 直传腾讯云 COS 的预签名 URL，PUT 时不带 Authorization。 */
	presigned_url: string;
	/** 该分片的字节大小（字符串）。 */
	block_size: string;
}

/** upload_prepare 返回体。 */
export interface UploadPrepareResult {
	/** 本次分片上传会话 id，后续 upload_part_finish 和合并都要带。 */
	upload_id: string;
	/** 服务端指定的分片大小（字符串），按这个切，别写死 5MB。 */
	block_size: string;
	/** 各分片的预签名信息。 */
	parts: UploadPart[];
	/** 上传配置（并发数、重试超时、重试间隔）。 */
	upload_config?: {
		concurrency?: number;
		retry_timeout?: number;
		retry_delay?: number;
	};
}

/** QQ openapi 消息类型。0=文本，2=markdown，7=富媒体。 */
export const MSG_TYPE = {
	TEXT: 0,
	MARKDOWN: 2,
	RICH_MEDIA: 7,
} as const;

/**
 * INTERACTION_CREATE 事件体（用户点击消息按钮回调）。
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/interaction_create.html
 */
export interface InteractionData {
	/** 事件 id（即 interaction_id，用于 PUT /interactions/{id} 应答）。 */
	id: string;
	/** 互动类型。11=消息按钮回调（INLINE_KEYBOARD）。 */
	type: number;
	/** 事件场景："c2c" | "group" | "guild"。 */
	scene: string;
	/** 聊天场景。0=频道 1=群聊 2=单聊。 */
	chat_type: number;
	/** 群 openid（仅群聊场景）。 */
	group_openid?: string;
	/** 群成员 openid（仅群聊场景，点击按钮的用户）。 */
	group_member_openid?: string;
	/** 用户 openid（仅单聊场景）。 */
	user_openid?: string;
	/** 触发时间（RFC3339）。 */
	timestamp: string;
	/** 互动数据。 */
	data: {
		/** 互动数据类型，含义与外层 type 一致。 */
		type: number;
		/** 解析后的互动数据。 */
		resolved: {
			/** 按钮的 id（发送时设的 button.id）。 */
			button_id?: string;
			/** 按钮的回调数据（发送时设的 action.data）。 */
			button_data?: string;
			/** 操作用户 id（仅频道场景）。 */
			user_id?: string;
		};
	};
	version: number;
	application_id: string;
}

/**
 * keyboard 按钮定义（QQ 消息内嵌键盘的单个按钮）。
 * @see https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/msg-btn.html
 */
export interface KeyboardButton {
	/** 按钮唯一标识。 */
	id: string;
	/** 视觉表现。 */
	render_data: {
		/** 按钮显示文本。 */
		label: string;
		/** 点击后显示的文本。 */
		visited_label?: string;
		/** 样式：0=灰色线框，1=蓝色线框。 */
		style?: 0 | 1;
	};
	/** 点击行为。 */
	action: {
		/** 0=跳转 1=回调 2=指令。 */
		type: 0 | 1 | 2;
		/** 权限：0=指定用户 1=管理者 2=所有人 3=指定身份组。 */
		permission: {
			type: 0 | 1 | 2 | 3;
			/** type=0 时指定的用户 openid 列表。 */
			specify_user_ids?: string[];
		};
		/** 回调数据（type=1 时回调给后台；type=2 时插入输入框）。 */
		data: string;
		/** 客户端不支持时的提示。 */
		unsupport_tips?: string;
		/** type=2 指令按钮：点击后是否自动发送（默认 false 仅填入输入框）。 */
		enter?: boolean;
	};
}

/** keyboard 完整结构（内嵌在消息 payload 的 keyboard 字段）。 */
export interface KeyboardPayload {
	content: {
		rows: { buttons: KeyboardButton[] }[];
	};
}

/**
 * stream_messages 接口请求体（C2C 流式消息分片）。
 * @see https://bot.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html
 */
export interface StreamMessagePayload {
	content_type?: "text" | "markdown";
	content_raw?: string;
	/** 1=生成中，10=生成结束。末片必须为 10。 */
	input_state?: 1 | 10;
	/** append=拼接到已下发内容（默认）；replace=全量正文（受前缀锁定约束）。 */
	input_mode?: "append" | "replace";
	/** 分片序号，从 0 递增。 */
	index?: number;
	/** 流式消息 ID。首片不传（服务端生成），续片/末片必须携带。 */
	stream_msg_id?: string;
	/** 被动回复关联的用户消息 ID（与 event_id 二选一）。 */
	msg_id?: string;
	/** 被动回复事件 ID（与 msg_id 二选一）。 */
	event_id?: string;
	/** 消息序号，用于去重。 */
	msg_seq?: number;
	/** true 时为召回消息，不校验 msg_id/event_id 有效期（消耗主动消息配额）。 */
	is_wakeup?: boolean;
}

/** stream_messages 响应。 */
export interface StreamMessageResult {
	/** 流式消息 ID（首片后用于串联续片/末片）。 */
	id: string;
	timestamp: string;
	ext_info?: { ref_idx?: string };
	/** 流式消息剩余可用长度（字符数）。 */
	remain_msg_len?: number;
}
