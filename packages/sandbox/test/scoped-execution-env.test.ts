import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import {
	ExecutionError,
	FileError,
	ok,
	type Result,
	type ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { ScopedExecutionEnv } from "../src/scoped-execution-env.ts";

interface Fixture {
	root: string;
	workspace: string;
	outside: string;
}

async function createFixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "arkham-scoped-"));
	const workspace = join(root, "scope-a", "workspace");
	const outside = join(root, "scope-b", "workspace");
	await Promise.all([mkdir(workspace, { recursive: true }), mkdir(outside, { recursive: true })]);
	return { root, workspace, outside };
}

function createEnv(workspace: string, readOnlyBinds?: readonly (readonly [string, string])[]) {
	return new ScopedExecutionEnv(new NodeExecutionEnv({ cwd: workspace }), {
		workspace,
		readOnlyBinds,
	});
}

function valueOf<T, E>(result: Result<T, E>): T {
	if (!result.ok) throw result.error;
	return result.value;
}

function expectFileError(result: Result<unknown, FileError>, code: FileError["code"]): void {
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, code);
}

test("ScopedExecutionEnv: workspace 内文件可读写且 cleanup 后持久化", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const env = createEnv(fixture.workspace);

	valueOf(await env.writeFile("docs/note.txt", "第一行"));
	valueOf(await env.appendFile("docs/note.txt", "\n第二行"));
	assert.equal(valueOf(await env.readTextFile("docs/note.txt")), "第一行\n第二行");
	await env.cleanup();

	const restored = createEnv(fixture.workspace);
	assert.equal(valueOf(await restored.readTextFile("docs/note.txt")), "第一行\n第二行");
});

test("ScopedExecutionEnv: 拒绝父目录、宿主绝对路径和其它 scope", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	await writeFile(join(fixture.outside, "secret.txt"), "secret");
	const env = createEnv(fixture.workspace);

	expectFileError(await env.readTextFile("../secret.txt"), "permission_denied");
	expectFileError(await env.readTextFile(join(fixture.outside, "secret.txt")), "permission_denied");
	expectFileError(await env.writeFile("/tmp/arkham-escape.txt", "escape"), "permission_denied");
	expectFileError(await env.absolutePath("../../scope-b/workspace"), "permission_denied");
});

test("ScopedExecutionEnv: 拒绝通过符号链接越出 workspace", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const secret = join(fixture.root, "host-secret.txt");
	await writeFile(secret, "secret");
	await symlink(secret, join(fixture.workspace, "escape-link"));
	const env = createEnv(fixture.workspace);

	expectFileError(await env.readTextFile("escape-link"), "permission_denied");
	expectFileError(await env.writeFile("escape-link", "overwrite"), "permission_denied");
	assert.equal(await readFile(secret, "utf8"), "secret");
});

test("ScopedExecutionEnv: 只读挂载可读、不可修改且不泄露宿主路径", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const source = join(fixture.root, "shared-skills");
	const virtual = join(fixture.workspace, "skills");
	await mkdir(join(source, "demo"), { recursive: true });
	await writeFile(join(source, "demo", "SKILL.md"), "只读技能");
	const env = createEnv(fixture.workspace, [[source, virtual]]);

	assert.equal(valueOf(await env.readTextFile("skills/demo/SKILL.md")), "只读技能");
	const listed = valueOf(await env.listDir("skills/demo"));
	assert.equal(listed[0]?.path, join(virtual, "demo", "SKILL.md"));
	assert.equal(listed[0]?.path.includes(source), false);
	assert.equal(valueOf(await env.canonicalPath("skills/demo/SKILL.md")), join(virtual, "demo", "SKILL.md"));
	const directoryRead = await env.readTextFile("skills/demo");
	expectFileError(directoryRead, "is_directory");
	if (!directoryRead.ok) {
		assert.equal(directoryRead.error.path, join(virtual, "demo"));
		assert.equal(directoryRead.error.message.includes(source), false);
	}
	expectFileError(await env.writeFile("skills/new.md", "x"), "permission_denied");
	expectFileError(await env.appendFile("skills/demo/SKILL.md", "x"), "permission_denied");
	expectFileError(await env.remove("skills/demo/SKILL.md"), "permission_denied");
	expectFileError(await env.createDir("skills/new-dir"), "permission_denied");
});

test("ScopedExecutionEnv: exec 限制 cwd 并注入默认超时", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	await mkdir(join(fixture.workspace, "sub"));
	const inner = new RecordingExecutionEnv(fixture.workspace);
	const env = new ScopedExecutionEnv(inner, {
		workspace: fixture.workspace,
		defaultTimeoutSeconds: 17,
	});

	valueOf(await env.exec("pwd", { cwd: "sub" }));
	assert.equal(inner.lastOptions?.cwd, join(fixture.workspace, "sub"));
	assert.equal(inner.lastOptions?.timeout, 17);
	valueOf(await env.exec("pwd", { timeout: 3 }));
	assert.equal(inner.lastOptions?.timeout, 3);
	const callsBeforeReject = inner.calls;
	const rejected = await env.exec("pwd", { cwd: fixture.outside });
	assert.equal(rejected.ok, false);
	if (!rejected.ok) assert.equal(rejected.error.code, "spawn_error");
	assert.equal(inner.calls, callsBeforeReject);
});

test("ScopedExecutionEnv: 临时文件始终创建在持久 workspace 内", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const env = createEnv(fixture.workspace);

	const tempDir = valueOf(await env.createTempDir("render-"));
	const tempFile = valueOf(await env.createTempFile({ prefix: "card-", suffix: ".png" }));
	assert.ok(tempDir.startsWith(`${join(fixture.workspace, ".tmp")}${sep}`));
	assert.ok(tempFile.startsWith(`${join(fixture.workspace, ".tmp")}${sep}`));
	assert.equal(valueOf(await env.exists(tempFile)), true);
});

test("ScopedExecutionEnv: 已取消的文件操作不会触达底层环境", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const env = createEnv(fixture.workspace);
	const controller = new AbortController();
	controller.abort();

	expectFileError(await env.readTextFile("missing.txt", controller.signal), "aborted");
	expectFileError(await env.createTempFile({ abortSignal: controller.signal }), "aborted");
});

test("ScopedExecutionEnv: shell 与文件操作串行，避免符号链接竞态", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	await writeFile(join(fixture.workspace, "note.txt"), "safe");
	const inner = new BlockingExecutionEnv(fixture.workspace);
	const env = new ScopedExecutionEnv(inner, { workspace: fixture.workspace });

	const executing = env.exec("hold");
	await inner.started;
	let readSettled = false;
	const reading = env.readTextFile("note.txt").then((result) => {
		readSettled = true;
		return result;
	});
	await Promise.resolve();
	assert.equal(readSettled, false);

	inner.release();
	valueOf(await executing);
	assert.equal(valueOf(await reading), "safe");
});

class RecordingExecutionEnv extends NodeExecutionEnv {
	lastOptions: ShellExecOptions | undefined;
	calls = 0;

	override async exec(
		_command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		this.calls += 1;
		this.lastOptions = options;
		return ok({ stdout: "", stderr: "", exitCode: 0 });
	}
}

class BlockingExecutionEnv extends NodeExecutionEnv {
	readonly started: Promise<void>;
	private readonly markStarted: () => void;
	private readonly released: Promise<void>;
	private readonly markReleased: () => void;

	constructor(cwd: string) {
		super({ cwd });
		let markStarted = () => {};
		let markReleased = () => {};
		this.started = new Promise((resolvePromise) => {
			markStarted = resolvePromise;
		});
		this.released = new Promise((resolvePromise) => {
			markReleased = resolvePromise;
		});
		this.markStarted = markStarted;
		this.markReleased = markReleased;
	}

	release(): void {
		this.markReleased();
	}

	override async exec(): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		this.markStarted();
		await this.released;
		return ok({ stdout: "", stderr: "", exitCode: 0 });
	}
}
