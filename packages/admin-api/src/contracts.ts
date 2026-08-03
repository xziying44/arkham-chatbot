import type { LogEntry } from "@arkham/chatbot-core";

/**
 * admin-api 对「机器人编排器」的结构化契约。
 * server 包的 BotManager 实现这些方法即可，admin-api 不反向依赖 server（避免环依赖）。
 */
export interface BotManagerLike {
	list(): BotRuntimeInfo[];
	get(id: string): { sessions: SessionManagerLike } | undefined;
	addBot(config: BotConfigInput): Promise<void>;
	reconfigureBot(id: string, config: BotConfigInput): Promise<void>;
	disable(id: string): Promise<void>;
	enable(id: string, config: BotConfigInput): Promise<void>;
	removeBot(id: string, deleteData: boolean): Promise<void>;
	reapAllSessions(): Promise<number>;
	/** 取某 bot 某 scope 在磁盘上的数据目录（审计记忆/历史用）。 */
	getScopeDir(botId: string, kind: "group" | "user", scopeId: string): string | undefined;
}

/** admin-api 需要的会话池能力（SessionManager 的子集）。 */
export interface SessionManagerLike {
	activeCount: number;
	listActiveScopes(): ActiveScopeInfoLike[];
	getScopeDetail(scope: { kind: "group" | "user"; id: string }, recentLimit?: number): ActiveScopeDetailLike | undefined;
	forceReap(scope: { kind: "group" | "user"; id: string }): Promise<boolean>;
}

export interface ActiveScopeInfoLike {
	readonly key: string;
	readonly scope: { kind: "group" | "user"; id: string };
	readonly lastActivityAt: number;
	readonly ttlRemainingMs: number;
	readonly messageCount: number;
}

export interface ActiveScopeDetailLike {
	readonly scope: { kind: "group" | "user"; id: string };
	readonly systemPrompt: string;
	readonly tools: { name: string; description: string }[];
	readonly messages: unknown[];
	readonly messageCount: number;
	readonly lastActivityAt: number;
}

export interface BotRuntimeInfo {
	readonly id: string;
	readonly appId: string;
	readonly name: string;
	readonly apiBase: string;
	readonly persona: string | null;
	readonly enabled: boolean;
	readonly loaded: boolean;
	readonly connectionState: string;
	readonly connected: boolean;
	readonly activeScopeCount: number;
}

export interface BotConfigInput {
	readonly id: string;
	readonly appId: string;
	readonly appSecret: string;
	readonly name: string;
	readonly apiBase: string;
	readonly persona: string | null;
	readonly enabled: boolean;
}

/** 日志事件总线：admin-api 的 SSE 路由订阅它，DB sink 把新日志同时投到这里。 */
export interface LogBusLike {
	subscribe(handler: (entry: LogEntry) => void): () => void;
	/** 取缓冲区里最近条目的快照（SSE 回放用）。 */
	recent(): LogEntry[];
}

/** 系统提示词预览所需的数据（设置页只读展示）。 */
export interface PromptPreview {
	readonly template: string;
	readonly tools: { name: string; description: string }[];
}
