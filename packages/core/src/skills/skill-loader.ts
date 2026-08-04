import { type Skill, loadSkills, type SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { resolve } from "node:path";

/**
 * 技能加载器：从宿主机的 skills 目录加载 SKILL.md，并把 filePath 重写成沙箱内路径。
 *
 * 背景：
 * - pi-agent-core 的 `loadSkills(env, dirs)` 递归扫描目录里的 `SKILL.md`，
 *   解析 YAML frontmatter（name/description/disable-model-invocation）+ markdown 正文，
 *   返回 `Skill[]`。它要求 skill 的 `name` 与所在目录名一致（agentskills.io 规范）。
 * - `loadSkills` 返回的 `skill.filePath` 是**宿主机绝对路径**（因为 env 是宿主 env）。
 *   但 agent 运行在沙箱里，它的 `read` 工具以沙箱 cwd 为根。技能目录会被
 *   `--ro-bind`（生产 bwrap）或 symlink（开发）映射到 `<workspaceDir>/skills/`。
 *   所以必须把 filePath 重写成 `<workspaceDir>/skills/<相对路径>`，
 *   agent 才能用 `read workspace/skills/<技能>/SKILL.md` 读到完整技能文件。
 *
 * 重写在加载时一次性完成（所有 scope 共享同一份技能清单 + 同一个 workspace 挂载点）。
 * workspaceDir 在 env-factory 里固定为 `<scopeDir>/workspace`，skills 挂载点固定为
 * `<workspaceDir>/skills`，所以沙箱内路径前缀就是 `<workspaceDir>/skills`。
 */

/** 沙箱内技能目录的挂载点（相对于沙箱 cwd）。 */
export const SANDBOX_SKILLS_DIR = "skills";

/**
 * 从宿主机 skills 目录加载技能，重写 filePath 为沙箱内路径。
 *
 * @param hostSkillsDir 宿主机上的 skills 目录绝对路径（如 `<repo>/skills`）
 * @returns skills（filePath 已重写）+ diagnostics。目录不存在时返回空数组（不报错）。
 */
export async function loadSkillsFromDir(hostSkillsDir: string): Promise<{
	skills: Skill[];
	diagnostics: SkillDiagnostic[];
}> {
	// resolve 成绝对路径：loadSkills 内部用 env（cwd=hostSkillsDir）解析路径，
	// 若传入相对路径会变成 cwd + 相对 = 双层拼接。必须用绝对路径。
	const absDir = resolve(hostSkillsDir);
	// 用宿主 NodeExecutionEnv 读 SKILL.md（技能源文件在仓库内，宿主可直接读）。
	const env = new NodeExecutionEnv({ cwd: absDir });
	const { skills, diagnostics } = await loadSkills(env, absDir);
	// 重写 filePath：宿主绝对路径 → 沙箱内相对路径 `skills/<相对路径>`。
	const rewritten = skills.map((s) => rewriteFilePath(s, absDir));
	return { skills: rewritten, diagnostics };
}

/**
 * 把单个 skill 的 filePath 从宿主绝对路径重写为沙箱内相对路径。
 *
 * 例如 hostSkillsDir=/repo/skills, filePath=/repo/skills/diy-card/SKILL.md
 *   → skills/diy-card/SKILL.md
 *
 * 若 filePath 不以 hostSkillsDir 开头（异常情况），原样返回并依赖调用方诊断。
 */
function rewriteFilePath(skill: Skill, hostSkillsDir: string): Skill {
	const prefix = hostSkillsDir.replace(/\/+$/, "") + "/";
	if (skill.filePath.startsWith(prefix)) {
		const rel = skill.filePath.slice(prefix.length);
		return { ...skill, filePath: `${SANDBOX_SKILLS_DIR}/${rel}` };
	}
	return skill;
}
