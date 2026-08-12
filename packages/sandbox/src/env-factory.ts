import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { BwrapExecutionEnv } from "./bwrap-execution-env.ts";
import { GuardedExecutionEnv } from "./guarded-execution-env.ts";
import { mkdir, lstat, symlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 沙箱执行环境的工厂配置。
 */
export interface EnvFactoryOptions {
	/** 是否启用 Bubblewrap 隔离（仅 Linux 生效）。 */
	readonly enabled: boolean;
	/** 工作目录（沙箱内同路径）。 */
	readonly cwd: string;
	/** 是否断网。 */
	readonly networkDisabled?: boolean;
	/** 默认单命令超时（秒），透传到 ShellExecOptions。 */
	readonly timeoutSeconds?: number;
	/** shell 路径（可选）。 */
	readonly shellPath?: string;
	/**
	 * 额外只读挂载（host 路径 → 沙箱内路径）。用于把历史归档/技能目录/二进制等
	 * 只读挂载到沙箱内，让 agent 能 read 查阅但无法篡改。
	 * - 生产 bwrap：用 `--ro-bind host container`（host 可是目录或单文件）。
	 * - 开发回退（NodeExecutionEnv，无 bwrap）：为每个 bind 建 symlink
	 *   container → host（若 container 是相对路径则基于 cwd 解析）。让开发模式下
	 *   agent 也能用同样的路径读到挂载内容。
	 */
	readonly readOnlyBinds?: readonly (readonly [string, string])[];
	/**
	 * 额外读写挂载（host 路径 → 沙箱内路径）。用于把**共享**目录（如群级 memories）
	 * 可读写挂载到沙箱内，让多个成员会话看到同一份文件。
	 * - 生产 bwrap：用 `--bind host container`。
	 * - 开发回退：同样建 symlink（symlink 本身不限制读写，目标可写即可）。
	 */
	readonly writableBinds?: readonly (readonly [string, string])[];
}

/**
 * 创建一个执行环境：
 * - Linux 且 enabled=true → {@link BwrapExecutionEnv}（生产 namespace 隔离）。
 * - 其它情况（macOS 开发 / disabled）→ {@link NodeExecutionEnv}（直接执行）。
 *
 * **无论哪种，最外层都套一层 {@link GuardedExecutionEnv}**：在 exec 前拦截泄露性命令
 * （curl/wget 外发、ifconfig/hostname 探测、读 ~/.ssh 凭证、读 API key 环境变量等）。
 * 这是纵深防御的一层——开发环境无 bwrap 时它仍是硬护栏；生产环境与断网/只读根配合。
 */
export async function createExecutionEnv(options: EnvFactoryOptions): Promise<ExecutionEnv> {
	const useBwrap = options.enabled && process.platform === "linux";
	if (useBwrap) {
		const base: ExecutionEnv = new BwrapExecutionEnv({
			cwd: options.cwd,
			workspace: options.cwd,
			networkDisabled: options.networkDisabled ?? true,
			shellPath: options.shellPath,
			readOnlyBinds: options.readOnlyBinds,
			writableBinds: options.writableBinds,
		});
		return new GuardedExecutionEnv(base);
	}
	// 开发模式（macOS / disabled）：NodeExecutionEnv 不认 binds。
	// 为每个 bind 建 symlink，让 agent 用同样的沙箱内路径也能读到/写到宿主内容。
	await ensureDevSymlinks(options.cwd, options.readOnlyBinds ?? []);
	await ensureDevSymlinks(options.cwd, options.writableBinds ?? []);
	const base: ExecutionEnv = new NodeExecutionEnv({ cwd: options.cwd, shellPath: options.shellPath });
	return new GuardedExecutionEnv(base);
}

/**
 * 开发模式下为 readOnlyBinds 建 symlink。
 * container 路径若是相对路径，基于 cwd 解析；若是绝对路径（如 /opt/arkham/...），
 * 尝试在宿主创建（可能因权限失败，仅 warn 不阻断——agent 执行时才报错）。
 * 已存在的 symlink/文件跳过（不覆盖），保证幂等。
 */
async function ensureDevSymlinks(
	cwd: string,
	binds: readonly (readonly [string, string])[],
): Promise<void> {
	for (const [host, container] of binds) {
		const containerAbs = container.startsWith("/")
			? container
			: `${cwd.replace(/\/+$/, "")}/${container.replace(/^\/+/, "")}`;
		await safeSymlink(host, containerAbs);
	}
}

/** 建 symlink，已存在则跳过；失败仅 warn（不阻断启动）。幂等。 */
async function safeSymlink(host: string, container: string): Promise<void> {
	try {
		await lstat(container);
		return; // 已存在（文件/symlink/目录），不覆盖。
	} catch {
		// 不存在，继续建。
	}
	try {
		await mkdir(dirname(container), { recursive: true });
		await symlink(host, container);
	} catch (error) {
		const msg = (error as NodeJS.ErrnoException).code === "EEXIST"
			? null
			: (error as Error).message;
		if (msg) {
			console.warn(`[sandbox] 开发 symlink 创建失败: ${container} → ${host} (${msg})`);
		}
	}
}
