import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SceneId } from "@arkham/chatbot-store";

export type PromptId =
	| "base"
	| "scenes/chat"
	| "scenes/rules"
	| "scenes/card-search"
	| "scenes/card-text"
	| "scenes/card-render"
	| "scenes/card-design"
	| "scenes/general"
	| "internal/router"
	| "internal/summary"
	| "internal/memory"
	| "knowledge/card-language"
	| "knowledge/card-schema"
	| "knowledge/card-balance";

export interface PromptSnapshot {
	readonly version: number;
	readonly loadedAt: number;
	readonly hash: string;
	readonly characterCount: number;
	readonly estimatedTokens: number;
	readonly prompts: ReadonlyMap<PromptId, string>;
}

const PROMPT_FILES: ReadonlyArray<readonly [PromptId, string]> = [
	["base", "base.md"],
	["scenes/chat", "scenes/chat.md"],
	["scenes/rules", "scenes/rules.md"],
	["scenes/card-search", "scenes/card-search.md"],
	["scenes/card-text", "scenes/card-text.md"],
	["scenes/card-render", "scenes/card-render.md"],
	["scenes/card-design", "scenes/card-design.md"],
	["scenes/general", "scenes/general.md"],
	["internal/router", "internal/router.md"],
	["internal/summary", "internal/summary.md"],
	["internal/memory", "internal/memory.md"],
	["knowledge/card-language", "knowledge/card-language.md"],
	["knowledge/card-schema", "knowledge/card-schema.md"],
	["knowledge/card-balance", "knowledge/card-balance.md"],
];

const SCENE_PROMPTS: Record<SceneId, PromptId> = {
	chat: "scenes/chat",
	rules: "scenes/rules",
	card_search: "scenes/card-search",
	card_text: "scenes/card-text",
	card_render: "scenes/card-render",
	card_design: "scenes/card-design",
	general: "scenes/general",
};

const SCENE_KNOWLEDGE: Partial<Record<SceneId, PromptId[]>> = {
	card_text: ["knowledge/card-language"],
	card_render: ["knowledge/card-language", "knowledge/card-schema"],
	card_design: ["knowledge/card-language", "knowledge/card-schema", "knowledge/card-balance"],
};

export class PromptRegistry {
	private current?: PromptSnapshot;

	constructor(readonly rootDir: string) {}

	async load(): Promise<PromptSnapshot> {
		return this.reload();
	}

	async reload(): Promise<PromptSnapshot> {
		const entries = await Promise.all(PROMPT_FILES.map(async ([id, relativePath]) => {
			const content = (await readFile(join(this.rootDir, relativePath), "utf8")).trim();
			if (!content) throw new Error(`提示词文件为空: ${relativePath}`);
			return [id, content] as const;
		}));
		const prompts = new Map<PromptId, string>(entries);
		const stableText = entries.map(([id, content]) => `<!-- ${id} -->\n${content}`).join("\n\n");
		const snapshot: PromptSnapshot = Object.freeze({
			version: (this.current?.version ?? 0) + 1,
			loadedAt: Date.now(),
			hash: createHash("sha256").update(stableText).digest("hex"),
			characterCount: stableText.length,
			estimatedTokens: estimateTokens(stableText),
			prompts,
		});
		this.current = snapshot;
		return snapshot;
	}

	snapshot(): PromptSnapshot {
		if (!this.current) throw new Error("提示词注册表尚未加载");
		return this.current;
	}

	get(id: PromptId, snapshot = this.snapshot()): string {
		const prompt = snapshot.prompts.get(id);
		if (!prompt) throw new Error(`缺少提示词: ${id}`);
		return prompt;
	}

	compose(scene: SceneId, snapshot = this.snapshot()): string {
		const ids: PromptId[] = ["base", SCENE_PROMPTS[scene], ...(SCENE_KNOWLEDGE[scene] ?? [])];
		return ids.map((id) => this.get(id, snapshot)).join("\n\n");
	}

	composePlanner(snapshot = this.snapshot()): string {
		const ids: PromptId[] = [
			"base",
			"internal/router",
			"knowledge/card-language",
			"knowledge/card-schema",
			"knowledge/card-balance",
		];
		return ids.map((id) => this.get(id, snapshot)).join("\n\n");
	}

	list(snapshot = this.snapshot()): Array<{ id: PromptId; content: string; characterCount: number; estimatedTokens: number }> {
		return PROMPT_FILES.map(([id]) => {
			const content = this.get(id, snapshot);
			return { id, content, characterCount: content.length, estimatedTokens: estimateTokens(content) };
		});
	}
}

export function estimateTokens(text: string): number {
	let ascii = 0;
	let nonAscii = 0;
	for (const character of text) {
		if (character.codePointAt(0)! <= 0x7f) ascii++;
		else nonAscii++;
	}
	return Math.ceil(ascii / 4 + nonAscii);
}
