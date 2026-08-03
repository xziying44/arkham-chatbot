import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

const HISTORY_FILENAME = "session.jsonl";
const HISTORY_DIRNAME = "history";

/**
 * 对话历史持久化：每个 scope 两层存储。
 *
 * 1. **session.jsonl**（当前会话快照）：回收时整体覆盖写。激活时全量加载。
 * 2. **history/YYYY-MM-DD.jsonl**（按天归档）：回收时把消息按 timestamp 归类到
 *    对应日期文件，**追加**写入（同一天的多次会话累积）。只读挂载到沙箱，
 *    agent 可用 read 工具查阅历史对话（如「上周聊了什么」）。
 *
 * 归档文件是长期累积的只读参考；session.jsonl 是激活时快速恢复的当前快照。
 */
export class HistoryStore {
	private readonly historyPath: string;
	private readonly archiveDir: string;

	constructor(scopeDir: string) {
		this.historyPath = join(scopeDir, HISTORY_FILENAME);
		this.archiveDir = join(scopeDir, HISTORY_DIRNAME);
	}

	/** 归档目录绝对路径（供 env-factory 只读挂载到沙箱用）。 */
	get archiveDirPath(): string {
		return this.archiveDir;
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

	/**
	 * 按天归档消息：把 messages 按 timestamp 的日期（YYYY-MM-DD）分组，
	 * 追加写入 `history/YYYY-MM-DD.jsonl`（同一天多次会话累积）。
	 * 没有 timestamp 的消息归到 "unknown" 日期。
	 *
	 * 回收时调：save() 存当前快照 + archiveByDay() 存长期归档。
	 */
	async archiveByDay(messages: AgentMessage[]): Promise<void> {
		if (messages.length === 0) return;
		try {
			await mkdir(this.archiveDir, { recursive: true });
			// 按日期分组。
			const byDay = new Map<string, AgentMessage[]>();
			for (const msg of messages) {
				const ts = (msg as { timestamp?: unknown }).timestamp;
				const day = typeof ts === "number" && ts > 0 ? formatDate(new Date(ts)) : "unknown";
				const arr = byDay.get(day) ?? [];
				arr.push(msg);
				byDay.set(day, arr);
			}
			// 逐天追加。
			for (const [day, msgs] of byDay) {
				const lines = msgs.map((m) => JSON.stringify(m)).join("\n") + "\n";
				await appendFile(join(this.archiveDir, `${day}.jsonl`), lines, "utf8");
			}
		} catch {
			// 归档失败不阻断会话。
		}
	}
}

/** 格式化日期为 YYYY-MM-DD（本地时区）。 */
function formatDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

