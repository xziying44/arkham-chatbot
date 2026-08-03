import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { BwrapExecutionEnv } from "./bwrap-execution-env.ts";

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
}

/**
 * 创建一个执行环境：
 * - Linux 且 enabled=true → {@link BwrapExecutionEnv}（生产隔离）。
 * - 其它情况（macOS 开发 / disabled）→ {@link NodeExecutionEnv}（直接执行，无隔离）。
 *
 * 这样 macOS 本地开发无感知，生产 Linux 自动获得 bash 命令沙箱。
 */
export function createExecutionEnv(options: EnvFactoryOptions): ExecutionEnv {
	const useBwrap = options.enabled && process.platform === "linux";
	if (useBwrap) {
		return new BwrapExecutionEnv({
			cwd: options.cwd,
			workspace: options.cwd,
			networkDisabled: options.networkDisabled ?? true,
			shellPath: options.shellPath,
		});
	}
	return new NodeExecutionEnv({ cwd: options.cwd, shellPath: options.shellPath });
}
