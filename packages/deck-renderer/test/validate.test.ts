import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDeckPlan, formatValidation } from "../src/validate.ts";
import type { DeckPlan } from "../src/plan.ts";

test("validateDeckPlan: 找出缺图 + 候选 ID 建议", async () => {
	const dir = await mkdtemp(join(tmpdir(), "deck-validate-"));
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "01001_a.jpg"), "");
	await writeFile(join(dir, "01006_a.jpg"), "");
	await writeFile(join(dir, "11068_a.jpg"), "");
	await writeFile(join(dir, "11068_b.jpg"), "");
	const plan: DeckPlan = {
		slots: [
			{
				name: "S",
				cards: [
					{ code: "01001" }, // 有图
					{ code: "01006" }, // 有图
					{ code: "11068a" }, // 缺图 → 建议改 11068
					{ code: "99999" }, // 缺图，无候选
				],
			},
		],
	};
	const r = await validateDeckPlan(plan, dir);
	assert.equal(r.checked, 4);
	assert.equal(r.found, 2);
	assert.equal(r.missing.length, 2);
	assert.equal(r.ok, false);

	const m1 = r.missing.find((m) => m.code === "11068a")!;
	assert.equal(m1.suggestedCode, "11068");
	assert.ok(m1.candidates.includes("11068_a.jpg"));
	assert.equal(m1.reason, "wrong_id");

	const m2 = r.missing.find((m) => m.code === "99999")!;
	assert.equal(m2.suggestedCode, undefined);
	assert.equal(m2.candidates.length, 0);
	assert.equal(m2.reason, "no_image");
	await rm(dir, { recursive: true, force: true });
});

test("validateDeckPlan: 全部有图 → ok", async () => {
	const dir = await mkdtemp(join(tmpdir(), "deck-validate-"));
	await writeFile(join(dir, "01001_a.jpg"), "");
	const plan: DeckPlan = { slots: [{ name: "S", cards: [{ code: "01001" }] }] };
	const r = await validateDeckPlan(plan, dir);
	assert.equal(r.ok, true);
	assert.equal(r.missing.length, 0);
	await rm(dir, { recursive: true, force: true });
});

test("formatValidation: 文字含建议 code", async () => {
	const dir = await mkdtemp(join(tmpdir(), "deck-validate-"));
	await writeFile(join(dir, "11068_a.jpg"), "");
	const plan: DeckPlan = { slots: [{ name: "支援", cards: [{ code: "11068a", label: "伟业" }] }] };
	const text = formatValidation(await validateDeckPlan(plan, dir));
	assert.ok(text.includes("11068a"));
	assert.ok(text.includes('建议改用 "11068"'));
	await rm(dir, { recursive: true, force: true });
});
