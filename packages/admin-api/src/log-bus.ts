import type { LogEntry, LogSink } from "@arkham/chatbot-core";

/**
 * 日志事件总线 + 最近 N 条环形缓冲。
 *
 * - 作为 LogSink 注册到 core 的 addSink：所有 Logger 产生的日志都汇入这里。
 * - DB sink 落库（在 server 注册）；本类只负责内存广播，供 SSE 实时推送。
 * - SSE 新连接先回放缓冲里的最近条目，再实时推送后续。
 */
export class LogBus implements LogSink {
	private readonly handlers = new Set<(entry: LogEntry) => void>();
	private readonly buffer: LogEntry[] = [];
	private readonly capacity: number;

	constructor(capacity = 1000) {
		this.capacity = capacity;
	}

	/** LogSink 实现：缓存 + 广播。 */
	write(entry: LogEntry): void {
		this.buffer.push(entry);
		if (this.buffer.length > this.capacity) {
			this.buffer.splice(0, this.buffer.length - this.capacity);
		}
		for (const h of this.handlers) {
			try {
				h(entry);
			} catch {
				/* 单个订阅者故障不影响其它 */
			}
		}
	}

	subscribe(handler: (entry: LogEntry) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	/** 取缓冲区里最近条目的快照（SSE 回放用）。 */
	recent(): LogEntry[] {
		return this.buffer.slice();
	}
}
