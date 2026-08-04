/**
 * QQ 机器人 WebSocket Gateway 协议常量。
 * 来源：QQ 官方 API v2 / 官方 bot-node-sdk / 社区 SDK（zhinjs/qq-official-bot）。
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/
 */
export enum OpCode {
	/** 服务端主动推送事件。 */
	DISPATCH = 0,
	/** 客户端发送心跳。 */
	HEARTBEAT = 1,
	/** 客户端发送鉴权（Identify）。 */
	IDENTIFY = 2,
	/** 客户端恢复连接（Resume）。 */
	RESUME = 6,
	/** 服务端通知客户端重连。 */
	RECONNECT = 7,
	/** 鉴权或 resume 参数错误。 */
	INVALID_SESSION = 9,
	/** 连接建立后网关下发的第一条消息（含心跳间隔）。 */
	HELLO = 10,
	/** 心跳成功回执。 */
	HEARTBEAT_ACK = 11,
}

/**
 * 订阅意图位。群聊/私聊（GROUP_AND_C2C_EVENT）为 1 << 25。
 */
export enum Intent {
	GUILDS = 1 << 0,
	GUILD_MEMBERS = 1 << 1,
	GUILD_MESSAGES = 1 << 9,
	GUILD_MESSAGE_REACTIONS = 1 << 10,
	DIRECT_MESSAGE = 1 << 12,
	GROUP_MEMBER = 1 << 24,
	/** 群聊与私聊消息事件（GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE）。 */
	GROUP_AND_C2C_EVENT = 1 << 25,
	INTERACTION = 1 << 26,
	MESSAGE_AUDIT = 1 << 27,
	FORUMS_EVENT = 1 << 28,
	AUDIO_ACTION = 1 << 29,
	PUBLIC_GUILD_MESSAGES = 1 << 30,
}

/** 默认订阅：群聊/私聊消息 + 群成员变更 + 互动事件（按钮回调）。 */
export const DEFAULT_INTENTS = Intent.GROUP_AND_C2C_EVENT | Intent.GROUP_MEMBER | Intent.INTERACTION;

/** READY 事件标识。 */
export const READY_EVENT = "READY";
/** 群@机器人消息事件。 */
export const GROUP_AT_MESSAGE_CREATE = "GROUP_AT_MESSAGE_CREATE";
/** C2C 私聊消息事件。 */
export const C2C_MESSAGE_CREATE = "C2C_MESSAGE_CREATE";
/** 互动事件（按钮点击回调）。 */
export const INTERACTION_CREATE = "INTERACTION_CREATE";

/** 默认心跳间隔兜底（毫秒），以 HELLO 返回的 heartbeat_interval 为准。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
/** 重连退避基数（毫秒）。 */
export const RECONNECT_BASE_DELAY_MS = 1_000;
/** 最大重连退避（毫秒）。 */
export const RECONNECT_MAX_DELAY_MS = 30_000;
/** 默认最大重连次数。 */
export const DEFAULT_MAX_RETRIES = 10;

/**
 * 不可恢复的关闭码，收到后停止重连。
 * @see WebsocketCloseReason
 */
export const FATAL_CLOSE_CODES = new Set([
	4004, // TOKEN_INVALID
	4010, // SHARDING_INVALID
	4011, // SHARDING_REQUIRED
	4012, // INVALID_VERSION
	4013, // INVALID_INTENTS
	4014, // DISALLOWED_INTENTS
	4914, // 机器人已下架
	4915, // 机器人已封禁
]);
