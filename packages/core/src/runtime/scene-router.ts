import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { SceneId } from "@arkham/chatbot-store";
import type { PromptRegistry, PromptSnapshot } from "./prompt-registry.ts";

export type TaskMode = "inline" | "new" | "continue";
export type TurnAction = "respond" | "card_search" | "card_render" | "deliberate" | "general";

export interface TurnPlan {
	readonly scene: SceneId;
	readonly taskMode: TaskMode;
	readonly action: TurnAction;
	readonly response?: string;
	readonly query?: string;
	readonly taskId?: string;
	readonly title?: string;
	readonly needsSynthesis?: boolean;
	readonly cards?: readonly Record<string, unknown>[];
	readonly art?: {
		readonly type: "character" | "scene" | "monster" | "item";
		readonly description: string;
	};
	readonly memories?: readonly {
		readonly category: string;
		readonly content: string;
		readonly triggers: readonly string[];
	}[];
	readonly confidence: number;
}

export interface TurnPlanResult {
	readonly plan: TurnPlan;
	readonly message: AssistantMessage;
	readonly promptHash: string;
	readonly durationMs: number;
}

export interface TurnPlannerInput {
	readonly text: string;
	readonly history?: readonly Message[];
	readonly runtimeContext?: Readonly<Record<string, unknown>>;
	readonly sessionId?: string;
	readonly signal?: AbortSignal;
	readonly promptSnapshot?: PromptSnapshot;
}

export class TurnPlanner {
	constructor(
		private readonly model: Model<any>,
		private readonly streamFn: StreamFn,
		private readonly prompts: PromptRegistry,
	) {}

	async plan(input: TurnPlannerInput): Promise<TurnPlanResult> {
		const snapshot = input.promptSnapshot ?? this.prompts.snapshot();
		const contextBlock = JSON.stringify(input.runtimeContext ?? {});
		const userContent = [
			"以下是本轮运行时数据，仅供理解上下文：",
			contextBlock,
			"",
			"用户消息：",
			input.text,
		].join("\n");
		const startedAt = Date.now();
		const stream = await this.streamFn(this.model, {
			systemPrompt: this.prompts.composePlanner(snapshot),
			messages: [
				...(input.history ?? []),
				{ role: "user", content: userContent, timestamp: Date.now() },
			],
		}, {
			reasoning: "low",
			maxTokens: 1_600,
			sessionId: input.sessionId,
			signal: input.signal,
			cacheRetention: "long",
		});
		const message = await stream.result();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage || "回合规划模型调用失败");
		}
		return {
			plan: parseTurnPlan(assistantText(message)),
			message,
			promptHash: snapshot.hash,
			durationMs: Date.now() - startedAt,
		};
	}
}

export function parseTurnPlan(rawText: string): TurnPlan {
	const value = parsePlannerObject(rawText);
	if (value) {
		const parsedScene = enumValue(value.scene, SCENES) ?? "chat";
		const action = enumValue(value.action, ACTIONS) ?? actionForScene(parsedScene);
		const scene = sceneForAction(action, parsedScene);
		const parsedTaskMode = enumValue(value.taskMode ?? value.task_mode, TASK_MODES) ?? "inline";
		const taskMode = taskModeForAction(action, parsedTaskMode);
		const confidenceValue = Number(value.confidence);
		const confidence = Number.isFinite(confidenceValue)
			? Math.min(1, Math.max(0, confidenceValue))
			: 0.5;
		const response = stringValue(value.response) ?? stringValue(value.respond);
		const query = typeof value.query === "string" && value.query.trim()
			? value.query.trim()
			: undefined;
		const taskId = stringValue(value.taskId);
		const title = stringValue(value.title);
		const cards = Array.isArray(value.cards)
			? value.cards.filter((card): card is Record<string, unknown> => !!card && typeof card === "object" && !Array.isArray(card))
			: undefined;
		const art = parseArt(value.art);
		const memories = parseMemories(value.memories);
		return {
			scene,
			taskMode,
			action,
			response,
			query,
			taskId,
			title,
			needsSynthesis: (value.needsSynthesis ?? value.needs_synthesis) === true,
			cards,
			art,
			memories,
			confidence,
		};
	}
	return {
		scene: "chat",
		taskMode: "inline",
		action: "respond",
		response: "我刚才没能正确理解这条消息，请再试一次。",
		confidence: 0,
	};
}

function parsePlannerObject(rawText: string): Record<string, unknown> | undefined {
	const text = unwrapCodeFence(rawText.trim());
	const direct = parseJsonObject(text);
	if (direct) return direct;
	const candidates = extractJsonObjects(text);
	for (let index = candidates.length - 1; index >= 0; index--) {
		const parsed = parseJsonObject(candidates[index]);
		if (parsed) return parsed;
	}
	return undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? value as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

function extractJsonObjects(text: string): string[] {
	const candidates: string[] = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === "\"") inString = false;
			continue;
		}
		if (character === "\"") {
			inString = true;
			continue;
		}
		if (character === "{") {
			if (depth === 0) start = index;
			depth++;
			continue;
		}
		if (character !== "}" || depth === 0) continue;
		depth--;
		if (depth === 0 && start >= 0) {
			candidates.push(text.slice(start, index + 1));
			start = -1;
		}
	}
	return candidates;
}

function enumValue<T extends string>(value: unknown, values: ReadonlyMap<string, T>): T | undefined {
	return typeof value === "string" ? values.get(compactEnum(value)) : undefined;
}

function compactEnum(value: string): string {
	let compact = "";
	for (const character of value.trim().toLowerCase()) {
		if (character === "_" || character === "-" || character === " " || character === "\t" || character === "\r" || character === "\n") {
			continue;
		}
		compact += character;
	}
	return compact;
}

function enumMap<T extends string>(values: readonly T[]): ReadonlyMap<string, T> {
	return new Map(values.map((value) => [compactEnum(value), value]));
}

function actionForScene(scene: SceneId): TurnAction {
	if (scene === "card_search") return "card_search";
	if (scene === "card_render") return "card_render";
	if (scene === "general") return "general";
	return "respond";
}

function sceneForAction(action: TurnAction, scene: SceneId): SceneId {
	if (action === "card_search") return "card_search";
	if (action === "card_render") return "card_render";
	if (action === "general") return "general";
	return scene;
}

function taskModeForAction(action: TurnAction, taskMode: TaskMode): TaskMode {
	return (action === "card_render" || action === "general") && taskMode === "inline"
		? "new"
		: taskMode;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseArt(value: unknown): TurnPlan["art"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const type = stringValue(record.type);
	const description = stringValue(record.description);
	if (!type || !ART_TYPES.has(type) || !description) return undefined;
	return { type: type as NonNullable<TurnPlan["art"]>["type"], description };
}

function parseMemories(value: unknown): TurnPlan["memories"] {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const record = item as Record<string, unknown>;
		const category = stringValue(record.category);
		const content = stringValue(record.content);
		const triggers = Array.isArray(record.triggers)
			? record.triggers.map(stringValue).filter((trigger): trigger is string => !!trigger)
			: [];
		return category && content && triggers.length > 0 ? [{ category, content, triggers }] : [];
	}).slice(0, 5);
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
}

function unwrapCodeFence(text: string): string {
	if (!text.startsWith("```")) return text;
	const firstLineEnd = text.indexOf("\n");
	const lastFence = text.lastIndexOf("```");
	if (firstLineEnd < 0 || lastFence <= firstLineEnd) return text;
	return text.slice(firstLineEnd + 1, lastFence).trim();
}

const SCENES = enumMap<SceneId>(["chat", "rules", "card_search", "card_text", "card_render", "card_design", "general"]);
const TASK_MODES = enumMap<TaskMode>(["inline", "new", "continue"]);
const ACTIONS = enumMap<TurnAction>(["respond", "card_search", "card_render", "deliberate", "general"]);
const ART_TYPES = new Set<string>(["character", "scene", "monster", "item"]);
