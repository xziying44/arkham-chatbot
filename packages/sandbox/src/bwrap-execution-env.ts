import { type ChildProcess, spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { ExecutionError, err, ok, toError } from "@earendil-works/pi-agent-core";
import type { Result, ShellExecOptions } from "@earendil-works/pi-agent-core";
import { buildBwrapArgs, type BwrapOptions } from "./bwrap-args.ts";

/**
 * 基于 Bubblewrap 的沙箱执行环境。
 *
 * 继承 {@link NodeExecutionEnv} 复用全部文件系统方法（它们直接作用于宿主的群工作目录，
 * 无需沙箱化），**仅覆写 {@link exec}**：每条 bash 命令都被 `bwrap` 包裹进独立的 Linux
 * namespace（只读系统、读写群目录、断网、随宿主退出）执行。这样 pi 的 `createBashTool`
 * 注入此 env 后，所有网友触发的命令自动获得隔离，而 read/edit/write 仍零开销直达。
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
		super({ cwd: options.cwd, shellPath: options.shellPath, shellEnv: options.shellEnv });
		this.sandboxShellEnv = options.shellEnv;
		// bwrap 配置：剥离 cwd/shell 等非 bwrap 字段。
		this.bwrap = {
			workspace: options.workspace,
			networkDisabled: options.networkDisabled,
			readOnlyBinds: options.readOnlyBinds,
			writableBinds: options.writableBinds,
		};
		this.sandboxShellPath = options.shellPath ?? "/bin/bash";
	}

	override async exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		if (options?.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));

		const timeoutSec = options?.timeout;
		if (timeoutSec !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec <= 0)) {
			return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
		}
		const timeoutMs = timeoutSec !== undefined ? timeoutSec * 1000 : undefined;

		const cwd = options?.cwd ? this.resolveCwd(options.cwd) : this.cwd;
		try {
			await access(cwd, constants.F_OK);
		} catch (error) {
			return err(
				new ExecutionError("spawn_error", `Working directory does not exist: ${cwd}`, toError(error)),
			);
		}

		// 组装：bwrap <args...> <shell> -c "<command>"
		const bwrapArgs = buildBwrapArgs({ ...this.bwrap, workspace: cwd });
		const argv = [...bwrapArgs, this.sandboxShellPath, "-c", command];

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
						/* already dead */
					}
				}
			};

			const onAbort = () => killTree();

			try {
				child = spawn(BWRAP_BIN, argv, {
					cwd,
					detached: true,
					env: options?.inheritEnv === false
						? { ...this.sandboxShellEnv, ...options?.env }
						: { ...process.env, ...this.sandboxShellEnv, ...options?.env },
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
					settle(err(new ExecutionError("timeout", `timeout:${options?.timeout}`)));
					return;
				}
				if (options?.abortSignal?.aborted) {
					settle(err(new ExecutionError("aborted", "aborted")));
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
