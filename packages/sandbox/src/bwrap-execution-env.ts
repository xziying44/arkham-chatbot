import { type ChildProcess, spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { ExecutionError, err, ok, toError } from "@earendil-works/pi-agent-core";
import type { Result, ShellExecOptions } from "@earendil-works/pi-agent-core";
import { buildBwrapArgs, type BwrapOptions } from "./bwrap-args.ts";

/**
 * 基于 Bubblewrap 的沙箱执行环境。
 *
 * 继承 {@link NodeExecutionEnv} 复用文件系统实现，并覆写 {@link exec}：每条 bash 命令都被
 * `bwrap` 包裹进独立 Linux namespace。文件系统边界由外层 ScopedExecutionEnv 统一执行，
 * 不能直接把本类暴露给不可信 agent。
 *
 * 与父类的唯一行为差异在 exec 的命令执行边界；超时、abort、stdout/stderr 捕获语义保持一致。
 */
export interface BwrapExecutionEnvOptions extends BwrapOptions {
	cwd: string;
	/** 自定义 shell 路径（沙箱内），默认 /bin/bash。 */
	shellPath?: string;
	/** 额外环境变量基线。 */
	shellEnv?: NodeJS.ProcessEnv;
}

const BWRAP_BIN = "bwrap";

export class BwrapExecutionEnv extends NodeExecutionEnv {
	private readonly bwrap: BwrapOptions;
	private readonly sandboxShellPath: string;
	/** 自存一份 shellEnv（父类的为 private），供 exec 组装子进程环境。 */
	private readonly sandboxShellEnv: NodeJS.ProcessEnv | undefined;

	constructor(options: BwrapExecutionEnvOptions) {
		const workspace = resolve(options.workspace);
		super({ cwd: workspace, shellPath: options.shellPath, shellEnv: options.shellEnv });
		this.sandboxShellEnv = options.shellEnv;
		const nodeRuntimeBinds = runtimeBindsForNode(process.execPath);
		this.bwrap = {
			workspace,
			networkDisabled: options.networkDisabled,
			readOnlyBinds: [...nodeRuntimeBinds, ...(options.readOnlyBinds ?? [])],
		};
		this.sandboxShellPath = options.shellPath ?? "/bin/bash";
	}

	override async exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		if (options?.abortSignal?.aborted) return err(new ExecutionError("aborted", "命令已取消"));

		const timeoutSec = options?.timeout;
		if (timeoutSec !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec <= 0)) {
			return err(new ExecutionError("timeout", "超时时间必须是有限的正数秒"));
		}
		const timeoutMs = timeoutSec !== undefined ? timeoutSec * 1000 : undefined;

		const cwd = options?.cwd ? this.resolveCwd(options.cwd) : this.cwd;
		try {
			await access(cwd, constants.F_OK);
		} catch (error) {
			return err(
				new ExecutionError("spawn_error", `工作目录不存在：${cwd}`, toError(error)),
			);
		}

		// workspace 始终是唯一读写挂载；cwd 只决定命令进入后的目录。
		const bwrapArgs = buildBwrapArgs(this.bwrap);
		const argv = [...bwrapArgs, "--chdir", cwd, this.sandboxShellPath, "-c", command];

		return await new Promise((resolvePromise) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timedOut = false;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			let child: ChildProcess | undefined;

			const settle = (result: Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>) => {
				if (timeoutId) clearTimeout(timeoutId);
				options?.abortSignal?.removeEventListener("abort", onAbort);
				if (settled) return;
				settled = true;
				resolvePromise(result);
			};

			const killTree = () => {
				if (!child?.pid) return;
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					try {
						process.kill(child.pid, "SIGKILL");
					} catch {
						/* 进程已经退出。 */
					}
				}
			};

			const onAbort = () => killTree();

			try {
				const requestedEnv = options?.inheritEnv === false
					? { ...this.sandboxShellEnv, ...options?.env }
					: { ...process.env, ...this.sandboxShellEnv, ...options?.env };
				child = spawn(BWRAP_BIN, argv, {
					cwd,
					detached: true,
					env: {
						...requestedEnv,
						HOME: this.bwrap.workspace,
						TMPDIR: "/tmp",
						TMP: "/tmp",
						TEMP: "/tmp",
						XDG_CACHE_HOME: `${this.bwrap.workspace}/.cache`,
						XDG_CONFIG_HOME: `${this.bwrap.workspace}/.config`,
						XDG_DATA_HOME: `${this.bwrap.workspace}/.local/share`,
					},
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				settle(err(new ExecutionError("spawn_error", toError(error).message, toError(error))));
				return;
			}

			if (timeoutMs !== undefined) {
				timeoutId = setTimeout(() => {
					timedOut = true;
					killTree();
				}, timeoutMs);
			}

			if (options?.abortSignal) {
				if (options.abortSignal.aborted) killTree();
				else options.abortSignal.addEventListener("abort", onAbort, { once: true });
			}

			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
				options?.onStdout?.(chunk);
			});
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
				options?.onStderr?.(chunk);
			});

			child.once("error", (error) => {
				settle(err(new ExecutionError("spawn_error", error.message, error)));
			});
			child.once("close", (code) => {
				if (timedOut) {
					settle(err(new ExecutionError("timeout", `命令执行超时：${options?.timeout} 秒`)));
					return;
				}
				if (options?.abortSignal?.aborted) {
					settle(err(new ExecutionError("aborted", "命令已取消")));
					return;
				}
				settle(ok({ stdout, stderr, exitCode: code ?? 0 }));
			});
		});
	}

	private resolveCwd(path: string): string {
		return isAbsolute(path) ? resolve(path) : resolve(this.cwd, path);
	}
}

/** NVM 等非系统 Node 运行时需要显式只读挂载，确保 PATH 中的 node 仍可用。 */
function runtimeBindsForNode(execPath: string): readonly (readonly [string, string])[] {
	const normalized = resolve(execPath);
	if (isWithin("/usr", normalized) || isWithin("/bin", normalized)) return [];
	const runtimeRoot = dirname(dirname(normalized));
	return [[runtimeRoot, runtimeRoot]];
}

function isWithin(root: string, candidate: string): boolean {
	const normalizedRoot = resolve(root);
	const normalizedCandidate = resolve(candidate);
	return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}
