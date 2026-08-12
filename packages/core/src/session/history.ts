import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

const HISTORY_FILENAME = "session.jsonl";
const HISTORY_DIRNAME = "history";

/**
 * 对话历史持久化：每个 scope 两层存储。
 *
 * 1. **session.jsonl**（当前会话快照）：两条写盘路径——
 *    - runPrompt 成功后增量 appendAll（防进程 crash 丢数据）；
 *    - dispose 时全量 save 覆盖兜底（已包含此前 append 的消息）。
 *    激活时全量 load。
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
			return sanitizeLoadedMessages(messages);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return [];
			return [];
		}
	}

	async save(messages: AgentMessage[]): Promise<void> {
		try {
			await mkdir(join(this.historyPath, ".."), { recursive: true });
			// 每行末尾带换行，确保后续 appendAll 追加的新行不会粘到最后一行上。
			const lines = messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length > 0 ? "\n" : "");
			await writeFile(this.historyPath, lines, "utf8");
		} catch {
			// 持久化失败不阻断会话。
		}
	}

	/**
	 * 增量追加消息到 session.jsonl（每条一行，文件末尾追加）。
	 *
	 * 用途：runPrompt 成功后把本轮新增的消息立即落盘，避免进程被 kill 时
	 * 未触发 dispose 的对话丢失。dispose 时 save() 仍会全量覆盖兜底
	 * （全量快照已包含之前 append 的消息，不会丢数据）。
	 *
	 * 文件不存在时 appendFile 会自动创建；存在时追加。由于 save() 已保证
	 * 文件以换行结尾，追加的新行不会粘到旧行上。
	 */
	async appendAll(messages: AgentMessage[]): Promise<void> {
		if (messages.length === 0) return;
		try {
			await mkdir(join(this.historyPath, ".."), { recursive: true });
			const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
			await appendFile(this.historyPath, lines, "utf8");
		} catch {
			// 增量落盘失败不阻断会话——dispose 时仍会全量 save 兜底。
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

/**
 * 加载时清理：把 session.jsonl 重建为**结构合法**的消息序列，杜绝 400 / 毒化死循环。
 *
 * 防御历史里残留的失败 / 中断 turn（runPrompt 现在会回滚不写，但旧数据 / 进程被 kill 中途 /
 * 异常路径仍可能有残留）。处理四类问题：
 *
 * 1. **坏 assistant**（stopReason `error` / `length`）：后者是 DeepSeek 兼容端点不守 thinking
 *    budget、思考吃光 max_tokens 导致 content=[] 的空回复。留着会毒化后续每一轮。
 * 2. **dangling tool_use**（最关键）：assistant 发了 tool_use 但后续没有完整覆盖全部 id 的
 *    tool_result（被中断 / 结果没落盘 / 中间插了 user 消息）→ Anthropic 端点直接 400
 *    「tool_use ids found without tool_result blocks immediately after」。**这是「某群发消息没反应」
 *    的头号成因**。处理：丢弃该 assistant（及它已有的零散 result），让序列重排合法。
 * 3. **孤立 toolResult**：上一步删 assistant 后、或历史本身残留的无主 tool_result → 丢弃。
 * 4. **末尾不完整**：去掉结尾悬空的 toolResult / 没等到回复的 tool_use assistant / 没回复的 user，
 *    让历史干净地停在一条「纯文本 assistant」上。
 */
function sanitizeLoadedMessages(msgs: AgentMessage[]): AgentMessage[] {
	type Block = { type?: string; id?: string };
	type M = { role?: string; stopReason?: string; content?: unknown; toolCallId?: string };
	const arr = (msgs as M[]).filter(
		(m) => !(m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "length")),
	);
	const useIds = (m: M): string[] => {
		if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
		return (m.content as Block[]).filter((b) => b?.type === "toolCall" && b.id).map((b) => b.id as string);
	};
	// 重建：保证每个 tool_use assistant 紧跟覆盖全部 id 的 tool_result；否则丢弃该 assistant。
	// 孤立 toolResult（无对应 tool_use）也一并丢弃。
	const out: M[] = [];
	let i = 0;
	while (i < arr.length) {
		const m = arr[i];
		const uses = useIds(m);
		if (uses.length > 0) {
			let j = i + 1;
			const results: M[] = [];
			while (j < arr.length && arr[j].role === "toolResult") {
				results.push(arr[j]);
				j++;
			}
			const rids = new Set(results.map((r) => r.toolCallId));
			if (uses.every((id) => rids.has(id))) {
				out.push(m, ...results); // 合法：assistant + 覆盖全部 id 的 result
			}
			// else：dangling tool_use（缺 result）→ 丢弃 assistant 及已收到的部分 result
			i = j;
			continue;
		}
		if (m.role !== "toolResult") out.push(m); // 孤立 toolResult 丢弃
		i++;
	}
	// 去掉末尾不完整的 tool 往返：toolResult 收尾 / tool_use assistant 收尾但无后续回复。
	while (out.length > 0) {
		const last = out[out.length - 1];
		if (last.role === "toolResult") {
			out.pop();
			continue;
		}
		if (last.role === "assistant" && useIds(last).length > 0) {
			out.pop();
			continue;
		}
		break;
	}
	// 去末尾悬空 user（让历史停在 assistant）。
	while (out.length > 0 && out[out.length - 1].role === "user") out.pop();
	return out as AgentMessage[];
}

