import type { ExecutionEnv, ShellExecOptions } from "@earendil-works/pi-agent-core";
import { reviewCommand } from "./command-guard.ts";
import { sanitizeShellEnv } from "./sanitize-shell-env.ts";

/**
 * 命令审查包装器：在任何 {@link ExecutionEnv} 之上拦截 exec，执行前先过安全审查。
 *
 * 文件系统方法原样透传，因此 inner 必须是 ScopedExecutionEnv 等已经实施硬边界的实现。
 * 本类只负责命令模式审查和环境变量净化，不单独承担文件隔离。
 *
 * 用法（env-factory 里）：所有由工厂产出的 env 都套一层 GuardedExecutionEnv，
 * 保证生产（bwrap）和开发（NodeExecutionEnv）统一获得命令护栏。
 */
export class GuardedExecutionEnv implements ExecutionEnv {
	private readonly inner: ExecutionEnv;
	/** cwd 透传给被包装 env（接口要求可读写的 cwd 属性）。 */
	cwd: string;

	constructor(inner: ExecutionEnv) {
		this.inner = inner;
		this.cwd = inner.cwd;
	}

	/** exec 是唯一拦截点：审查通过才透传给被包装 env。 */
	exec(command: string, options?: ShellExecOptions) {
		const decision = reviewCommand(command);
		if (!decision.allowed) {
			// 返回"成功执行但被策略拒绝"的结果，让 agent 看到明确拒绝原因，
			// 而非当成系统错误（错误可能让 agent 重试或绕路）。
			return Promise.resolve({
				ok: true as const,
				value: {
					stdout: "",
					stderr: `[沙箱拒绝] ${decision.reason}\n`,
					exitCode: 126, // 126 借用语义：command found but not executable
				},
			});
		}
		return this.inner.exec(command, {
			...options,
			// 敏感环境变量（API key/token/secret）物理剔除，不随 process.env 进沙箱。
			// 护栏正则只是第二层——可绕过（awk ENVIRON / /proc/self/environ），这里根治。
			// 调用方显式传的 options.env 原样附加（由调用方自己负责）。
			inheritEnv: false,
			env: { ...sanitizeShellEnv(), ...options?.env },
		});
	}

	// ---- 文件系统方法：透传 ----
	absolutePath(path: string, abortSignal?: AbortSignal) {
		return this.inner.absolutePath(path, abortSignal);
	}
	joinPath(parts: string[], abortSignal?: AbortSignal) {
		return this.inner.joinPath(parts, abortSignal);
	}
	readTextFile(path: string, abortSignal?: AbortSignal) {
		return this.inner.readTextFile(path, abortSignal);
	}
	readTextLines(path: string, options?: { maxLines?: number; abortSignal?: AbortSignal }) {
		return this.inner.readTextLines(path, options);
	}
	readBinaryFile(path: string, abortSignal?: AbortSignal) {
		return this.inner.readBinaryFile(path, abortSignal);
	}
	writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal) {
		return this.inner.writeFile(path, content, abortSignal);
	}
	appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal) {
		return this.inner.appendFile(path, content, abortSignal);
	}
	fileInfo(path: string, abortSignal?: AbortSignal) {
		return this.inner.fileInfo(path, abortSignal);
	}
	listDir(path: string, abortSignal?: AbortSignal) {
		return this.inner.listDir(path, abortSignal);
	}
	canonicalPath(path: string, abortSignal?: AbortSignal) {
		return this.inner.canonicalPath(path, abortSignal);
	}
	exists(path: string, abortSignal?: AbortSignal) {
		return this.inner.exists(path, abortSignal);
	}
	createDir(path: string, options?: { recursive?: boolean; abortSignal?: AbortSignal }) {
		return this.inner.createDir(path, options);
	}
	remove(path: string, options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal }) {
		return this.inner.remove(path, options);
	}
	createTempDir(prefix?: string, abortSignal?: AbortSignal) {
		return this.inner.createTempDir(prefix, abortSignal);
	}
	createTempFile(options?: { prefix?: string; suffix?: string; abortSignal?: AbortSignal }) {
		return this.inner.createTempFile(options);
	}
	async cleanup(): Promise<void> {
		await this.inner.cleanup();
	}
}
