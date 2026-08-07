import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCardRenderService } from "../src/card-render-service.ts";

test("制卡服务：保留用户原文和数值，默认单插画并按任务版本持久化", async () => {
	const workspaceDir = await mkdtemp(join(tmpdir(), "card-render-"));
	let generatedCount = 0;
	const render = createCardRenderService({
		arkhamBinPath: "/unused/arkham-cli",
		arkhamAssetsDir: "/unused/assets",
		generateArt: async () => {
			generatedCount++;
			return "generated/art-1.jpg";
		},
		executeRenderer: async ({ outDir }) => {
			await mkdir(outDir, { recursive: true });
			await writeFile(join(outDir, "000.png"), "png");
		},
	});
	const input = {
		scope: { kind: "group" as const, id: "g1" },
		scopeDir: workspaceDir,
		workspaceDir,
		taskId: "task-1",
		rawText: "名称泽耶尔·戴，职介守卫者，属性4143，血8 san6。揭示保持原词。",
		cards: [{
			type: "调查员",
			name: "泽耶尔·戴",
			class: "守卫者",
			attribute: [4, 1, 4, 3],
			health: 8,
			horror: 6,
			body: "揭示保持原词。",
		}],
		attachmentPaths: [],
	};
	const first = await render(input);
	const second = await render(input);

	assert.equal(generatedCount, 2);
	assert.equal(first.images?.length, 1);
	assert.match(first.artifacts?.[0].relativePath ?? "", /tasks\/task-1\/cards\/v001\/in\/000\.card/);
	assert.match(second.artifacts?.[0].relativePath ?? "", /tasks\/task-1\/cards\/v002\/in\/000\.card/);
	const card = JSON.parse(await readFile(join(workspaceDir, "tasks/task-1/cards/v001/in/000.card"), "utf8")) as Record<string, unknown>;
	assert.deepEqual(card.attribute, [4, 1, 4, 3]);
	assert.equal(card.health, 8);
	assert.equal(card.horror, 6);
	assert.equal(card.class, "守护者");
	assert.equal(card.body, "揭示保持原词。");
	assert.equal(card.picture_path, "generated/art-1.jpg");
	assert.equal(
		await readFile(join(workspaceDir, "tasks/task-1/cards/v001/source.txt"), "utf8"),
		input.rawText,
	);
});
