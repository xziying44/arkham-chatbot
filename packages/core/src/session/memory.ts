import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MEMORY_FILENAME = "memory.md";

/**
 * 记忆持久化：每个 scope 一个 `memory.md` 文件。
 *
 * 回收时：由一次 LLM 摘要把当前会话的要点提炼成 Markdown，覆盖写入。
 * 激活时：读取全文，拼入系统 prompt 的「长期记忆」段。
 *
 * 文件不存在视为无记忆（首次激活）。读写均吞掉错误（记忆缺失不应阻断会话）。
 */
export class MemoryStore {
	private readonly memoryPath: string;

	constructor(scopeDir: string) {
		this.memoryPath = join(scopeDir, MEMORY_FILENAME);
	}

	/** 读取已持久化的长期记忆，无记忆时返回 undefined。 */
	async load(): Promise<string | undefined> {
		try {
			const content = await readFile(this.memoryPath, "utf8");
			const trimmed = content.trim();
			return trimmed.length > 0 ? trimmed : undefined;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return undefined;
			// 其它错误（权限等）也不阻断：记录并视作无记忆。
			return undefined;
		}
	}

	/** 覆盖写入长期记忆。 */
	async save(content: string): Promise<void> {
		try {
			await mkdir(join(this.memoryPath, ".."), { recursive: true });
			await writeFile(this.memoryPath, content, "utf8");
		} catch {
			// 写入失败不抛：记忆丢失是可接受的降级，会话仍可继续。
		}
	}
}
