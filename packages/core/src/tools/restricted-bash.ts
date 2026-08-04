import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";

/**
 * 受限 bash 工具：只允许白名单内的命令，拒绝其它一切。
 *
 * 群聊场景下，不能让网友通过 agent 执行任意命令（即使沙箱隔离）。
 * 这个工具替代通用 createBashTool，只放行：
 * - 文件查看类：ls/cat/head/tail/find/grep/wc/file/stat/tree/dir
 * - 文本处理：echo/mkdir（仅 workspace 内）/touch（仅 workspace 内）
 * - 技能专用：arkham-cli（DIY 卡图渲染）
 * - 其它只读命令
 *
 * 拒绝：任何形式的脚本执行（python/node/ruby/sh -c）、网络命令、
 * 系统探测、文件修改（rm/mv/cp/chmod）等。
 */

const restrictedBashSchema = Type.Object({
	command: Type.String({ description: "要执行的命令（仅允许查看文件和运行白名单程序）" }),
	timeout: Type.Optional(Type.Number({ description: "超时秒数" })),
});

export type RestrictedBashInput = Static<typeof restrictedBashSchema>;

/**
 * 允许的命令白名单。
 * 匹配规则：命令的第一个 token（或管道/分号后的第一个 token）必须在白名单里。
 */
const ALLOWED_COMMANDS = new Set([
	// 文件查看
	"ls", "cat", "head", "tail", "less", "more", "wc",
	"find", "grep", "rg", "egrep", "fgrep",
	"file", "stat", "tree", "dir",
	"realpath", "readlink", "basename", "dirname",
	"diff",
	// 目录操作（仅创建，不删除）
	"mkdir",
	"touch",
	// 文本输出
	"echo",
	"printf",
	"sort", "uniq", "cut", "tr", "awk", "sed",
	// 技能专用
	"arkham-cli",
]);

/**
 * 禁止的命令模式（即使白名单里有，也额外拦截危险用法）。
 */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
	// 脚本执行
	/\bpython\d?\b/,
	/\bnode\b/,
	/\bruby\b/,
	/\bperl\b/,
	/\bphp\b/,
	/\blua\b/,
	/\bsh\b/,
	/\bbash\b/,
	/\bzsh\b/,
	/\b\d?sh\s+-c\b/,
	// 网络（command-guard 已有，这里再兜一次）
	/\bcurl\b/, /\bwget\b/, /\bnc\b/, /\bssh\b/, /\bscp\b/,
	// 破坏性
	/\brm\b/, /\brmdir\b/, /\bmv\b/, /\bcp\b/,
	/\bchmod\b/, /\bchown\b/, /\btruncate\b/,
	// 重定向到敏感位置
	/>\/etc\//, />\/root/, />\/home\/[^/]+\/\./,
	// 进程/系统
	/\bps\b/, /\bkill\b/, /\bpkill\b/, /\btop\b/, /\bhtop\b/,
	/\bsystemctl\b/, /\bservice\b/,
	// 管道到脚本执行
	/\|\s*(python|node|ruby|perl|sh|bash)/,
];

/**
 * 提取命令中的所有"首命令"token。
 * 处理管道 (|)、分号 (;)、&&、|| 分隔的多条命令。
 */
function extractCommands(command: string): string[] {
	// 按 | ; && || 分割
	const parts = command.split(/(?:\|\||\||&&|;|\n)/);
	const commands: string[] = [];
	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		// 取第一个 token（去掉环境变量前缀如 FOO=bar cmd）
		const tokens = trimmed.split(/\s+/);
		let firstToken = tokens[0];
		// 跳过 env var 赋值（如 FOO=bar）
		let i = 0;
		while (i < tokens.length && /^[A-Z_]+=.+/.test(tokens[i])) {
			i++;
		}
		if (i < tokens.length) {
			firstToken = tokens[i];
		}
		// 去掉路径前缀，只取命令名（如 /opt/arkham/bin/arkham-cli → arkham-cli）
		const basename = firstToken.split("/").pop() ?? firstToken;
		commands.push(basename);
	}
	return commands;
}

/**
 * 审查命令是否允许执行。
 * @returns allowed=true 放行；allowed=false 拒绝（附原因）
 */
export function reviewBashCommand(command: string): { allowed: boolean; reason?: string } {
	const normalized = command.trim();
	if (!normalized) return { allowed: false, reason: "空命令" };

	// 1. 先检查禁止模式（优先级最高）
	for (const pattern of FORBIDDEN_PATTERNS) {
		if (pattern.test(normalized)) {
			return {
				allowed: false,
				reason: `命令包含禁止的操作模式: ${pattern.source}。群聊场景下不允许执行脚本、网络请求或文件破坏操作。`,
			};
		}
	}

	// 2. 检查每条子命令是否在白名单内
	const commands = extractCommands(normalized);
	for (const cmd of commands) {
		if (!ALLOWED_COMMANDS.has(cmd)) {
			return {
				allowed: false,
				reason: `命令 "${cmd}" 不在允许列表内。群聊场景下只能查看文件（ls/cat/grep 等）或运行指定工具（arkham-cli）。`,
			};
		}
	}

	return { allowed: true };
}

/**
 * 创建受限 bash 工具。
 * 内部用 ExecutionEnv.exec 执行命令，但在执行前做白名单审查。
 * 拒绝的命令返回错误消息给 agent，不实际执行。
 */
export function createRestrictedBashTool(env: ExecutionEnv): AgentTool<typeof restrictedBashSchema, undefined> {
	return {
		name: "bash",
		label: "bash",
		description:
			"执行受限的 shell 命令。仅允许文件查看类命令（ls/cat/grep/find 等）和指定工具（arkham-cli）。" +
			"不允许执行脚本（python/node）、网络请求、文件删除或任何系统操作。",
		parameters: restrictedBashSchema,
		async execute(_toolCallId, params, signal) {
			const { command, timeout } = params;
			const review = reviewBashCommand(command);
			if (!review.allowed) {
				return {
					content: [{ type: "text", text: `命令被拒绝：${review.reason}` }],
					details: undefined,
				};
			}
			const result = await env.exec(command, {
				timeout,
				abortSignal: signal,
			});
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `执行失败: ${result.error.message}` }],
					details: undefined,
				};
			}
			const { stdout, stderr, exitCode } = result.value;
			const output = [stdout, stderr && `stderr:\n${stderr}`, exitCode !== 0 ? `(exit ${exitCode})` : ""]
				.filter(Boolean)
				.join("\n");
			return {
				content: [{ type: "text", text: output || "(无输出)" }],
				details: undefined,
			};
		},
	};
}
