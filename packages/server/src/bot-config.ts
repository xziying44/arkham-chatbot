/**
 * 机器人配置与运行时信息类型（在 BotManager、admin-api 之间共享）。
 *
 * 与 store 包的 BotRecord 不同：BotConfig 是「驱动一个机器人需要什么」的聚合视图，
 * BotRecord 是纯 DB 行。BotManager 用 BotConfig 启动实例。
 */

/** 驱动一个 QQ 机器人所需的全部配置。 */
export interface BotConfig {
	readonly id: string;
	readonly appId: string;
	readonly appSecret: string;
	readonly name: string;
	readonly apiBase: string;
	readonly persona: string | null;
	readonly enabled: boolean;
}

/** 管理端展示用的机器人运行时信息。 */
export interface BotRuntimeInfo {
	readonly id: string;
	readonly appId: string;
	readonly name: string;
	readonly apiBase: string;
	readonly persona: string | null;
	readonly enabled: boolean;
	/** 是否在内存中已构建实例（disabled 的 bot 不构建）。 */
	readonly loaded: boolean;
	/** QQ 连接阶段。 */
	readonly connectionState: string;
	/** 等价于 connectionState === "connected"。 */
	readonly connected: boolean;
	/** 当前活跃会话数。 */
	readonly activeScopeCount: number;
}
