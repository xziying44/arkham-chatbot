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

/** 群@机器人消息事件。 */
export const GROUP_AT_MESSAGE_CREATE = "GROUP_AT_MESSAGE_CREATE";
/** C2C 私聊消息事件。 */
export const C2C_MESSAGE_CREATE = "C2C_MESSAGE_CREATE";
/** 互动事件（按钮点击回调）。 */
export const INTERACTION_CREATE = "INTERACTION_CREATE";

/** 默认心跳间隔兜底（毫秒），以 HELLO 返回的 heartbeat_interval 为准。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * 重连退避基数（毫秒）。设为 3s 而非 1s：QQ 的 getGateway 接口有频率限制（100017），
 * 退避太短会在网络抖动时连续触发限频，陷入「限频→失败→更快重试→更限频」的死循环。
 */
export const RECONNECT_BASE_DELAY_MS = 3_000;
/** 最大重连退避（毫秒）。 */
export const RECONNECT_MAX_DELAY_MS = 60_000;
/** 默认最大重连次数。 */
export const DEFAULT_MAX_RETRIES = 10;
/**
 * 心跳 ACK 容忍次数：连续这么多次心跳没收到 ACK 就认定连接已僵死，
 * 主动断开重连（不等 QQ 服务端超时踢，那样更慢）。
 */
export const HEARTBEAT_ACK_TOLERANCE = 2;
/**
 * 保底重置阈值：连续重连失败这么多次后，认定可能是缓存状态出了问题
 * （坏的 session_id / 失效的 gateway URL），强制清空全部状态从头走一次完整登录
 * （getGateway + IDENTIFY）。这是「彻底重连」的保底机制——避免无限退避却一直
 * 用同一份坏状态重试导致永远恢复不了。
 */
export const FULL_RESET_AFTER_FAILURES = 8;

/**
 * 不可恢复的关闭码，收到后停止重连。
 * 来源：官方错误码表 https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/error-trace/websocket.html
 * 4001 无效 opcode / 4002 无效 payload / 4010 无效 shard / 4011 需分片 /
 * 4012 无效 version / 4013 无效 intent / 4014 intent 无权限 / 4914 下架 / 4915 封禁。
 * 注意：4006（无效 session）和 4007（seq 错误）不是 fatal——它们要求重新 identify，
 * 由 onClose 的分级逻辑处理（清 session 后走 identify 重连）。
 */
export const FATAL_CLOSE_CODES = new Set([
	4001, // 无效 opcode
	4002, // 无效 payload
	4010, // SHARDING_INVALID
	4011, // SHARDING_REQUIRED
	4012, // INVALID_VERSION
	4013, // INVALID_INTENTS
	4014, // DISALLOWED_INTENTS
	4914, // 机器人已下架
	4915, // 机器人已封禁
]);

/**
 * 允许 Resume 的关闭码：连接过期/服务端主动踢，session 仍有效，重连后应发 Resume(op6)。
 * 4009 连接过期——官方明确「可以重新发起 resume」。
 */
export const RESUMABLE_CLOSE_CODES = new Set([
	4009, // Session timeout（连接过期），可 resume
]);

/** READY 事件标识。 */
export const READY_EVENT = "READY";
/** RESUMED 事件标识（Resume 成功后服务端推送，表示漏掉的事件已补发完毕）。 */
export const RESUMED_EVENT = "RESUMED";
