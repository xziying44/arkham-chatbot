import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	err,
	ExecutionError,
	FileError,
	ok,
	type ExecutionEnv,
	type FileInfo,
	type Result,
	type ShellExecOptions,
} from "@earendil-works/pi-agent-core";

export interface ScopedExecutionEnvOptions {
	/** 当前群或私聊唯一的持久化工作目录。 */
	readonly workspace: string;
	/** 宿主路径到沙箱可见路径的显式只读挂载。 */
	readonly readOnlyBinds?: readonly (readonly [string, string])[];
	/** bash 未指定 timeout 时使用的默认超时秒数。 */
	readonly defaultTimeoutSeconds?: number;
}

interface ScopedMount {
	readonly hostRoot: string;
	readonly virtualRoot: string;
}

interface ResolvedScopedPath {
	readonly virtualPath: string;
	readonly hostPath: string;
	readonly virtualRoot: string;
	readonly hostRoot: string;
	readonly readOnly: boolean;
}

/**
 * 为 ExecutionEnv 增加不可绕过的 scope 文件系统边界。
 *
 * pi 的 NodeExecutionEnv 接受绝对路径和 `..`，BubblewrapExecutionEnv 又只覆写了
 * exec，因此仅靠 cwd 不能限制 read/edit/write。此包装器在所有文件 API 前统一做：
 * 1. 虚拟路径归一化；2. workspace/显式挂载白名单匹配；3. realpath 防符号链接逃逸；
 * 4. 只读挂载写保护。内部 env 永远只收到校验后的宿主路径。
 */
export class ScopedExecutionEnv implements ExecutionEnv {
	readonly cwd: string;
	private readonly inner: ExecutionEnv;
	private readonly mounts: ScopedMount[];
	private readonly defaultTimeoutSeconds: number | undefined;
	private operationTail: Promise<void> = Promise.resolve();

	constructor(inner: ExecutionEnv, options: ScopedExecutionEnvOptions) {
		this.inner = inner;
		this.cwd = resolve(options.workspace);
		this.defaultTimeoutSeconds = options.defaultTimeoutSeconds;
		this.mounts = (options.readOnlyBinds ?? [])
			.map(([host, virtual]) => ({
				hostRoot: resolve(host),
				virtualRoot: isAbsolute(virtual) ? resolve(virtual) : resolve(this.cwd, virtual),
			}))
			.sort((a, b) => b.virtualRoot.length - a.virtualRoot.length);
	}

	exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		return this.runExclusive(() => this.execUnlocked(command, options));
	}

	private async execUnlocked(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		if (options?.abortSignal?.aborted) {
			return err(new ExecutionError("aborted", "命令已取消"));
		}
		let cwd = this.cwd;
		if (options?.cwd) {
			const resolved = this.resolveLexical(options.cwd);
			if (!resolved.ok || resolved.value.readOnly || !isWithin(this.cwd, resolved.value.virtualPath)) {
				return err(new ExecutionError("spawn_error", `沙箱拒绝使用工作目录之外的 cwd：${options.cwd}`));
			}
			const checked = await this.validateCanonical(resolved.value, false);
			if (!checked.ok) return err(new ExecutionError("spawn_error", checked.error.message, checked.error));
			cwd = resolved.value.virtualPath;
		}
		return this.inner.exec(command, {
			...options,
			cwd,
			timeout: options?.timeout ?? this.defaultTimeoutSeconds,
		});
	}

	async absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		if (abortSignal?.aborted) return abortedFile(path);
		const resolved = this.resolveLexical(path);
		return resolved.ok ? ok(resolved.value.virtualPath) : resolved;
	}

	async joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.absolutePath(join(...parts), abortSignal);
	}

	readTextFile(path: string, abortSignal?: AbortSignal) {
		return this.runExclusive(async () => {
			const resolved = await this.resolveForRead(path, abortSignal);
			if (!resolved.ok) return resolved;
			const result = await this.inner.readTextFile(resolved.value.hostPath, abortSignal);
			return this.remapFileResult(result, resolved.value);
		});
	}

	readTextLines(path: string, options?: { maxLines?: number; abortSignal?: AbortSignal }) {
		return this.runExclusive(async () => {
			const resolved = await this.resolveForRead(path, options?.abortSignal);
			if (!resolved.ok) return resolved;
			const result = await this.inner.readTextLines(resolved.value.hostPath, options);
			return this.remapFileResult(result, resolved.value);
		});
	}

	readBinaryFile(path: string, abortSignal?: AbortSignal) {
		return this.runExclusive(async () => {
			const resolved = await this.resolveForRead(path, abortSignal);
			if (!resolved.ok) return resolved;
			const result = await this.inner.readBinaryFile(resolved.value.hostPath, abortSignal);
			return this.remapFileResult(result, resolved.value);
		});
	}

	writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal) {
		return this.runExclusive(async () => {
			const resolved = await this.resolveForWrite(path, abortSignal);
			if (!resolved.ok) return resolved;
			const result = await this.inner.writeFile(resolved.value.hostPath, content, abortSignal);
			return this.remapFileResult(result, resolved.value);
		});
	}

	appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal) {
		return this.runExclusive(async () => {
			const resolved = await this.resolveForWrite(path, abortSignal);
			if (!resolved.ok) return resolved;
			const result = await this.inner.appendFile(resolved.value.hostPath, content, abortSignal);
			return this.remapFileResult(result, resolved.value);
		});
	}

	fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>> {
		return this.runExclusive(async () => {
			const resolved = await this.resolveForRead(path, abortSignal);
			if (!resolved.ok) return resolved;
			const info = await this.inner.fileInfo(resolved.value.hostPath, abortSignal);
			return info.ok
				? ok({ ...info.value, path: resolved.value.virtualPath })
				: this.remapFileResult(info, resolved.value);
		});
	}

	listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
		return this.runExclusive(async () => {
			const resolved = await this.resolveForRead(path, abortSignal);
			if (!resolved.ok) return resolved;
			const listed = await this.inner.listDir(resolved.value.hostPath, abortSignal);
			if (!listed.ok) return this.remapFileResult(listed, resolved.value);
			return ok(listed.value.map((info) => ({
				...info,
				path: resolve(resolved.value.virtualRoot, relative(resolved.value.hostRoot, info.path)),
			})));
		});
	}

	canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.runExclusive(async () => {
			const resolved = await this.resolveForRead(path, abortSignal);
			if (!resolved.ok) return resolved;
			try {
				const [rootReal, targetReal] = await Promise.all([
					realpath(resolved.value.hostRoot),
					realpath(resolved.value.hostPath),
				]);
				return ok(resolve(resolved.value.virtualRoot, relative(rootReal, targetReal)));
			} catch (error) {
				return err(toFileError(error, resolved.value.virtualPath));
			}
		});
	}

	exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>> {
		return this.runExclusive(async () => {
			if (abortSignal?.aborted) return abortedFile(path);
			const resolved = this.resolveLexical(path);
			if (!resolved.ok) return resolved;
			const exists = await this.inner.exists(resolved.value.hostPath, abortSignal);
			if (!exists.ok) return this.remapFileResult(exists, resolved.value);
			if (!exists.value) return exists;
			const checked = await this.validateCanonical(resolved.value, false);
			return checked.ok ? ok(true) : checked;
		});
	}

	createDir(path: string, options?: { recursive?: boolean; abortSignal?: AbortSignal }) {
		return this.runExclusive(async () => {
			const resolved = await this.resolveForWrite(path, options?.abortSignal);
			if (!resolved.ok) return resolved;
			const result = await this.inner.createDir(resolved.value.hostPath, options);
			return this.remapFileResult(result, resolved.value);
		});
	}

	remove(path: string, options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal }) {
		return this.runExclusive(async () => {
			const resolved = await this.resolveForWrite(path, options?.abortSignal);
			if (!resolved.ok) return resolved;
			const result = await this.inner.remove(resolved.value.hostPath, options);
			return this.remapFileResult(result, resolved.value);
		});
	}

	createTempDir(prefix = "tmp-", abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		return this.runExclusive(() => this.createTempDirUnlocked(prefix, abortSignal));
	}

	private async createTempDirUnlocked(prefix: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		if (abortSignal?.aborted) return abortedFile(this.cwd);
		const tempRoot = join(this.cwd, ".tmp");
		const checked = await this.resolveForWrite(tempRoot, abortSignal);
		if (!checked.ok) return checked;
		try {
			await mkdir(tempRoot, { recursive: true });
			const safePrefix = prefix.replace(/[^a-zA-Z0-9._-]/g, "_");
			return ok(await mkdtemp(join(tempRoot, safePrefix)));
		} catch (error) {
			return err(toFileError(error, tempRoot));
		}
	}

	createTempFile(options?: {
		prefix?: string;
		suffix?: string;
		abortSignal?: AbortSignal;
	}): Promise<Result<string, FileError>> {
		return this.runExclusive(async () => {
			const dir = await this.createTempDirUnlocked("file-", options?.abortSignal);
			if (!dir.ok) return dir;
			const prefix = (options?.prefix ?? "").replace(/[^a-zA-Z0-9._-]/g, "_");
			const suffix = (options?.suffix ?? "").replace(/[^a-zA-Z0-9._-]/g, "_");
			const path = join(dir.value, `${prefix}${randomUUID()}${suffix}`);
			try {
				await writeFile(path, "", { signal: options?.abortSignal });
				return ok(path);
			} catch (error) {
				return err(toFileError(error, path));
			}
		});
	}

	async cleanup(): Promise<void> {
		await this.runExclusive(async () => {
			// workspace 是持久化数据，cleanup 只终止内部执行环境的进程，不删除文件。
			await this.inner.cleanup().catch(() => {});
		});
	}

	/** 串行化 shell 与文件操作，关闭并行工具调用制造符号链接竞态的窗口。 */
	private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationTail.then(operation, operation);
		this.operationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	/** 只读挂载的底层错误不得暴露宿主源路径。 */
	private remapFileResult<T>(
		result: Result<T, FileError>,
		resolved: ResolvedScopedPath,
	): Result<T, FileError> {
		if (result.ok || resolved.hostPath === resolved.virtualPath) return result;
		return err(new FileError(
			result.error.code,
			fileErrorMessage(result.error.code, resolved.virtualPath),
			resolved.virtualPath,
		));
	}

	private async resolveForRead(
		path: string,
		abortSignal?: AbortSignal,
	): Promise<Result<ResolvedScopedPath, FileError>> {
		if (abortSignal?.aborted) return abortedFile(path);
		const resolved = this.resolveLexical(path);
		if (!resolved.ok) return resolved;
		const checked = await this.validateCanonical(resolved.value, false);
		return checked.ok ? resolved : checked;
	}

	private async resolveForWrite(
		path: string,
		abortSignal?: AbortSignal,
	): Promise<Result<ResolvedScopedPath, FileError>> {
		if (abortSignal?.aborted) return abortedFile(path);
		const resolved = this.resolveLexical(path);
		if (!resolved.ok) return resolved;
		if (resolved.value.readOnly) {
			return err(new FileError("permission_denied", `只读挂载禁止修改：${path}`, resolved.value.virtualPath));
		}
		const checked = await this.validateCanonical(resolved.value, true);
		return checked.ok ? resolved : checked;
	}

	private resolveLexical(path: string): Result<ResolvedScopedPath, FileError> {
		if (!path || path.includes("\0")) {
			return err(new FileError("invalid", "文件路径为空或包含非法字符", path));
		}
		const virtualPath = isAbsolute(path) ? resolve(path) : resolve(this.cwd, path);
		for (const mount of this.mounts) {
			if (!isWithin(mount.virtualRoot, virtualPath)) continue;
			const rel = relative(mount.virtualRoot, virtualPath);
			const hostPath = resolve(mount.hostRoot, rel);
			if (!isWithin(mount.hostRoot, hostPath)) {
				return err(new FileError("permission_denied", `路径越出只读挂载：${path}`, virtualPath));
			}
			return ok({
				virtualPath,
				hostPath,
				virtualRoot: mount.virtualRoot,
				hostRoot: mount.hostRoot,
				readOnly: true,
			});
		}
		if (!isWithin(this.cwd, virtualPath)) {
			return err(new FileError("permission_denied", `路径不在当前会话沙箱内：${path}`, virtualPath));
		}
		return ok({
			virtualPath,
			hostPath: virtualPath,
			virtualRoot: this.cwd,
			hostRoot: this.cwd,
			readOnly: false,
		});
	}

	private async validateCanonical(
		resolved: ResolvedScopedPath,
		allowMissingTarget: boolean,
	): Promise<Result<void, FileError>> {
		try {
			const rootReal = await realpath(resolved.hostRoot);
			let probe = resolved.hostPath;
			while (true) {
				try {
					const probeReal = await realpath(probe);
					if (!isWithin(rootReal, probeReal)) {
						return err(new FileError(
							"permission_denied",
							`符号链接越出当前会话沙箱：${resolved.virtualPath}`,
							resolved.virtualPath,
						));
					}
					return ok(undefined);
				} catch (error) {
					if (!allowMissingTarget || !isNotFound(error)) {
						return err(toFileError(error, resolved.virtualPath));
					}
					const parent = dirname(probe);
					if (parent === probe || !isWithin(resolved.hostRoot, parent)) {
						return err(new FileError("permission_denied", "无法确认目标路径位于沙箱内", resolved.virtualPath));
					}
					probe = parent;
				}
			}
		} catch (error) {
			return err(toFileError(error, resolved.virtualPath));
		}
	}
}

function isWithin(root: string, candidate: string): boolean {
	const normalizedRoot = resolve(root);
	const normalizedCandidate = resolve(candidate);
	return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function isNotFound(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function abortedFile(path: string): Result<never, FileError> {
	return err(new FileError("aborted", "文件操作已取消", path));
}

function fileErrorMessage(code: FileError["code"], path: string): string {
	switch (code) {
		case "aborted": return `文件操作已取消：${path}`;
		case "not_found": return `文件不存在：${path}`;
		case "permission_denied": return `没有权限访问：${path}`;
		case "not_directory": return `路径不是目录：${path}`;
		case "is_directory": return `路径是目录：${path}`;
		case "invalid": return `文件路径无效：${path}`;
		case "not_supported": return `文件操作不受支持：${path}`;
		case "unknown": return `文件操作失败：${path}`;
	}
}

function toFileError(error: unknown, path: string): FileError {
	const code = error instanceof Error && "code" in error
		? (error as NodeJS.ErrnoException).code
		: undefined;
	if (code === "ENOENT") return new FileError("not_found", `文件不存在：${path}`, path, error as Error);
	if (code === "EACCES" || code === "EPERM") {
		return new FileError("permission_denied", `没有权限访问：${path}`, path, error as Error);
	}
	if (code === "ENOTDIR") return new FileError("not_directory", `路径不是目录：${path}`, path, error as Error);
	if (code === "EISDIR") return new FileError("is_directory", `路径是目录：${path}`, path, error as Error);
	return new FileError("unknown", error instanceof Error ? error.message : String(error), path, error instanceof Error ? error : undefined);
}
