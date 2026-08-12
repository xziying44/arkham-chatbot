import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 群共享聊天记录：append-only 的 JSONL 文件，记录群里所有成员发给机器人的消息
 * 以及机器人的回复。每群一个 `transcript.jsonl`。
 *
 * 设计背景：每成员智能体只在自己的上下文里保留「自己与机器人」的对话；通过这份
 * 共享记录，任何成员的智能体都能**随时查阅**群里其他成员和机器人之间聊了什么
 * （沙箱里以 `group-feed.jsonl` 只读挂载，agent 用 `read`/`tail` 翻）。
 *
 * - **写**：append 串行化（per-store Promise 链），并发安全——多个成员 / 同一成员
 *   的多次追加排队执行，不会交错损坏文件。
 * - **读**：agent 在沙箱里只读查阅；本类不提供随机读（host 侧仅在管理端/调试时读）。
 *
 * 写失败不抛（不阻断对话主流程）；下一次 append 仍能继续。
 */
export class TranscriptStore {
	private readonly filePath: string;
	/** 串行化追加：所有 append 排在这个链上，避免并发交错写坏文件。 */
	private chain: Promise<void> = Promise.resolve();

	constructor(groupDir: string) {
		this.filePath = join(groupDir, "transcript.jsonl");
	}

	/** 宿主机文件绝对路径（供沙箱只读挂载为 group-feed.jsonl）。 */
	get path(): string {
		return this.filePath;
	}

	/**
	 * 追加一批消息到 transcript（串行化，并发安全）。
	 *
	 * 调用方：
	 * - dispatcher 收到群消息时 append 入站 user 消息（所有成员的）；
	 * - ChatBotSession.runPrompt 在一轮结束后 append 机器人的新回复（assistant + toolResult）。
	 */
	append(messages: AgentMessage[]): Promise<void> {
		if (messages.length === 0) return this.chain;
		const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
		this.chain = this.chain
			.then(() => mkdir(join(this.filePath, ".."), { recursive: true }))
			.then(() => appendFile(this.filePath, lines, "utf8"))
			.catch((e) => {
				// 写失败记日志但不抛——对话主流程不应被记录失败打断。
				console.warn(`[transcript] 追加失败: ${(e as Error).message}`);
			});
		return this.chain;
	}
}
