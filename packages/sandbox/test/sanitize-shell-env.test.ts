import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeShellEnv } from "../src/sanitize-shell-env.ts";
import { GuardedExecutionEnv } from "../src/guarded-execution-env.ts";
import type { ExecutionEnv, ShellExecOptions } from "@earendil-works/pi-agent-core";

test("sanitizeShellEnv: 剔除 key/token/secret/password 类变量", () => {
	const env = sanitizeShellEnv({
		PATH: "/usr/bin",
		HOME: "/home/x",
		MINIMAX_API_KEY: "sk-x",
		ANTHROPIC_AUTH_TOKEN: "sk-y",
		QQ_APP_SECRET: "z",
		DEEPSEEK_API_KEY: "sk-d",
		ADMIN_PASSWORD: "p",
		DATABASE_URL: "u", // 不含敏感后缀，保留（其值敏感由护栏正则管）
		CHATBOT_MODEL: "anthropic/x",
	});
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.HOME, "/home/x");
	assert.equal(env.CHATBOT_MODEL, "anthropic/x");
	for (const k of ["MINIMAX_API_KEY", "ANTHROPIC_AUTH_TOKEN", "QQ_APP_SECRET", "DEEPSEEK_API_KEY", "ADMIN_PASSWORD"]) {
		assert.ok(!(k in env), `应剔除: ${k}`);
	}
});

test("GuardedExecutionEnv: exec 强制 inheritEnv=false 且环境已净化", async () => {
	process.env.MINIMAX_API_KEY = "sk-should-not-leak";
	let captured: ShellExecOptions | undefined;
	const fakeInner = {
		cwd: "/tmp",
		exec: (_cmd: string, options?: ShellExecOptions) => {
			captured = options;
			return Promise.resolve({ ok: true as const, value: { stdout: "", stderr: "", exitCode: 0 } });
		},
	} as unknown as ExecutionEnv;
	const env = new GuardedExecutionEnv(fakeInner);
	const result = await env.exec("ls");
	assert.equal(result.ok, true);
	assert.equal(captured?.inheritEnv, false);
	assert.ok(captured?.env);
	assert.ok(!("MINIMAX_API_KEY" in captured!.env!), "MINIMAX_API_KEY 不得进入沙箱子进程环境");
	assert.ok("PATH" in captured!.env! || "HOME" in captured!.env!, "PATH/HOME 等必需变量应保留");
	delete process.env.MINIMAX_API_KEY;
});
