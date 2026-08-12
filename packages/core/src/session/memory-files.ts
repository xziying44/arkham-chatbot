import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 智能体自管理的文件式记忆系统。
 *
 * 记忆文件放在**沙箱工作目录内**（挂载到 `workspace/memories`），这样：
 * - bash/read/write/edit 工具天然能操作（无需单独的 memory 工具）
 * - 群聊：记忆目录在群级共享（所有成员 agent 读写同一份），沙箱 rw-bind 进各成员 workspace
 * - 私聊：记忆目录就在用户自己的 workspace/memories 下
 *
 * 目录布局（沙箱内统一为 workspace/memories/）：
 *   workspace/memories/
 *     ├── MEMORY.md            # 索引：一行一条 `- [标题](文件.md) — 钩子`
 *     ├── user-preferences.md  # 单条记忆：frontmatter + 正文
 *     └── ...
 *
 * 本类只负责两件事：
 * 1. ensure()：激活时确保 memories/ 目录存在（agent 才能 write 进去）
 * 2. loadIndex()：读 MEMORY.md 索引，拼入系统提示词，让 agent 知道"有哪些记忆"
 *
 * 记忆文件的增删改由 agent 用 read/write/edit/bash 工具直接做（系统提示词里有指引）。
 *
 * @param memoriesDir 记忆目录的**宿主机绝对路径**（群级共享目录或私聊 workspace/memories）。
 *                    沙箱挂载保证 agent 在 workspace/memories 看到同一份文件。
 */
const INDEX_FILENAME = "MEMORY.md";

export class MemoryFiles {
	private readonly dir: string;
	private readonly indexPath: string;

	constructor(memoriesDir: string) {
		this.dir = memoriesDir;
		this.indexPath = join(memoriesDir, INDEX_FILENAME);
	}

	/** 确保 memories/ 目录存在（激活时调用，agent 才能 write 进去）。 */
	async ensure(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
	}

	/**
	 * 读取 MEMORY.md 索引全文。无索引返回 undefined。
	 * 激活时拼入系统提示词，让 agent 知道有哪些记忆、各自是什么。
	 */
	async loadIndex(): Promise<string | undefined> {
		try {
			const content = await readFile(this.indexPath, "utf8");
			const trimmed = content.trim();
			return trimmed.length > 0 ? trimmed : undefined;
		} catch {
			return undefined;
		}
	}
}
