import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HISTORY_FILENAME = "session.jsonl";

/**
 * 对话历史持久化：每个 scope 一个 `session.jsonl` 文件，每行一条 AgentMessage。
 *
 * - 激活时：`load()` 读取全部历史行，作为 `new Agent({ initialState: { messages } })` 的初始消息。
 * - 运行中：周期性或回收时 `save()` 把当前 `agent.state.messages` 整体覆盖写回。
 *
 * 采用「整段覆盖」而非「逐条追加」，是为了简单与一致性：pi 的 Agent 维护的是一份权威
 * messages 数组（含流式更新后的最终态），覆盖写能保证磁盘与内存始终一致，避免追加造成的状态分歧。
 * 规模上来后可换成 pi 的 JsonlSessionRepository 或 SQLite。
 */
export class HistoryStore {
	private readonly historyPath: string;

	constructor(scopeDir: string) {
		this.historyPath = join(scopeDir, HISTORY_FILENAME);
	}

	async load(): Promise<AgentMessage[]> {
		try {
			const content = await readFile(this.historyPath, "utf8");
			const messages: AgentMessage[] = [];
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (trimmed.length === 0) continue;
				try {
					messages.push(JSON.parse(trimmed) as AgentMessage);
				} catch {
					// 跳过损坏行，不阻断恢复。
				}
			}
			return messages;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return [];
			return [];
		}
	}

	async save(messages: AgentMessage[]): Promise<void> {
		try {
			await mkdir(join(this.historyPath, ".."), { recursive: true });
			const lines = messages.map((m) => JSON.stringify(m)).join("\n");
			await writeFile(this.historyPath, lines, "utf8");
		} catch {
			// 持久化失败不阻断会话。
		}
	}
}
