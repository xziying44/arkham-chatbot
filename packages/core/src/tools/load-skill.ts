import { type Static, Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Skill } from "@earendil-works/pi-agent-core";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, relative, resolve } from "node:path";

/**
 * load_skill 工具：agent 通过工具调用加载技能的完整内容。
 *
 * 参考 opencode 的 skill 工具设计：
 * - 返回 SKILL.md 全文（content）
 * - 扫描技能目录下的其它文件（references/scripts），列出路径清单
 * - agent 据此知道有哪些参考资料和脚本可用，按需用 read 工具读取
 *
 * 这比"靠系统提示词引导 agent 用 read 读 SKILL.md"更可靠——
 * 工具调用是结构化的，agent 更倾向于主动调用工具。
 *
 * 性能优化：支持 references 参数一次性附带参考文件全文。
 * 这样 agent 用一次工具调用就能拿到 SKILL.md + 关键参考文件，
 * 省掉后续的 read 往返（每次 read 是一次 LLM 轮）。
 */

const loadSkillSchema = Type.Object({
	name: Type.String({
		description: "要加载的技能名称（与系统提示词里 <available_skills> 列出的 name 一致）",
	}),
	references: Type.Optional(Type.Array(Type.String(), {
		description: "可选：同时附带读取的参考文件相对路径（相对于技能目录，如 references/card-types.md）。" +
			"传入后这些文件的全文会直接包含在返回里，省得后续再用 read 读。" +
			"适用于你已知要用哪几个参考文件的场景。",
	})),
});

export type LoadSkillInput = Static<typeof loadSkillSchema>;

export interface CreateLoadSkillToolOptions {
	/** 已加载的技能清单（filePath 已重写为沙箱内路径）。 */
	readonly skills: Skill[];
}

/**
 * 递归列出目录下的所有文件（相对于技能目录的相对路径）。
 * 最多列出 20 个文件（避免输出过长）。
 */
async function listSkillFiles(dir: string, maxFiles = 20): Promise<string[]> {
	const results: string[] = [];
	async function walk(d: string): Promise<void> {
		if (results.length >= maxFiles) return;
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (results.length >= maxFiles) return;
			const fullPath = join(d, entry.name);
			if (entry.isDirectory()) {
				// 跳过隐藏目录和 __pycache__
				if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
				await walk(fullPath);
			} else if (entry.isFile()) {
				// 跳过 SKILL.md 本身（已在正文里展示了）和非文档文件
				if (entry.name === "SKILL.md") continue;
				if (entry.name.startsWith(".")) continue;
				results.push(relative(dir, fullPath));
			}
		}
	}
	await walk(dir);
	return results.sort();
}

export function createLoadSkillTool(opts: CreateLoadSkillToolOptions): AgentTool<typeof loadSkillSchema, undefined> {
	return {
		name: "load_skill",
		label: "load_skill",
		description:
			"加载一个技能的完整说明和文件清单。当任务匹配系统提示词里列出的某个技能时，" +
			"调用此工具加载该技能的 SKILL.md 全文和目录下的参考文件列表。" +
			"加载后按 SKILL.md 的工作流步骤执行，包括它要求你读的参考文件和运行的脚本。",
		parameters: loadSkillSchema,
		async execute(_toolCallId, params) {
			const skill = opts.skills.find((s) => s.name === params.name);
			if (!skill) {
				const available = opts.skills.map((s) => s.name).join(", ");
				return {
					content: [{ type: "text", text: `技能 "${params.name}" 不存在。可用技能：${available}` }],
					details: undefined,
				};
			}

			// 扫描技能目录下的文件（用宿主路径读，filePath 的 dirname）
			const skillDir = dirname(skill.filePath);
			// 注意：skill.filePath 是沙箱内相对路径（如 skills/diy-card/SKILL.md）。
			// 但工具执行在宿主机上（NodeExecutionEnv），需要用宿主机路径。
			// 然而 load_skill 工具运行在 bot-session 层（不在沙箱里），它只需要返回文件清单。
			// 文件清单用沙箱内相对路径（让 agent 知道用 read 时该填什么路径）。
			let fileList: string[] = [];
			try {
				fileList = await listSkillFiles(skillDir);
			} catch {
				// 扫描失败不阻断，至少返回 SKILL.md 正文
			}

			const lines: string[] = [
				`<skill_content name="${skill.name}">`,
				"",
				skill.content.trim(),
				"",
				`技能目录：${skillDir}/`,
				"技能里的相对路径（如 references/xxx.md、scripts/xxx.py）相对于此目录解析。",
				"用 read 工具读这些文件，用 bash 工具运行脚本。",
				"",
			];

			if (fileList.length > 0) {
				lines.push("目录下的参考文件（按需读取）：");
				for (const f of fileList) {
					lines.push(`- ${f}`);
				}
			}

			// 可选：一次性附带参考文件全文（省掉后续 read 往返）。
			// references 是相对技能目录的路径（如 references/card-types.md）。
			// 用宿主真实路径读：skillDir 是沙箱内相对路径 skills/<name>，
			// 宿主上对应 <cwd>/skills/<name>。bot-session 层 cwd 是仓库根。
			if (params.references && params.references.length > 0) {
				lines.push("");
				lines.push("--- 附带参考文件全文 ---");
				for (const relPath of params.references.slice(0, 5)) {
					// 防路径穿越：只允许技能目录下的相对路径
					const normalized = relPath.replace(/^\.?\//, "").replace(/\.\./g, "");
					const sandboxPath = `${skillDir}/${normalized}`.replace(/\/+/g, "/");
					const hostPath = resolve(sandboxPath);
					try {
						const content = await readFile(hostPath, "utf8");
						lines.push("");
						lines.push(`=== ${normalized} ===`);
						lines.push(content.trim());
					} catch {
						lines.push("");
						lines.push(`=== ${normalized} ===`);
						lines.push(`（读取失败：${normalized}，请用 read 工具手动读 skills/${skill.name}/${normalized}）`);
					}
				}
			}

			lines.push("</skill_content>");

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: undefined,
			};
		},
	};
}
