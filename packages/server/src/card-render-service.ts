import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import {
	createGenerateImageTool,
	type CapabilityResult,
	type CardRenderInput,
} from "@arkham/chatbot-core";

const execFileAsync = promisify(execFile);

export interface CardRenderServiceOptions {
	readonly arkhamBinPath: string;
	readonly arkhamAssetsDir: string;
	readonly minimax?: {
		readonly apiKey: string;
		readonly apiBase?: string;
	};
	readonly generateArt?: (
		input: { workspaceDir: string; description: string; type: "character" | "scene" | "monster" | "item"; signal?: AbortSignal },
	) => Promise<string>;
	readonly executeRenderer?: (
		input: { corpusDir: string; outDir: string; workspaceDir: string; signal?: AbortSignal },
	) => Promise<void>;
}

export function createCardRenderService(
	opts: CardRenderServiceOptions,
): (input: CardRenderInput) => Promise<CapabilityResult> {
	return async (input) => {
		const version = await nextVersion(join(input.workspaceDir, "tasks", input.taskId, "cards"));
		const versionName = "v" + String(version).padStart(3, "0");
		const versionDir = join(input.workspaceDir, "tasks", input.taskId, "cards", versionName);
		const corpusDir = join(versionDir, "in");
		const outDir = join(versionDir, "out");
		await Promise.all([
			mkdir(corpusDir, { recursive: true }),
			mkdir(outDir, { recursive: true }),
		]);

		const cards = input.cards.map(normalizeCard);
		const illustratedCard = cards.find((card) => card.type !== "升级卡");
		if (illustratedCard) {
			const picturePath = input.attachmentPaths[0]
				?? await generateArt(opts, {
					workspaceDir: input.workspaceDir,
					description: input.art?.description ?? defaultArtDescription(illustratedCard),
					type: input.art?.type ?? inferArtType(illustratedCard),
					signal: input.signal,
				});
			illustratedCard.picture_path = picturePath;
		}

		const cardArtifacts = [];
		for (let index = 0; index < cards.length; index++) {
			const filename = String(index).padStart(3, "0") + ".card";
			const path = join(corpusDir, filename);
			await writeFile(path, JSON.stringify(cards[index], null, 2) + "\n", "utf8");
			cardArtifacts.push({
				kind: "card",
				version,
				relativePath: relative(input.workspaceDir, path),
				metadata: { face: index, sourcePreserved: true },
			});
		}
		const sourcePath = join(versionDir, "source.txt");
		await writeFile(sourcePath, input.rawText, "utf8");

		if (opts.executeRenderer) {
			await opts.executeRenderer({ corpusDir, outDir, workspaceDir: input.workspaceDir, signal: input.signal });
		} else {
			await executeRenderer(opts, { corpusDir, outDir, workspaceDir: input.workspaceDir, signal: input.signal });
		}
		const images = (await readdir(outDir))
			.filter((name) => name.toLowerCase().endsWith(".png"))
			.sort()
			.map((name) => join(outDir, name));
		if (images.length === 0) throw new Error("卡图渲染完成但没有生成 PNG 文件");

		return {
			text: "卡图已按你提供的原文生成。",
			images,
			artifacts: [
				...cardArtifacts,
				{
					kind: "source",
					version,
					relativePath: relative(input.workspaceDir, sourcePath),
					metadata: { immutableInput: true },
				},
				...images.map((path, index) => ({
					kind: "rendered-card",
					version,
					relativePath: relative(input.workspaceDir, path),
					metadata: { face: index },
				})),
			],
		};
	};
}

async function generateArt(
	opts: CardRenderServiceOptions,
	input: { workspaceDir: string; description: string; type: "character" | "scene" | "monster" | "item"; signal?: AbortSignal },
): Promise<string> {
	if (opts.generateArt) return opts.generateArt(input);
	if (!opts.minimax) throw new Error("制卡需要插画，但 MiniMax 生图服务未配置");
	const tool = createGenerateImageTool({
		apiKey: opts.minimax.apiKey,
		apiBase: opts.minimax.apiBase,
		workspaceDir: input.workspaceDir,
	});
	const result = await tool.execute(
		randomUUID(),
		{ description: input.description, type: input.type, n: 1 },
		input.signal,
		() => {},
	);
	const text = result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const pathLine = text.split("\n")
		.map((line) => line.trim())
		.find((line) => line.startsWith("- generated/"));
	if (!pathLine) throw new Error(text || "自动插画生成失败");
	return pathLine.slice(2).trim();
}

async function executeRenderer(
	opts: CardRenderServiceOptions,
	input: { corpusDir: string; outDir: string; workspaceDir: string; signal?: AbortSignal },
): Promise<void> {
	try {
		await execFileAsync(opts.arkhamBinPath, [
			"render",
			"--corpus",
			input.corpusDir,
			"--assets",
			opts.arkhamAssetsDir,
			"--workspace",
			input.workspaceDir,
			"--out",
			input.outDir,
		], {
			cwd: input.workspaceDir,
			signal: input.signal,
			timeout: 120_000,
			maxBuffer: 2 * 1024 * 1024,
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error("卡图渲染失败：" + detail);
	}
}

function normalizeCard(input: Record<string, unknown>): Record<string, unknown> {
	const card = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
	if (typeof card.type !== "string" || !card.type.trim()) throw new Error("卡牌缺少必填字段 type");
	if (typeof card.name !== "string" || !card.name.trim()) throw new Error("卡牌缺少必填字段 name");
	if (card.body !== undefined && typeof card.body !== "string") throw new Error("卡牌字段 body 必须是字符串");
	if (card.class === "守卫者") card.class = "守护者";
	card.body ??= "";
	card.language ??= "zh";
	delete card.picture_path;
	return card;
}

function defaultArtDescription(card: Record<string, unknown>): string {
	const name = String(card.name);
	const body = typeof card.body === "string" ? card.body.slice(0, 120) : "";
	return "以“" + name + "”为主体，呈现其卡牌能力意象；" + body + "；唯一光源来自昏暗月光";
}

function inferArtType(card: Record<string, unknown>): "character" | "scene" | "monster" | "item" {
	const type = String(card.type);
	if (type === "调查员" || type === "调查员卡") return "character";
	if (type === "敌人卡") return "monster";
	if (type === "支援卡" || type === "技能卡") return "item";
	return "scene";
}

async function nextVersion(cardsRoot: string): Promise<number> {
	let entries: string[] = [];
	try {
		entries = await readdir(cardsRoot);
	} catch {
		return 1;
	}
	let latest = 0;
	for (const name of entries) {
		if (!name.startsWith("v")) continue;
		const version = Number(name.slice(1));
		if (Number.isInteger(version) && version > latest) latest = version;
	}
	return latest + 1;
}
