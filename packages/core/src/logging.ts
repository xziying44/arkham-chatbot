/**
 * 结构化日志：一个全局 sink 注册表 + 带 source/botId/scope 上下文的 Logger。
 *
 * 设计：
 * - Logger 本身不持久化、不格式化，只把 LogEntry 派发给所有已注册 sink。
 * - sink 由组装层（server）注入：一个控制台 sink（开发）+ 一个 DB sink（管理端）+ SSE 推送。
 * - 这样 core 包不依赖 store/web，只定义接口；上层决定落盘和展示。
 *
 * 日志级别：debug < info < warn < error。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
	readonly ts: number;
	readonly level: LogLevel;
	/** 产生日志的模块，如 "app" / "router" / "qq-adapter" / "session-manager"。 */
	readonly source: string;
	readonly botId?: string;
	readonly scope?: string;
	readonly message: string;
	/** 附加结构化字段（会序列化为 JSON 落库）。 */
	readonly fields?: Record<string, unknown>;
}

/** 日志下沉：接收一条完整的 LogEntry。实现负责自己的同步/缓冲/错误隔离。 */
export interface LogSink {
	write(entry: LogEntry): void;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const sinks = new Set<LogSink>();
/** 全局最低级别阈值；低于此级别的日志在 Logger 内被丢弃。 */
let globalLevel: LogLevel = "info";

/** 注册一个 sink。返回取消注册函数。 */
export function addSink(sink: LogSink): () => void {
	sinks.add(sink);
	return () => sinks.delete(sink);
}

/** 设置全局最低日志级别（影响所有 Logger）。 */
export function setLogLevel(level: LogLevel): void {
	globalLevel = level;
}

/** 派发一条日志到所有 sink。sink 抛错不影响其他 sink。 */
function dispatch(entry: LogEntry): void {
	if (LEVEL_RANK[entry.level] < LEVEL_RANK[globalLevel]) return;
	for (const sink of sinks) {
		try {
			sink.write(entry);
		} catch {
			// sink 故障不得影响日志产生方或其他 sink。
		}
	}
}

/**
 * 带上下文的 Logger。
 * 通过 child(botId/scope) 派生子 logger，避免每条日志都重复传上下文。
 */
export interface Logger {
	readonly source: string;
	debug(message: string, fields?: Record<string, unknown>): void;
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
	/** 派生一个带额外 botId 上下文的子 logger。 */
	child(botId: string): Logger;
}

export function createLogger(source: string, botId?: string): Logger {
	const log = (level: LogLevel) => (message: string, fields?: Record<string, unknown>): void => {
		dispatch({ ts: Date.now(), level, source, botId, message, fields });
	};
	return {
		source,
		debug: log("debug"),
		info: log("info"),
		warn: log("warn"),
		error: log("error"),
		child: (id: string) => createLogger(source, id),
	};
}

/**
 * 一个把日志同时打到 console 的 sink（开发用）。
 * 格式：`[ISO source] [level] message {fields}`，botId/scope 作为前缀。
 */
export function createConsoleSink(): LogSink {
	return {
		write(entry) {
			const ts = new Date(entry.ts).toISOString();
			const ctx = [entry.botId ? `bot=${entry.botId}` : "", entry.scope ? `scope=${entry.scope}` : ""]
				.filter(Boolean)
				.join(" ");
			const fieldsStr = entry.fields && Object.keys(entry.fields).length > 0 ? ` ${JSON.stringify(entry.fields)}` : "";
			const line = `[${ts} ${entry.source}${ctx ? " " + ctx : ""}] ${entry.level.toUpperCase()}: ${entry.message}${fieldsStr}`;
			if (entry.level === "error") console.error(line);
			else if (entry.level === "warn") console.warn(line);
			else console.log(line);
		},
	};
}
