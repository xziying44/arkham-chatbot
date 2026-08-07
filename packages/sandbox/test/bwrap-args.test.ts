import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBwrapArgs } from "../src/bwrap-args.ts";

function hasTriplet(args: string[], option: string, source: string, target: string): boolean {
	return args.some((value, index) => (
		value === option && args[index + 1] === source && args[index + 2] === target
	));
}

test("buildBwrapArgs: 使用最小只读运行时且不挂载宿主根目录", () => {
	const args = buildBwrapArgs({ workspace: "/data/groups/g1/workspace" });

	assert.equal(hasTriplet(args, "--ro-bind", "/", "/"), false);
	assert.equal(hasTriplet(args, "--ro-bind-try", "/usr", "/usr"), true);
	assert.equal(hasTriplet(args, "--ro-bind-try", "/lib", "/lib"), true);
	assert.equal(hasTriplet(args, "--ro-bind-try", "/etc/passwd", "/etc/passwd"), true);
});

test("buildBwrapArgs: workspace 是唯一读写挂载", () => {
	const args = buildBwrapArgs({
		workspace: "/data/groups/g1/workspace",
		readOnlyBinds: [["/srv/skills", "/data/groups/g1/workspace/skills"]],
	});
	const bindIndexes = args.flatMap((value, index) => value === "--bind" ? [index] : []);

	assert.equal(bindIndexes.length, 1);
	const bindIndex = bindIndexes[0]!;
	assert.equal(args[bindIndex + 1], "/data/groups/g1/workspace");
	assert.equal(args[bindIndex + 2], "/data/groups/g1/workspace");
	assert.equal(
		hasTriplet(args, "--ro-bind", "/srv/skills", "/data/groups/g1/workspace/skills"),
		true,
	);
});

test("buildBwrapArgs: 默认隔离网络、进程、IPC 和主机名", () => {
	const args = buildBwrapArgs({ workspace: "/w" });

	for (const option of [
		"--unshare-net",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--new-session",
		"--die-with-parent",
	]) {
		assert.ok(args.includes(option), `缺少隔离参数：${option}`);
	}
	assert.ok(args.includes("/dev"));
	assert.ok(args.includes("/proc"));
	assert.ok(args.includes("/tmp"));
	assert.ok(args.includes("/run"));
});

test("buildBwrapArgs: networkDisabled=false 时保留网络", () => {
	const args = buildBwrapArgs({ workspace: "/w", networkDisabled: false });
	assert.equal(args.includes("--unshare-net"), false);
});
