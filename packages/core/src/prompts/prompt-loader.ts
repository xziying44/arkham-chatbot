/**
 * 提示词外置加载器：把系统提示词从代码里搬到 `prompts/static/*.md` 文件，
 * 方便人工查看和热更新（改文件后 fs.watch 触发 reload → 活跃会话重新激活即生效）。
 *
 * ## 缓存友好的拼装顺序（核心设计）
 *
 * pi-ai 在 system prompt 末尾打 cache_control 断点（Anthropic 三个断点之一）。
 * 只要 system prompt 的**字节**在多轮/多会话间保持稳定，就能命中 prompt cache。
 * 所以拼装顺序是 **静态内容在前，动态内容在后**：
 *
 *   [safety]  ← 全局静态，所有会话相同（最大缓存命中面）
 *   [usage-rules]
 *   [reply-format]
 *   [message-format-{group|user}]  ← 二选一，同 kind 的会话共享
 *   [memory-mechanism + RECORD_RULES 替换]
 *   [skills-routing + SKILLS_BLOCK 替换]  ← skillsBlock 由技能清单决定，技能不变则稳定
 *   --- 动态分界线 ---
 *   [persona]      ← 每 bot 不同
 *   [scopeName 身份行]  ← 每 scope 不同
 *
 * 动态部分（persona/scopeName）放最后，前面的静态前缀仍能被缓存。
 *
 * ## 占位符
 *
 * 文件里用 `{{NAME}}` 占位，buildSystemPrompt 时替换：
 * - `{{SKILLS_BLOCK}}` → formatSkillsForSystemPrompt 的输出
 * - `{{RECORD_RULES}}` → 群/私聊各自的「该记」规则
 *
 * ## 文件缺失降级
 *
 * 任一静态文件缺失时用空串代替（不阻断启动），并打 warn——提示词会残缺但 bot 能跑。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** 静态提示词文件名 → 加载后的文本内容。 */
interface PromptFiles {
	readonly safety: string;
	readonly usageRules: string;
	readonly replyFormat: string;
	readonly messageFormatGroup: string;
	readonly messageFormatUser: string;
	readonly memoryMechanism: string;
	readonly skillsRouting: string;
}

/** 静态文件清单（文件名 → 读取时的相对路径）。 */
const STATIC_FILES = {
	safety: "safety.md",
	usageRules: "usage-rules.md",
	replyFormat: "reply-format.md",
	messageFormatGroup: "message-format-group.md",
	messageFormatUser: "message-format-user.md",
	memoryMechanism: "memory-mechanism.md",
	skillsRouting: "skills-routing.md",
} as const satisfies Record<keyof PromptFiles, string>;

/** 群聊场景的「该记」规则（替换 memory-mechanism.md 的 {{RECORD_RULES}}）。 */
const RECORD_RULES_GROUP = [
	"- **该记**：群员的身份/偏好（如「小银喜欢简洁回答」）、进行中的任务/约定、用户反馈的做事方式、群的整体约定/氛围。",
	"- **记用户信息时带上 openid**：QQ 群消息没有昵称，你靠 openid 识别不同群员。当记忆涉及具体某个人时，正文里记下对方的 openid（消息前缀 `[openid]:` 里的那串），这样下次能靠 openid 匹配到人。不涉及具体人的记忆（如群的整体约定）不需要 openid。",
].join("\n");

/** 私聊场景的「该记」规则。 */
const RECORD_RULES_USER = "- **该记**：用户的身份/偏好（如「喜欢简洁回答」）、进行中的任务/约定、用户反馈的做事方式。";

/** buildSystemPrompt 的入参。 */
export interface BuildSystemPromptOptions {
	scopeName: string;
	scopeKind: "group" | "user";
	persona?: string;
	/**
	 * 所有技能的完整内容（SKILL.md 全文），启动时预加载。
	 * 直接注入 system prompt，省掉 load_skill 工具的往返轮次。
	 * agent 仍可用 read 读 references/ 下的参考文件（按需）。
	 * 空数组则不输出技能段。
	 */
	skillsContent?: ReadonlyArray<{ name: string; content: string }>;
}

/**
 * 提示词加载器。启动时读一次 `prompts/static/*.md`，缓存到内存；
 * reload() 重新读（fs.watch 触发或管理端手动调）。
 *
 * 一个 BotManager 持有一个 PromptLoader 实例（所有会话共享），保证静态前缀
 * 在所有会话间字节一致 → prompt cache 命中。
 */
export class PromptLoader {
	private files: PromptFiles | undefined;
	private readonly staticDir: string;

	constructor(promptsDir: string) {
		this.staticDir = join(promptsDir, "static");
	}

	/** 启动时调用：读取所有静态文件。失败不抛（缺文件用空串），只 warn。 */
	async load(): Promise<void> {
		this.files = await this.readAll();
	}

	/**
	 * 热更新：重新读取所有静态文件，替换内存缓存。
	 * 调用方（BotManager）负责在 reload 后 reap 所有活跃会话，让下次激活用新提示词。
	 */
	async reload(): Promise<void> {
		this.files = await this.readAll();
	}

	/**
	 * 构建完整系统提示词。
	 *
	 * 顺序见文件头注释：静态前缀（缓存友好）在前，动态（persona/scopeName）在后。
	 * @throws 若 load() 未调用过——启动流程必须先 load
	 */
	buildSystemPrompt(options: BuildSystemPromptOptions): string {
		if (!this.files) throw new Error("PromptLoader.load() 未调用，无法构建系统提示词");
		const { scopeName, scopeKind, persona } = options;
		const isGroup = scopeKind === "group";
		const f = this.files;

		// ---- 静态前缀（缓存命中面）----
		const parts: string[] = [
			f.safety,
			f.usageRules,
			f.replyFormat,
			isGroup ? f.messageFormatGroup : f.messageFormatUser,
			f.memoryMechanism.replace("{{RECORD_RULES}}", isGroup ? RECORD_RULES_GROUP : RECORD_RULES_USER),
		];
		// skills-routing + 所有 SKILL.md 全文：预加载到 system prompt，省掉 load_skill 工具往返。
		// 技能全文在静态前缀区（所有会话相同 → 缓存命中）。参考文件 agent 仍用 read 按需读。
		const skillsText = (options.skillsContent ?? [])
			.filter((s) => s.content.trim())
			.map((s) => `<skill name="${s.name}">\n${s.content}\n</skill>`)
			.join("\n\n");
		const skillsBlockResolved = skillsText || "（当前无已加载技能。）";
		parts.push(f.skillsRouting.replace("{{SKILLS_BLOCK}}", skillsBlockResolved));

		// ---- 动态后缀（每 bot / 每 scope 不同）----
		// persona（可选，每 bot 不同）。
		if (persona && persona.trim()) {
			parts.push(`## 你的设定\n${persona}`);
		}
		// scopeName 身份行（每 scope 不同）。
		if (isGroup) {
			parts.push(`## 当前会话\n你是「${scopeName}」这个群的机器人助手。`);
		} else {
			parts.push(`## 当前会话\n你是用户的私聊机器人助手（会话 id：${scopeName}）。`);
		}

		return parts.map((p) => p.trim()).filter((p) => p.length > 0).join("\n\n");
	}

	/** 读取所有静态文件。缺文件用空串代替 + warn，不阻断启动。 */
	private async readAll(): Promise<PromptFiles> {
		const [safety, usageRules, replyFormat, messageFormatGroup, messageFormatUser, memoryMechanism, skillsRouting] =
			await Promise.all([
				this.readOne(STATIC_FILES.safety),
				this.readOne(STATIC_FILES.usageRules),
				this.readOne(STATIC_FILES.replyFormat),
				this.readOne(STATIC_FILES.messageFormatGroup),
				this.readOne(STATIC_FILES.messageFormatUser),
				this.readOne(STATIC_FILES.memoryMechanism),
				this.readOne(STATIC_FILES.skillsRouting),
			]);
		return { safety, usageRules, replyFormat, messageFormatGroup, messageFormatUser, memoryMechanism, skillsRouting };
	}

	/** 读取单个静态文件，ENOENT 或读失败用空串代替 + warn。 */
	private async readOne(rel: string): Promise<string> {
		const abs = join(this.staticDir, rel);
		try {
			return await readFile(abs, "utf8");
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				console.warn(`[prompts] 静态提示词文件缺失，用空串代替: ${rel}`);
			} else {
				console.warn(`[prompts] 读取静态提示词文件失败: ${rel}: ${(e as Error).message}`);
			}
			return "";
		}
	}
}
