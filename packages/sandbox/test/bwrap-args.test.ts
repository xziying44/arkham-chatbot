import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildBwrapArgs } from "../src/bwrap-args.ts";

/**
 * 验证 bwrap argv 的构造。纯函数测试，不依赖 bwrap 二进制或特定平台。
 */
test("buildBwrapArgs: 默认严格（断网 + 只读系统根 + 读写工作目录）", () => {
	const args = buildBwrapArgs({ workspace: "/data/groups/g1/workspace" });
	// 系统根只读
	assert.ok(args.includes("--ro-bind"));
	const roIdx = args.indexOf("--ro-bind");
	assert.equal(args[roIdx + 1], "/");
	assert.equal(args[roIdx + 2], "/");
	// 工作目录读写
	const bindIdx = args.indexOf("--bind");
	assert.ok(bindIdx > -1);
	assert.equal(args[bindIdx + 1], "/data/groups/g1/workspace");
	assert.equal(args[bindIdx + 2], "/data/groups/g1/workspace");
	// 默认断网
	assert.ok(args.includes("--unshare-net"));
	// die-with-parent 与 unshare-pid
	assert.ok(args.includes("--die-with-parent"));
	assert.ok(args.includes("--unshare-pid"));
	// 必要伪文件系统
	assert.ok(args.includes("/dev"));
	assert.ok(args.includes("/proc"));
	assert.ok(args.includes("/tmp"));
});

test("buildBwrapArgs: networkDisabled=false 时不断网", () => {
	const args = buildBwrapArgs({ workspace: "/w", networkDisabled: false });
	assert.ok(!args.includes("--unshare-net"));
});

test("buildBwrapArgs: 额外挂载按顺序追加", () => {
	const args = buildBwrapArgs({
		workspace: "/w",
		readOnlyBinds: [["/usr/local", "/usr/local"]],
		writableBinds: [["/var/log", "/var/log"]],
	});
	assert.ok(args.includes("--ro-bind"));
	assert.ok(args.indexOf("/usr/local") > -1);
	assert.ok(args.indexOf("/var/log") > -1);
	// 读写在 ro 之后（顺序：根 ro → workspace rw → extra ro → extra rw）
	const lastRoBind = args.lastIndexOf("--ro-bind");
	const lastBind = args.lastIndexOf("--bind");
	assert.ok(lastBind > lastRoBind || lastRoBind === args.indexOf("--ro-bind"));
});
