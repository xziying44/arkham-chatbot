import { mkdir } from "node:fs/promises";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { BwrapExecutionEnv } from "./bwrap-execution-env.ts";
import { GuardedExecutionEnv } from "./guarded-execution-env.ts";
import { ScopedExecutionEnv } from "./scoped-execution-env.ts";

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
	/** 默认单命令超时（秒）。 */
	readonly timeoutSeconds?: number;
	/** shell 路径（可选）。 */
	readonly shellPath?: string;
	/**
	 * 额外只读挂载（host 路径 → 沙箱内路径）。用于把历史归档/技能目录/二进制等
	 * 只读挂载到沙箱内，让 agent 能 read 查阅但无法篡改。
	 * - 生产 bwrap：用 `--ro-bind host container`（host 可是目录或单文件）。
	 * - 文件工具：由 ScopedExecutionEnv 映射虚拟路径，不在 workspace 创建 symlink。
	 */
	readonly readOnlyBinds?: readonly (readonly [string, string])[];
}

/**
 * 创建一个执行环境：
 * - Linux 且 enabled=true → {@link BwrapExecutionEnv}（生产 namespace 隔离）。
 * - 其它情况（macOS 开发 / disabled）→ {@link NodeExecutionEnv}（仅供受信任开发环境）。
 *
 * 所有文件 API 都由 ScopedExecutionEnv 强制限制在 workspace 或显式只读挂载内；最外层
 * GuardedExecutionEnv 再审查命令。生产硬隔离依赖 Linux Bubblewrap，disabled 回退不承诺
 * shell 级文件系统隔离。
 */
export async function createExecutionEnv(options: EnvFactoryOptions): Promise<ExecutionEnv> {
	await mkdir(options.cwd, { recursive: true });
	const useBwrap = options.enabled && process.platform === "linux";
	let base: ExecutionEnv;
	if (useBwrap) {
		base = new BwrapExecutionEnv({
			cwd: options.cwd,
			workspace: options.cwd,
			networkDisabled: options.networkDisabled ?? true,
			shellPath: options.shellPath,
			readOnlyBinds: options.readOnlyBinds,
		});
	} else {
		base = new NodeExecutionEnv({ cwd: options.cwd, shellPath: options.shellPath });
	}
	const scoped = new ScopedExecutionEnv(base, {
		workspace: options.cwd,
		readOnlyBinds: options.readOnlyBinds,
		defaultTimeoutSeconds: options.timeoutSeconds,
	});
	return new GuardedExecutionEnv(scoped);
}
