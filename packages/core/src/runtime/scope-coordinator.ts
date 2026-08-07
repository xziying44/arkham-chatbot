import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	AgentRuntimeRepository,
	UsageRepository,
	type AgentTask,
	type NormalizedUsage,
	type RuntimeScope,
	type SceneId,
} from "@arkham/chatbot-store";
import type { ScopeKey } from "../identity/scope.ts";
import { scopeKeyStr } from "../identity/scope.ts";
import type { IncomingMessage } from "../session/message.ts";
import type { IndexedCard } from "../tools/search-cards-index.ts";
import { searchCards } from "../tools/search-cards-index.ts";
import { estimateTokens, type PromptRegistry } from "./prompt-registry.ts";
import { TurnPlanner, type TurnPlan, type TurnPlanResult } from "./scene-router.ts";

export interface RuntimeAttachment {
	readonly url: string;
	readonly filename: string;
	readonly contentType: string;
}

export interface CapabilityArtifact {
	readonly id?: string;
	readonly kind: string;
	readonly version: number;
	readonly relativePath: string;
	readonly metadata?: Record<string, unknown>;
}

export interface CapabilityResult {
	readonly text: string;
	readonly images?: readonly string[];
	readonly artifacts?: readonly CapabilityArtifact[];
	readonly modelCalls?: readonly {
		readonly message: AssistantMessage;
		readonly durationMs: number;
	}[];
	readonly toolCalls?: number;
}

export interface CardRenderInput {
	readonly scope: ScopeKey;
	readonly scopeDir: string;
	readonly workspaceDir: string;
	readonly taskId: string;
	readonly rawText: string;
	readonly cards: readonly Record<string, unknown>[];
	readonly art?: TurnPlan["art"];
	readonly attachmentPaths: readonly string[];
	readonly signal?: AbortSignal;
}

export interface GeneralTaskInput {
	readonly scope: ScopeKey;
	readonly scopeDir: string;
	readonly workspaceDir: string;
	readonly taskId: string;
	readonly rawText: string;
	readonly signal?: AbortSignal;
}

export interface ScopeCoordinatorOptions {
	readonly botId: string;
	readonly dataDir: string;
	readonly model: Model<any>;
	readonly streamFn: StreamFn;
	readonly prompts: PromptRegistry;
	readonly runtime: AgentRuntimeRepository;
	readonly usage: UsageRepository;
	readonly persona?: string;
	readonly cardIndex?: readonly IndexedCard[];
	readonly resolveCardImage?: (relativePath: string) => string | undefined;
	readonly renderCards?: (input: CardRenderInput) => Promise<CapabilityResult>;
	readonly runGeneralTask?: (input: GeneralTaskInput) => Promise<CapabilityResult>;
	readonly onProgress?: (scope: ScopeKey, text: string, replyToMessageId?: string) => Promise<void>;
	readonly onAttachment?: (scope: ScopeKey, attachment: RuntimeAttachment) => Promise<string>;
	readonly planner?: Pick<TurnPlanner, "plan">;
	readonly concurrency?: {
		readonly bot?: number;
		readonly scope?: number;
		readonly member?: number;
	};
	readonly progressDelayMs?: number;
}

export interface CoordinatorReply {
	readonly text: string;
	readonly replyToMessageId?: string;
	readonly images?: readonly string[];
}

export interface RuntimeScopeInfo {
	readonly key: string;
	readonly scope: ScopeKey;
	readonly lastActivityAt: number;
	readonly ttlRemainingMs: number;
	readonly messageCount: number;
	readonly activeTaskCount: number;
}

interface ScopeActivity {
	scope: ScopeKey;
	lastActivityAt: number;
	messageCount: number;
}

interface TextCallResult {
	message: AssistantMessage;
	text: string;
	durationMs: number;
}

const HOT_WINDOW_TOKENS = 24_000;
const COMPACT_AT_TOKENS = 28_000;
const RETAIN_AFTER_COMPACTION = 16_000;

export class ScopeCoordinator {
	private readonly planner: Pick<TurnPlanner, "plan">;
	private readonly botSlots: Semaphore;
	private readonly scopeSlots = new Map<string, Semaphore>();
	private readonly memberSlots = new Map<string, Semaphore>();
	private readonly activity = new Map<string, ScopeActivity>();
	private readonly inFlight = new Set<Promise<unknown>>();
	private readonly compactions = new Map<string, Promise<void>>();
	private readonly scopeConcurrency: number;
	private readonly memberConcurrency: number;
	private shuttingDown = false;

	constructor(private readonly opts: ScopeCoordinatorOptions) {
		this.planner = opts.planner ?? new TurnPlanner(opts.model, opts.streamFn, opts.prompts);
		this.botSlots = new Semaphore(opts.concurrency?.bot ?? 4);
		this.scopeConcurrency = opts.concurrency?.scope ?? 3;
		this.memberConcurrency = opts.concurrency?.member ?? 2;
	}

	start(): void {}

	dispatch(message: IncomingMessage & { attachments?: readonly RuntimeAttachment[] }): Promise<CoordinatorReply> {
		if (this.shuttingDown) {
			return Promise.resolve({ text: "服务正在关闭，暂时无法处理消息。" });
		}
		const operation = this.dispatchTracked(message);
		this.inFlight.add(operation);
		void operation.then(
			() => this.inFlight.delete(operation),
			() => this.inFlight.delete(operation),
		);
		return operation;
	}

	private async dispatchTracked(message: IncomingMessage & { attachments?: readonly RuntimeAttachment[] }): Promise<CoordinatorReply> {
		const receivedAt = Date.now();
		let firstFeedbackMs: number | null = null;
		const progressTimer = setTimeout(() => {
			firstFeedbackMs = Date.now() - receivedAt;
			void this.opts.onProgress?.(
				message.scope,
				"我在处理这项任务，完成后会一次发给你。",
				message.platformMessageId,
			).catch(() => {});
		}, this.opts.progressDelayMs ?? 2_000);

		const scopeKey = scopeKeyStr(message.scope);
		const memberKey = scopeKey + ":" + message.senderId;
		const releaseMember = await this.getMemberSlots(memberKey).acquire();
		const releaseScope = await this.getScopeSlots(scopeKey).acquire();
		const releaseBot = await this.botSlots.acquire();
		const queueDurationMs = Date.now() - receivedAt;
		try {
			return await this.processMessage(message, receivedAt, queueDurationMs, () => firstFeedbackMs);
		} finally {
			clearTimeout(progressTimer);
			releaseBot();
			releaseScope();
			releaseMember();
		}
	}

	private async processMessage(
		message: IncomingMessage & { attachments?: readonly RuntimeAttachment[] },
		startedAt: number,
		queueDurationMs: number,
		getFirstFeedbackMs: () => number | null,
	): Promise<CoordinatorReply> {
		const scope = this.runtimeScope(message.scope);
		const activity = this.touchScope(message.scope);
		const attachmentPaths = await this.downloadAttachments(message);
		const visibleText = appendAttachmentNotes(message.text, attachmentPaths);
		const incoming = this.opts.runtime.insertEvent({
			...scope,
			direction: "in",
			senderId: message.senderId,
			visibleText,
			tokenCount: estimateTokens(visibleText),
		});
		const hotEvents = this.opts.runtime.listHot(scope, HOT_WINDOW_TOKENS)
			.filter((event) => event.id !== incoming.id);
		const activeTasks = this.opts.runtime.listTasks(scope, ["active", "waiting", "completed"], 20);
		const memories = this.opts.runtime.findRelevantMemories(scope, visibleText, 5);
		const segments = this.opts.runtime.findRelevantSegments(scope, visibleText, 2);
		const history = hotEvents.map((event) => eventToMessage(event, this.opts.model));
		const runtimeContext = {
			scope: { kind: message.scope.kind, id: message.scope.id },
			sender: { id: message.senderId, name: message.senderName },
			persona: this.opts.persona ?? null,
			attachments: attachmentPaths,
			activeTasks: activeTasks.map(taskForModel),
			memories: memories.map((entry) => ({ category: entry.category, content: entry.content })),
			coldSummaries: segments.map((segment) => segment.summary),
		};
		const runId = randomUUID();
		let planResult: TurnPlanResult | undefined;
		let runStarted = false;
		let modelCallCount = 0;
		let capabilityCount = 0;
		try {
			planResult = await this.planner.plan({
				text: visibleText,
				history,
				runtimeContext,
				sessionId: this.opts.botId + ":" + scopeKeyStr(message.scope),
			});
			this.opts.usage.startRun({
				...scope,
				id: runId,
				scene: planResult.plan.scene,
				routeMethod: "model",
				queueDurationMs,
				startedAt,
			});
			runStarted = true;
			modelCallCount++;
			this.recordModelCall(runId, 1, planResult);

			const taskResolution = this.resolveTask(scope, message, planResult.plan, activeTasks);
			if (taskResolution.ambiguous) {
				const replyText = taskResolution.ambiguous;
				this.persistReply(scope, undefined, replyText, activity);
				this.finishRun(runId, "ok", getFirstFeedbackMs(), modelCallCount, capabilityCount);
				return { text: replyText, replyToMessageId: message.platformMessageId };
			}
			const task = taskResolution.task;
			const result = await this.executePlan(
				planResult.plan,
				message,
				visibleText,
				history,
				runtimeContext,
				task,
				attachmentPaths,
				runId,
				modelCallCount + 1,
			);
			modelCallCount += result.modelCalls;
			capabilityCount += result.capabilityCalls;
			this.persistMemories(scope, planResult.plan, incoming.id);
			if (task) this.persistTaskResult(task, planResult.plan, visibleText, result.capability);
			this.persistReply(scope, task?.id, result.capability.text, activity);
			this.finishRun(runId, "ok", getFirstFeedbackMs(), modelCallCount, capabilityCount);
			this.scheduleCompaction(scope);
			return {
				text: result.capability.text,
				replyToMessageId: message.platformMessageId,
				images: result.capability.images,
			};
		} catch (error) {
			if (!runStarted) {
				this.opts.usage.startRun({
					...scope,
					id: runId,
					scene: planResult?.plan.scene ?? "general",
					routeMethod: "model",
					queueDurationMs,
					startedAt,
				});
			}
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.finishRun(runId, "error", getFirstFeedbackMs(), modelCallCount, capabilityCount, errorMessage);
			const replyText = "处理这条消息时出了问题，请稍后再试。";
			this.persistReply(scope, undefined, replyText, activity);
			return { text: replyText, replyToMessageId: message.platformMessageId };
		}
	}

	private async executePlan(
		plan: TurnPlan,
		message: IncomingMessage,
		visibleText: string,
		history: readonly Message[],
		runtimeContext: Record<string, unknown>,
		task: AgentTask | undefined,
		attachmentPaths: readonly string[],
		runId: string,
		nextSequence: number,
	): Promise<{ capability: CapabilityResult; modelCalls: number; capabilityCalls: number }> {
		if (plan.action === "respond") {
			return {
				capability: { text: plan.response || "我还需要一点更具体的信息才能继续。" },
				modelCalls: 0,
				capabilityCalls: 0,
			};
		}
		if (plan.action === "card_search") {
			const results = searchCards(this.opts.cardIndex ?? [], { query: plan.query || visibleText, limit: 5 });
			if (results.length === 0) {
				return { capability: { text: "没有在卡牌数据库中找到匹配结果。" }, modelCalls: 0, capabilityCalls: 1 };
			}
			const cardContext = formatCardResults(results.map((entry) => entry.card));
			if (plan.needsSynthesis) {
				const call = await this.invokeText(
					plan.scene,
					history,
					visibleText,
					{ ...runtimeContext, cardSearchResults: cardContext },
					"medium",
				);
				this.recordTextCall(runId, nextSequence, call);
				return { capability: { text: call.text }, modelCalls: 1, capabilityCalls: 1 };
			}
			const firstImage = results[0].card.faces[0]?.imageFile;
			const resolvedImage = firstImage ? this.opts.resolveCardImage?.(firstImage) : undefined;
			return {
				capability: { text: cardContext, images: resolvedImage ? [resolvedImage] : undefined },
				modelCalls: 0,
				capabilityCalls: 1,
			};
		}
		if (plan.action === "card_render") {
			if (!task) {
				return { capability: { text: "这次制卡缺少任务上下文，请重新发送完整卡牌信息。" }, modelCalls: 0, capabilityCalls: 0 };
			}
			if (!this.opts.renderCards) {
				return { capability: { text: "当前没有配置卡图渲染服务。" }, modelCalls: 0, capabilityCalls: 0 };
			}
			if (!plan.cards?.length) {
				return {
					capability: { text: plan.response || "还缺少渲染所需的必填卡牌信息，请补充后我会直接出图。" },
					modelCalls: 0,
					capabilityCalls: 0,
				};
			}
			const scopeDir = join(this.opts.dataDir, message.scope.kind, message.scope.id);
			const capability = await this.opts.renderCards({
				scope: message.scope,
				scopeDir,
				workspaceDir: join(scopeDir, "workspace"),
				taskId: task.id,
				rawText: visibleText,
				cards: plan.cards,
				art: plan.art,
				attachmentPaths,
			});
			return { capability, modelCalls: 0, capabilityCalls: 1 };
		}
		if (plan.action === "general") {
			if (!task || !this.opts.runGeneralTask) {
				return { capability: { text: plan.response || "当前没有可用于这项任务的受限执行能力。" }, modelCalls: 0, capabilityCalls: 0 };
			}
			const scopeDir = join(this.opts.dataDir, message.scope.kind, message.scope.id);
			const capability = await this.opts.runGeneralTask({
				scope: message.scope,
				scopeDir,
				workspaceDir: join(scopeDir, "workspace"),
				taskId: task.id,
				rawText: visibleText,
			});
			for (let index = 0; index < (capability.modelCalls?.length ?? 0); index++) {
				const call = capability.modelCalls![index];
				this.recordTextCall(runId, nextSequence + index, {
					message: call.message,
					text: "",
					durationMs: call.durationMs,
				});
			}
			return {
				capability,
				modelCalls: capability.modelCalls?.length ?? 0,
				capabilityCalls: 1 + (capability.toolCalls ?? 0),
			};
		}
		if (plan.action === "deliberate" && plan.response) {
			return { capability: { text: plan.response }, modelCalls: 0, capabilityCalls: 0 };
		}
		const call = await this.invokeText(plan.scene, history, visibleText, runtimeContext, "medium");
		this.recordTextCall(runId, nextSequence, call);
		return { capability: { text: call.text }, modelCalls: 1, capabilityCalls: 0 };
	}

	private resolveTask(
		scope: RuntimeScope,
		message: IncomingMessage,
		plan: TurnPlan,
		tasks: readonly AgentTask[],
	): { task?: AgentTask; ambiguous?: string } {
		if (plan.taskMode === "inline") return {};
		if (plan.taskId) {
			const exact = tasks.find((task) => task.id === plan.taskId);
			if (exact) {
				return { task: this.opts.runtime.updateTask(exact.id, { status: "active" }) ?? exact };
			}
		}
		if (plan.taskMode === "continue") {
			const candidates = tasks.filter((task) => task.creatorId === message.senderId && task.scene === plan.scene);
			if (candidates.length === 1) {
				return { task: this.opts.runtime.updateTask(candidates[0].id, { status: "active" }) ?? candidates[0] };
			}
			if (candidates.length > 1) {
				const titles = candidates.slice(0, 3).map((task) => task.title + "（" + task.id.slice(0, 8) + "）").join("、");
				return { ambiguous: "我找到了多个可能的任务：" + titles + "。请告诉我要继续哪一个。" };
			}
		}
		const id = randomUUID();
		return {
			task: this.opts.runtime.createTask({
				...scope,
				id,
				scene: plan.scene,
				creatorId: message.senderId,
				title: plan.title || message.text.trim().slice(0, 40) || "未命名任务",
				state: { lastInput: message.text },
			}),
		};
	}

	private persistTaskResult(task: AgentTask, plan: TurnPlan, input: string, result: CapabilityResult): void {
		for (const artifact of result.artifacts ?? []) {
			this.opts.runtime.addArtifact({
				id: artifact.id ?? randomUUID(),
				taskId: task.id,
				kind: artifact.kind,
				version: artifact.version,
				relativePath: artifact.relativePath,
				metadata: artifact.metadata,
			});
		}
		this.opts.runtime.updateTask(task.id, {
			status: "waiting",
			state: {
				...task.state,
				lastInput: input,
				lastScene: plan.scene,
				lastAction: plan.action,
				lastResponse: result.text,
			},
		});
	}

	private persistMemories(scope: RuntimeScope, plan: TurnPlan, sourceEventId: number): void {
		for (const memory of plan.memories ?? []) {
			this.opts.runtime.upsertMemory({
				...scope,
				category: memory.category,
				content: memory.content,
				triggers: memory.triggers,
				sourceEventId,
			});
		}
	}

	private persistReply(scope: RuntimeScope, taskId: string | undefined, text: string, activity: ScopeActivity): void {
		this.opts.runtime.insertEvent({
			...scope,
			taskId,
			direction: "out",
			visibleText: text,
			modelContent: text,
			tokenCount: estimateTokens(text),
		});
		activity.messageCount++;
		activity.lastActivityAt = Date.now();
	}

	private async invokeText(
		scene: SceneId,
		history: readonly Message[],
		text: string,
		runtimeContext: Record<string, unknown>,
		reasoning: "low" | "medium",
	): Promise<TextCallResult> {
		const startedAt = Date.now();
		const stream = await this.opts.streamFn(this.opts.model, {
			systemPrompt: this.opts.prompts.compose(scene),
			messages: [
				...history,
				{
					role: "user",
					content: "运行时上下文：" + JSON.stringify(runtimeContext) + "\n\n用户消息：" + text,
					timestamp: Date.now(),
				},
			],
		}, {
			reasoning,
			maxTokens: 4_096,
			cacheRetention: "long",
		});
		const message = await stream.result();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage || "模型调用失败");
		}
		return { message, text: assistantText(message), durationMs: Date.now() - startedAt };
	}

	private recordModelCall(runId: string, sequence: number, result: TurnPlanResult): void {
		this.opts.usage.insertModelCall({
			runId,
			sequence,
			provider: result.message.provider,
			api: result.message.api,
			model: result.message.model,
			startedAt: Date.now() - result.durationMs,
			durationMs: result.durationMs,
			usage: normalizeModelUsage(result.message),
			toolCallCount: 0,
			stopReason: result.message.stopReason,
			status: "ok",
		});
	}

	private recordTextCall(runId: string, sequence: number, result: TextCallResult): void {
		this.opts.usage.insertModelCall({
			runId,
			sequence,
			provider: result.message.provider,
			api: result.message.api,
			model: result.message.model,
			startedAt: Date.now() - result.durationMs,
			durationMs: result.durationMs,
			usage: normalizeModelUsage(result.message),
			toolCallCount: 0,
			stopReason: result.message.stopReason,
			status: "ok",
		});
	}

	private finishRun(
		runId: string,
		status: "ok" | "error" | "cancelled",
		firstFeedbackMs: number | null,
		modelCallCount: number,
		toolCallCount: number,
		error?: string,
	): void {
		this.opts.usage.finishRun(runId, {
			status,
			firstFeedbackMs,
			modelCallCount,
			toolCallCount,
			error,
		});
	}

	private downloadAttachments(
		message: IncomingMessage & { attachments?: readonly RuntimeAttachment[] },
	): Promise<string[]> {
		if (!message.attachments?.length || !this.opts.onAttachment) return Promise.resolve([]);
		const images = message.attachments.filter((attachment) => attachment.contentType.startsWith("image/"));
		return Promise.all(images.map((attachment) => this.opts.onAttachment!(message.scope, attachment)));
	}

	private scheduleCompaction(scope: RuntimeScope): void {
		if (this.opts.runtime.hotTokenCount(scope) <= COMPACT_AT_TOKENS) return;
		const key = scope.botId + ":" + scope.scopeKind + ":" + scope.scopeId;
		if (this.compactions.has(key)) return;
		const operation = this.compact(scope);
		this.compactions.set(key, operation);
		void operation.then(
			() => this.compactions.delete(key),
			() => this.compactions.delete(key),
		);
	}

	private async compact(scope: RuntimeScope): Promise<void> {
		const releaseBot = await this.botSlots.acquire();
		try {
			const events = this.opts.runtime.listUncompacted(scope);
			let retainedTokens = events.reduce((sum, event) => sum + event.tokenCount, 0);
			const compacted = [];
			for (const event of events) {
				if (retainedTokens <= RETAIN_AFTER_COMPACTION) break;
				compacted.push(event);
				retainedTokens -= event.tokenCount;
			}
			if (compacted.length === 0) return;
			const runId = randomUUID();
			const startedAt = Date.now();
			this.opts.usage.startRun({
				...scope,
				id: runId,
				scene: "general",
				routeMethod: "model",
				startedAt,
			});
			try {
				const serialized = compacted.map((event) => JSON.stringify({
					id: event.id,
					direction: event.direction,
					senderId: event.senderId,
					text: event.modelContent,
				})).join("\n");
				const stream = await this.opts.streamFn(this.opts.model, {
					systemPrompt: this.opts.prompts.get("internal/summary"),
					messages: [{ role: "user", content: serialized, timestamp: Date.now() }],
				}, { reasoning: "low", maxTokens: 800, cacheRetention: "long" });
				const message = await stream.result();
				const durationMs = Date.now() - startedAt;
				const parsed = parseSummary(assistantText(message));
				this.opts.runtime.compactEvents(scope, compacted, parsed.summary, parsed.keywords);
				this.opts.usage.insertModelCall({
					runId,
					sequence: 1,
					provider: message.provider,
					api: message.api,
					model: message.model,
					startedAt,
					durationMs,
					usage: normalizeModelUsage(message),
					toolCallCount: 0,
					stopReason: message.stopReason,
					status: "ok",
				});
				this.finishRun(runId, "ok", null, 1, 0);
			} catch (error) {
				this.finishRun(runId, "error", null, 0, 0, error instanceof Error ? error.message : String(error));
			}
		} finally {
			releaseBot();
		}
	}

	private runtimeScope(scope: ScopeKey): RuntimeScope {
		return { botId: this.opts.botId, scopeKind: scope.kind, scopeId: scope.id };
	}

	private touchScope(scope: ScopeKey): ScopeActivity {
		const key = scopeKeyStr(scope);
		const current = this.activity.get(key);
		if (current) {
			current.lastActivityAt = Date.now();
			current.messageCount++;
			return current;
		}
		const created = { scope, lastActivityAt: Date.now(), messageCount: 1 };
		this.activity.set(key, created);
		return created;
	}

	private getScopeSlots(key: string): Semaphore {
		let slots = this.scopeSlots.get(key);
		if (!slots) {
			slots = new Semaphore(this.scopeConcurrency);
			this.scopeSlots.set(key, slots);
		}
		return slots;
	}

	private getMemberSlots(key: string): Semaphore {
		let slots = this.memberSlots.get(key);
		if (!slots) {
			slots = new Semaphore(this.memberConcurrency);
			this.memberSlots.set(key, slots);
		}
		return slots;
	}

	get activeCount(): number {
		return this.activity.size;
	}

	listActiveScopes(): RuntimeScopeInfo[] {
		return Array.from(this.activity.entries()).map(([key, entry]) => ({
			key,
			scope: entry.scope,
			lastActivityAt: entry.lastActivityAt,
			ttlRemainingMs: 0,
			messageCount: entry.messageCount,
			activeTaskCount: this.opts.runtime.listTasks(this.runtimeScope(entry.scope)).length,
		})).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
	}

	getScopeDetail(scope: ScopeKey, recentMessageLimit = 20) {
		const runtimeScope = this.runtimeScope(scope);
		const messages = this.opts.runtime.listHot(runtimeScope).slice(-recentMessageLimit);
		return {
			scope,
			systemPrompt: this.opts.prompts.composePlanner(),
			tools: [],
			messages,
			messageCount: this.opts.runtime.listUncompacted(runtimeScope).length,
			lastActivityAt: this.activity.get(scopeKeyStr(scope))?.lastActivityAt ?? 0,
			tasks: this.opts.runtime.listTasks(runtimeScope, ["active", "waiting", "completed"], 20),
			memories: this.opts.runtime.listMemories(runtimeScope),
		};
	}

	async forceReap(scope: ScopeKey): Promise<boolean> {
		return this.activity.delete(scopeKeyStr(scope));
	}

	async reapAll(): Promise<number> {
		const count = this.activity.size;
		this.activity.clear();
		return count;
	}

	dispatchInteraction(): void {}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		await Promise.allSettled([...this.inFlight, ...this.compactions.values()]);
	}
}

export function normalizeModelUsage(message: AssistantMessage): NormalizedUsage {
	const usage = message.usage;
	if (message.api === "anthropic-messages") {
		return {
			inputTokensTotal: usage.input + usage.cacheRead + usage.cacheWrite,
			inputTokensUncached: usage.input,
			cacheReadTokens: usage.cacheRead,
			cacheWriteTokens: usage.cacheWrite,
			outputTokens: usage.output,
		};
	}
	return {
		inputTokensTotal: usage.input,
		inputTokensUncached: Math.max(0, usage.input - usage.cacheRead),
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		outputTokens: usage.output,
	};
}

function eventToMessage(
	event: ReturnType<AgentRuntimeRepository["listHot"]>[number],
	model: Model<any>,
): Message {
	if (event.direction === "in") {
		const prefix = event.senderId ? "[" + event.senderId + "]: " : "";
		return { role: "user", content: prefix + event.modelContent, timestamp: event.createdAt };
	}
	return {
		role: "assistant",
		content: [{ type: "text", text: event.modelContent }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: event.createdAt,
	};
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function taskForModel(task: AgentTask): Record<string, unknown> {
	return {
		id: task.id,
		scene: task.scene,
		creatorId: task.creatorId,
		title: task.title,
		status: task.status,
		state: task.state,
		latestArtifactId: task.latestArtifactId,
		updatedAt: task.updatedAt,
	};
}

function appendAttachmentNotes(text: string, attachmentPaths: readonly string[]): string {
	if (attachmentPaths.length === 0) return text;
	return text + "\n\n用户上传图片：" + attachmentPaths.join("、");
}

function formatCardResults(cards: readonly IndexedCard[]): string {
	return cards.map((card) => {
		const metadata = [
			card.type,
			card.class,
			card.level === undefined ? undefined : "等级" + card.level,
			card.cost === undefined ? undefined : "费用" + card.cost,
		].filter(Boolean).join(" · ");
		const traits = card.traits.length > 0 ? "\n特性：" + card.traits.join("、") : "";
		const body = card.body ? "\n" + card.body : "";
		return "【" + card.name_zh + "】" + (metadata ? "\n" + metadata : "") + traits + body;
	}).join("\n\n");
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
}

function parseSummary(text: string): { summary: string; keywords: string[] } {
	const unwrapped = unwrapCodeFence(text);
	try {
		const value = JSON.parse(unwrapped) as Record<string, unknown>;
		const summary = typeof value.summary === "string" ? value.summary.trim() : "";
		const keywords = Array.isArray(value.keywords)
			? value.keywords.filter((item): item is string => typeof item === "string").slice(0, 8)
			: [];
		return { summary: summary || "旧对话已沉淀。", keywords };
	} catch {
		return { summary: text.trim() || "旧对话已沉淀。", keywords: [] };
	}
}

function unwrapCodeFence(text: string): string {
	const trimmed = text.trim();
	const fence = String.fromCharCode(96, 96, 96);
	if (!trimmed.startsWith(fence)) return trimmed;
	const lineEnd = trimmed.indexOf("\n");
	const lastFence = trimmed.lastIndexOf(fence);
	return lineEnd >= 0 && lastFence > lineEnd
		? trimmed.slice(lineEnd + 1, lastFence).trim()
		: trimmed;
}

class Semaphore {
	private active = 0;
	private readonly queue: Array<() => void> = [];

	constructor(private readonly limit: number) {
		if (!Number.isInteger(limit) || limit < 1) throw new Error("并发上限必须是正整数");
	}

	acquire(): Promise<() => void> {
		if (this.active < this.limit) {
			this.active++;
			return Promise.resolve(this.release);
		}
		return new Promise((resolve) => {
			this.queue.push(() => {
				this.active++;
				resolve(this.release);
			});
		});
	}

	private release = (): void => {
		this.active--;
		this.queue.shift()?.();
	};
}
