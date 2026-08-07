import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";

test("默认提示词目录不受启动工作目录影响", async () => {
	const originalCwd = process.cwd();
	const originalPromptsDir = process.env.CHATBOT_PROMPTS_DIR;
	const originalDataDir = process.env.CHATBOT_DATA_DIR;
	const originalDbPath = process.env.CHATBOT_DB_PATH;
	const cwd = await mkdtemp(join(tmpdir(), "arkham-config-"));
	try {
		delete process.env.CHATBOT_PROMPTS_DIR;
		process.env.CHATBOT_DATA_DIR = "./data";
		process.env.CHATBOT_DB_PATH = "./data/chatbot.db";
		process.chdir(cwd);
		const config = loadConfig();
		assert.equal(
			config.promptsDir,
			fileURLToPath(new URL("../../../prompts", import.meta.url)),
		);
		assert.equal(
			config.dataDir,
			fileURLToPath(new URL("../../../data", import.meta.url)),
		);
		assert.equal(
			config.dbPath,
			fileURLToPath(new URL("../../../data/chatbot.db", import.meta.url)),
		);
	} finally {
		process.chdir(originalCwd);
		if (originalPromptsDir === undefined) delete process.env.CHATBOT_PROMPTS_DIR;
		else process.env.CHATBOT_PROMPTS_DIR = originalPromptsDir;
		if (originalDataDir === undefined) delete process.env.CHATBOT_DATA_DIR;
		else process.env.CHATBOT_DATA_DIR = originalDataDir;
		if (originalDbPath === undefined) delete process.env.CHATBOT_DB_PATH;
		else process.env.CHATBOT_DB_PATH = originalDbPath;
		await rm(cwd, { recursive: true, force: true });
	}
});
