/**
 * 构建 Bubblewrap (bwrap) 命令行参数。
 *
 * 纯函数，无副作用，便于单测断言产出的 argv。
 *
 * 沙箱策略（默认严格）：
 * - 空根文件系统 + 最小运行时只读挂载：宿主 `/home`、项目源码和凭据默认不可见。
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
}

/** 命令运行所需的系统目录。不存在的目录由 bwrap 安全忽略。 */
const RUNTIME_DIRECTORIES = [
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/etc/alternatives",
	"/etc/fonts",
	"/etc/ssl/certs",
	"/etc/ca-certificates",
	"/var/cache/fontconfig",
] as const;

/** 动态链接、用户解析、时区和可选联网所需的非敏感系统文件。 */
const RUNTIME_FILES = [
	"/etc/ld.so.cache",
	"/etc/ld.so.conf",
	"/etc/ld.so.conf.d",
	"/etc/passwd",
	"/etc/group",
	"/etc/nsswitch.conf",
	"/etc/hosts",
	"/etc/host.conf",
	"/etc/resolv.conf",
	"/etc/localtime",
	"/etc/timezone",
] as const;

/**
 * 构建完整 bwrap argv 前缀，调用方在其后追加 `<shell> -c <command>`。
 *
 * @returns argv 片段（不含 `--chdir`、shell 与命令本身）。
 */
export function buildBwrapArgs(options: BwrapOptions): string[] {
	const args: string[] = [];

	// 1) 从空根开始，只挂载命令运行所需的非敏感系统资源。
	for (const path of [...RUNTIME_DIRECTORIES, ...RUNTIME_FILES]) {
		args.push("--ro-bind-try", path, path);
	}

	// 2) 先建立伪文件系统，随后挂载的 workspace 即使位于 /tmp 下也不会被遮蔽。
	args.push("--dev", "/dev");
	args.push("--proc", "/proc");
	args.push("--tmpfs", "/tmp");
	args.push("--dir", "/run");

	// 3) 群工作目录是唯一读写挂载，业务资源只能显式只读挂载。
	args.push("--bind", options.workspace, options.workspace);
	for (const [host, container] of options.readOnlyBinds ?? []) {
		args.push("--ro-bind", host, container);
	}

	// 4) 进程、IPC、主机名和会话隔离。
	args.push("--die-with-parent");
	args.push("--new-session");
	args.push("--unshare-pid");
	args.push("--unshare-ipc");
	args.push("--unshare-uts");

	// 5) 网络：默认断网。
	if (options.networkDisabled ?? true) {
		args.push("--unshare-net");
	}

	return args;
}
