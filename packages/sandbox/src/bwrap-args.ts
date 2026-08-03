/**
 * 构建 Bubblewrap (bwrap) 命令行参数。
 *
 * 纯函数，无副作用，便于单测断言产出的 argv。
 *
 * 沙箱策略（默认严格）：
 * - 系统根目录只读挂载（`--ro-bind / /`）：命令能用系统工具（node/python/...）但不能改系统。
 * - 群工作目录读写挂载（`--bind <workspace> <workspace>`）：agent 读写文件的范围。
 * - 断网（`--unshare-net`，可配）：防止恶意命令把数据外发或拉取远程载荷。
 * - `--die-with-parent`：宿主退出即杀沙箱进程，避免孤儿。
 * - `/dev` `/proc` 必要伪文件系统：让命令能正常 fork、读伪设备。
 * - `/tmp` 独立 tmpfs：避免写穿宿主临时目录。
 *
 * bwrap 本身不限制 CPU/内存（只做 namespace 隔离）；资源上限靠调用方配合
 * timeout / systemd-run，这里默认提供 timeout 透传。
 */
export interface BwrapOptions {
	/** 读写挂载的工作目录（沙箱内同路径可见）。 */
	readonly workspace: string;
	/** 是否断网，默认 true。 */
	readonly networkDisabled?: boolean;
	/** 额外的只读挂载（host:container），默认空。 */
	readonly readOnlyBinds?: readonly (readonly [string, string])[];
	/** 额外的读写挂载（host:container），默认空。 */
	readonly writableBinds?: readonly (readonly [string, string])[];
}

/**
 * 构建完整 bwrap argv 前缀，调用方在其后追加 `<shell> -c <command>`。
 *
 * @returns argv 片段（不含 shell 与命令本身），如 ["--ro-bind","/","/", ...]
 */
export function buildBwrapArgs(options: BwrapOptions): string[] {
	const args: string[] = [];

	// 1) 系统根目录只读。
	args.push("--ro-bind", "/", "/");

	// 2) 群工作目录读写。路径在沙箱内外一致，agent 看到的 cwd 即真实路径。
	args.push("--bind", options.workspace, options.workspace);

	// 3) 额外的只读/读写挂载。
	for (const [host, container] of options.readOnlyBinds ?? []) {
		args.push("--ro-bind", host, container);
	}
	for (const [host, container] of options.writableBinds ?? []) {
		args.push("--bind", host, container);
	}

	// 4) 必要的伪文件系统。
	args.push("--dev", "/dev");
	args.push("--proc", "/proc");
	// /tmp 用独立 tmpfs，避免与宿主共享。
	args.push("--tmpfs", "/tmp");

	// 5) 进程隔离策略：随宿主退出、新建会话。
	args.push("--die-with-parent");
	args.push("--unshare-pid");

	// 6) 网络：默认断网。
	if (options.networkDisabled ?? true) {
		args.push("--unshare-net");
	}

	return args;
}
