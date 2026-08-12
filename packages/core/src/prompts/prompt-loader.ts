/**
 * 提示词外置加载器：把系统提示词从代码里搬到 `prompts/static/*.md` 文件，
 * 方便人工查看和热更新（改文件后 fs.watch 触发 reload → 活跃会话重新激活即生效）。
 *
 * ## 缓存友好的拼装（核心设计）
 *
 * system prompt 必须**完全静态**——对同一 kind（群/私聊）的所有会话字节一致，
 * 这样 Anthropic 的 cache_control 断点能跨会话/跨群/跨成员命中（一个缓存块吃全部）。
 * 所以 system prompt 只拼静态文件，**不含任何 per-bot / per-scope / per-member 变量**：
 *
 *   [safety]  ← 全局静态
 *   [usage-rules]
 *   [reply-format]
 *   [message-format-{group|user}]  ← 二选一，同 kind 共享
 *   [memory-mechanism + RECORD_RULES 替换]
 *   [skills-routing + SKILLS_BLOCK 替换]  ← 技能清单全局共享，稳定
 *
 * 动态变量（persona / 群 id / 当前群员 openid）**不放 system prompt**，由
 * {@link PromptLoader.buildSessionContext} 产出一段 `<session_context>` 文本，
 * ChatBotSession 通过 transformContext 每轮注入到发给 LLM 的消息最前面
 * （系统提示词之后的「下一块」）。它对同一会话稳定 → 进消息缓存前缀；
 * 而 system prompt 块本身跨所有会话命中。
 *
 * 注意：cache_control 断点由 non-stream-bridge 在请求体里打（system 数组末尾、
 * 最后一个 tool、最后一条 user 消息）。pi-ai 原生流式路径也会自动打，但生产用桥接。
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
	readonly terminology: string;
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
	terminology: "terminology.md",
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

/** buildSystemPrompt 的入参。系统提示词只依赖 kind（选 message-format + RECORD_RULES）和全局技能清单。 */
export interface BuildSystemPromptOptions {
	scopeKind: "group" | "user";
	/**
	 * 所有技能的完整内容（SKILL.md 全文），启动时预加载。
	 * 直接注入 system prompt，省掉 load_skill 工具的往返轮次。
	 * agent 仍可用 read 读 references/ 下的参考文件（按需）。
	 * 空数组则不输出技能段。
	 */
	skillsContent?: ReadonlyArray<{ name: string; content: string }>;
}

/** buildSessionContext 的入参：动态变量，注入到系统提示词之后的首条消息。 */
export interface SessionContextOptions {
	scopeKind: "group" | "user";
	/** 群 id 或私聊用户 id。 */
	scopeName: string;
	/** 机器人人设（每 bot 不同）。 */
	persona?: string;
	/**
	 * 群聊：当前对话群员的 openid（每成员会话时填，标识这个会话服务于哪个成员）。
	 * 私聊 undefined。
	 */
	memberId?: string;
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
	 * 构建纯静态系统提示词。只拼静态文件，**不含** per-bot/per-scope 变量
	 * （persona/群 id/成员 openid 由 buildSessionContext 单独产出，注入首条消息）。
	 *
	 * @throws 若 load() 未调用过——启动流程必须先 load
	 */
	buildSystemPrompt(options: BuildSystemPromptOptions): string {
		if (!this.files) throw new Error("PromptLoader.load() 未调用，无法构建系统提示词");
		const isGroup = options.scopeKind === "group";
		const f = this.files;

		// 全静态拼装：所有同 kind 会话字节一致 → cache_control 跨会话命中。
		const parts: string[] = [
			f.safety,
			f.usageRules,
			f.replyFormat,
			f.terminology,
			isGroup ? f.messageFormatGroup : f.messageFormatUser,
			f.memoryMechanism.replace("{{RECORD_RULES}}", isGroup ? RECORD_RULES_GROUP : RECORD_RULES_USER),
		];
		// skills-routing + 所有 SKILL.md 全文：预加载到 system prompt，省掉 load_skill 工具往返。
		// 技能全文在静态区（所有会话相同 → 缓存命中）。参考文件 agent 仍用 read 按需读。
		const skillsText = (options.skillsContent ?? [])
			.filter((s) => s.content.trim())
			.map((s) => `<skill name="${s.name}">\n${s.content}\n</skill>`)
			.join("\n\n");
		const skillsBlockResolved = skillsText || "（当前无已加载技能。）";
		parts.push(f.skillsRouting.replace("{{SKILLS_BLOCK}}", skillsBlockResolved));

		return parts.map((p) => p.trim()).filter((p) => p.length > 0).join("\n\n");
	}

	/**
	 * 构建会话上下文文本（系统提示词之后的「下一块」）。
	 *
	 * 含 per-bot（persona）/ per-scope（群 id 或用户 id）/ per-member（群员 openid）变量。
	 * ChatBotSession 把它包成一条 user 消息，经 transformContext 每轮注入到发给 LLM 的
	 * 消息最前面——既不污染静态 system prompt（保缓存），又对同一会话稳定（进消息缓存前缀）。
	 */
	buildSessionContext(options: SessionContextOptions): string {
		const { scopeKind, scopeName, persona, memberId } = options;
		const lines: string[] = ["<session_context>"];
		if (scopeKind === "group") {
			lines.push(`身份：你是「${scopeName}」这个群的机器人助手。`);
			if (memberId) lines.push(`当前对话群员 openid：${memberId}`);
		} else {
			lines.push(`身份：你是用户的私聊机器人助手（用户 id：${scopeName}）。`);
		}
		if (persona && persona.trim()) {
			lines.push(`设定：${persona.trim()}`);
		}
		lines.push("</session_context>");
		return lines.join("\n");
	}

	/** 读取所有静态文件。缺文件用空串代替 + warn，不阻断启动。 */
	private async readAll(): Promise<PromptFiles> {
		const [safety, usageRules, replyFormat, terminology, messageFormatGroup, messageFormatUser, memoryMechanism, skillsRouting] =
			await Promise.all([
				this.readOne(STATIC_FILES.safety),
				this.readOne(STATIC_FILES.usageRules),
				this.readOne(STATIC_FILES.replyFormat),
				this.readOne(STATIC_FILES.terminology),
				this.readOne(STATIC_FILES.messageFormatGroup),
				this.readOne(STATIC_FILES.messageFormatUser),
				this.readOne(STATIC_FILES.memoryMechanism),
				this.readOne(STATIC_FILES.skillsRouting),
			]);
		return { safety, usageRules, replyFormat, terminology, messageFormatGroup, messageFormatUser, memoryMechanism, skillsRouting };
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
