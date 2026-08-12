/**
 * 简单的异步计数信号量：限制同时进行的任务数。
 *
 * 用于群内并发上限：一群 N 人同时发指令时，最多 `groupMaxConcurrent`（默认 3）个
 * 成员的 agent run 同时跑，超出的排队等空位——避免一次性 N 个 LLM 调用打爆端点
 * （触发限流 / 拖慢整体）。
 *
 * acquire() 在没有名额时返回一个 pending Promise，release() 把名额直接转交给
 * 队首等待者（名额不回 available 池，避免多释放一个）。
 */
export class Semaphore {
	private available: number;
	private readonly waiters: Array<() => void> = [];

	constructor(private readonly max: number) {
		this.available = max;
	}

	/** 占一个名额；名额不足时挂起，直到有人 release。 */
	async acquire(): Promise<void> {
		if (this.available > 0) {
			this.available--;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
		// 被 resolve 时，release 已把名额「转交」给本等待者，无需再扣 available。
	}

	/** 释放一个名额：优先转交给队首等待者，否则归还到 available 池。 */
	release(): void {
		const next = this.waiters.shift();
		if (next) {
			next(); // 名额直接转交，available 不变。
			return;
		}
		if (this.available < this.max) this.available++;
	}
}
