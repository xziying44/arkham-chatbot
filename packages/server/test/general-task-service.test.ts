import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBatchExecTool, createBatchWorkspaceTool } from "@arkham/chatbot-core";
import { createExecutionEnv } from "@arkham/chatbot-sandbox";
import { BatchToolCallBudget } from "../src/general-task-service.ts";

test("通用批量能力：读写受 scope 边界和命令护栏限制", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "arkham-general-tools-"));
	const workspace = join(root, "scope-a", "workspace");
	const env = await createExecutionEnv({
		enabled: false,
		cwd: workspace,
		networkDisabled: true,
		timeoutSeconds: 5,
	});
	t.after(async () => {
		await env.cleanup();
		await rm(root, { recursive: true, force: true });
	});

	const workspaceTool = createBatchWorkspaceTool(env);
	await workspaceTool.execute("write", {
		operations: [
			{ action: "write", path: "notes/a.txt", content: "甲" },
			{ action: "write", path: "notes/b.txt", content: "乙" },
		],
	}, undefined, () => {});
	const readResult = await workspaceTool.execute("read", {
		operations: [
			{ action: "read", path: "notes/a.txt" },
			{ action: "read", path: "notes/b.txt" },
			{ action: "read", path: "../../scope-b/secret.txt" },
		],
	}, undefined, () => {});
	const readDetails = readResult.details as Array<{ content?: string; error?: string }>;
	assert.equal(readDetails[0].content, "甲");
	assert.equal(readDetails[1].content, "乙");
	assert.match(readDetails[2].error ?? "", /不在当前会话沙箱内/);

	const execTool = createBatchExecTool(env);
	const execResult = await execTool.execute("exec", {
		commands: ["sudo true", "pwd"],
	}, undefined, () => {});
	const execDetails = execResult.details as Array<{ exitCode?: number; stderr?: string }>;
	assert.equal(execDetails[0].exitCode, 126);
	assert.match(execDetails[0].stderr ?? "", /沙箱拒绝/);
	assert.equal(execDetails[1].exitCode, 0);
});

test("通用批量能力：单轮只允许三次工具调用", () => {
	const budget = new BatchToolCallBudget(3);
	assert.equal(budget.take(), undefined);
	assert.equal(budget.take(), undefined);
	assert.equal(budget.take(), undefined);
	assert.deepEqual(budget.take(), {
		block: true,
		reason: "本轮最多允许3次批量能力调用",
	});
	assert.equal(budget.used, 3);
});
