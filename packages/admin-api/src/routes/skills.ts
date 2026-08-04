import { Hono } from "hono";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

interface SkillsRoutesDeps {
	readonly skillsDir: string;
}

/**
 * 技能查看路由（只读）。
 *
 * - GET /         列出所有技能（扫描 skillsDir 下的 SKILL.md，解析 frontmatter）
 * - GET /:name    技能详情：SKILL.md 全文 + 同目录下所有附件文件内容
 *
 * 技能源文件在仓库内（git 管理），管理端只提供查看，不支持在线编辑。
 */
export function createSkillsRoutes(deps: SkillsRoutesDeps): Hono {
	const app = new Hono();
	const { skillsDir } = deps;

	/** 列出所有技能。 */
	app.get("/", async (c) => {
		const entries = await listSkills(skillsDir).catch(() => []);
		return c.json({ items: entries });
	});

	/** 技能详情：SKILL.md 正文 + 附件文件列表及内容。 */
	app.get("/:name", async (c) => {
		const name = c.req.param("name");
		const skillDir = join(skillsDir, name);
		const skillFile = join(skillDir, "SKILL.md");
		try {
			await stat(skillFile);
		} catch {
			return c.json({ error: `技能不存在: ${name}` }, 404);
		}
		const raw = await readFile(skillFile, "utf8");
		const parsed = parseFrontmatter(raw);
		// 列出同目录下所有 .md 附件（排除 SKILL.md 自身）。
		const allFiles = await listMarkdownFiles(skillDir).catch(() => []);
		const attachments = await Promise.all(
			allFiles
				.filter((f) => f !== "SKILL.md")
				.map(async (relPath) => {
					const content = await readFile(join(skillDir, relPath), "utf8").catch(() => "");
					return { path: relPath, content };
				}),
		);
		return c.json({
			name: typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : name,
			description: typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : "",
			dir: relative(skillsDir, skillDir),
			filePath: `skills/${name}/SKILL.md`,
			content: raw,
			body: parsed.body,
			attachments,
		});
	});

	return app;
}

/** 技能列表项。 */
interface SkillListItem {
	name: string;
	description: string;
	dir: string;
	files: string[];
}

/** 扫描 skillsDir，找出所有含 SKILL.md 的子目录，解析 frontmatter。 */
async function listSkills(skillsDir: string): Promise<SkillListItem[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(skillsDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const result: SkillListItem[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const skillDir = join(skillsDir, entry.name);
		const skillFile = join(skillDir, "SKILL.md");
		try {
			await stat(skillFile);
		} catch {
			continue; // 无 SKILL.md，跳过
		}
		const raw = await readFile(skillFile, "utf8");
		const parsed = parseFrontmatter(raw);
		const files = await listMarkdownFiles(skillDir);
		result.push({
			name: typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : entry.name,
			description: typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : "",
			dir: entry.name,
			files,
		});
	}
	return result;
}

/** 列出某目录下所有 .md 文件（相对路径）。 */
async function listMarkdownFiles(dir: string): Promise<string[]> {
	async function walk(d: string, prefix: string): Promise<string[]> {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch {
			return [];
		}
		const files: string[] = [];
		for (const e of entries) {
			if (e.name.startsWith(".")) continue;
			const rel = prefix ? `${prefix}/${e.name}` : e.name;
			if (e.isDirectory()) {
				files.push(...(await walk(join(d, e.name), rel)));
			} else if (e.name.endsWith(".md")) {
				files.push(rel);
			}
		}
		return files;
	}
	return walk(dir, "");
}

/**
 * 解析 YAML frontmatter + markdown body。
 *
 * 只提取 name / description 两个标量字段（技能 frontmatter 的标准字段），
 * 不引入 yaml 库——管理端只需这两个字段做列表展示。
 */
function parseFrontmatter(content: string): {
	frontmatter: { name?: string; description?: string };
	body: string;
} {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) {
		return { frontmatter: {}, body: normalized };
	}
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter: {}, body: normalized };
	}
	const yamlBlock = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).replace(/^\n+/, "");
	// 简单提取 name / description（YAML 标量）。
	const frontmatter: { name?: string; description?: string } = {};
	for (const line of yamlBlock.split("\n")) {
		const m = /^(\w[\w-]*)\s*:\s*(.+?)\s*$/.exec(line);
		if (!m) continue;
		const [, key, value] = m;
		// 去掉引号。
		const cleaned = value.replace(/^["']|["']$/g, "");
		if (key === "name" || key === "description") {
			frontmatter[key] = cleaned;
		}
	}
	return { frontmatter, body };
}
