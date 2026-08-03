import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { BwrapExecutionEnv } from "./bwrap-execution-env.ts";
import { GuardedExecutionEnv } from "./guarded-execution-env.ts";

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
 * - Linux 且 enabled=true → {@link BwrapExecutionEnv}（生产 namespace 隔离）。
 * - 其它情况（macOS 开发 / disabled）→ {@link NodeExecutionEnv}（直接执行）。
 *
 * **无论哪种，最外层都套一层 {@link GuardedExecutionEnv}**：在 exec 前拦截泄露性命令
 * （curl/wget 外发、ifconfig/hostname 探测、读 ~/.ssh 凭证、读 API key 环境变量等）。
 * 这是纵深防御的一层——开发环境无 bwrap 时它仍是硬护栏；生产环境与断网/只读根配合。
 */
export function createExecutionEnv(options: EnvFactoryOptions): ExecutionEnv {
	const useBwrap = options.enabled && process.platform === "linux";
	const base: ExecutionEnv = useBwrap
		? new BwrapExecutionEnv({
				cwd: options.cwd,
				workspace: options.cwd,
				networkDisabled: options.networkDisabled ?? true,
				shellPath: options.shellPath,
			})
		: new NodeExecutionEnv({ cwd: options.cwd, shellPath: options.shellPath });
	return new GuardedExecutionEnv(base);
}
