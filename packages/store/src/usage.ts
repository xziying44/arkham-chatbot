import type { DatabaseSync } from "./db.ts";
import type { RuntimeScope, SceneId } from "./agent-runtime.ts";

export interface NormalizedUsage {
	readonly inputTokensTotal: number;
	readonly inputTokensUncached: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly outputTokens: number;
}

export interface UsageSummary {
	readonly runs: number;
	readonly modelCalls: number;
	readonly inputTokensTotal: number;
	readonly inputTokensUncached: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly outputTokens: number;
	readonly cacheHitRate: number;
	readonly p50DurationMs: number;
	readonly p95DurationMs: number;
	readonly failures: number;
	readonly byScene: Array<{
		scene: string;
		runs: number;
		avgDurationMs: number;
		modelCalls: number;
		toolCalls: number;
	}>;
}

export class UsageRepository {
	constructor(private readonly db: DatabaseSync) {}

	startRun(input: RuntimeScope & {
		id: string;
		taskId?: string | null;
		scene: SceneId;
		routeMethod: "rule" | "model" | "direct";
		queueDurationMs?: number;
		startedAt?: number;
	}): void {
		this.db.prepare(
			"INSERT INTO agent_runs " +
			"(id, bot_id, scope_kind, scope_id, task_id, scene, route_method, started_at, queue_duration_ms, status) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')",
		).run(
			input.id,
			input.botId,
			input.scopeKind,
			input.scopeId,
			input.taskId ?? null,
			input.scene,
			input.routeMethod,
			input.startedAt ?? Date.now(),
			input.queueDurationMs ?? 0,
		);
	}

	finishRun(id: string, input: {
		status: "ok" | "error" | "cancelled";
		firstFeedbackMs?: number | null;
		modelCallCount: number;
		toolCallCount: number;
		error?: string | null;
		completedAt?: number;
	}): void {
		const completedAt = input.completedAt ?? Date.now();
		this.db.prepare(
			"UPDATE agent_runs SET completed_at = ?, duration_ms = ? - started_at, first_feedback_ms = ?, " +
			"model_call_count = ?, tool_call_count = ?, status = ?, error = ? WHERE id = ?",
		).run(
			completedAt,
			completedAt,
			input.firstFeedbackMs ?? null,
			input.modelCallCount,
			input.toolCallCount,
			input.status,
			input.error ?? null,
			id,
		);
	}

	insertModelCall(input: {
		runId: string;
		sequence: number;
		provider: string;
		api: string;
		model: string;
		startedAt: number;
		durationMs: number;
		usage: NormalizedUsage;
		toolCallCount: number;
		stopReason?: string | null;
		status: "ok" | "error" | "aborted";
		error?: string | null;
	}): void {
		this.db.prepare(
			"INSERT INTO model_calls " +
			"(run_id, sequence, provider, api, model, started_at, duration_ms, input_tokens_total, input_tokens_uncached, " +
			"cache_read_tokens, cache_write_tokens, output_tokens, tool_call_count, stop_reason, status, error) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			input.runId,
			input.sequence,
			input.provider,
			input.api,
			input.model,
			input.startedAt,
			input.durationMs,
			input.usage.inputTokensTotal,
			input.usage.inputTokensUncached,
			input.usage.cacheReadTokens,
			input.usage.cacheWriteTokens,
			input.usage.outputTokens,
			input.toolCallCount,
			input.stopReason ?? null,
			input.status,
			input.error ?? null,
		);
	}

	summary(since = 0): UsageSummary {
		const runRows = this.db.prepare(
			"SELECT duration_ms, status FROM agent_runs WHERE started_at >= ? AND status <> 'running'",
		).all(since) as Array<{ duration_ms: number | null; status: string }>;
		const call = this.db.prepare(
			"SELECT COUNT(*) AS calls, " +
			"COALESCE(SUM(input_tokens_total), 0) AS input_total, " +
			"COALESCE(SUM(input_tokens_uncached), 0) AS input_uncached, " +
			"COALESCE(SUM(cache_read_tokens), 0) AS cache_read, " +
			"COALESCE(SUM(cache_write_tokens), 0) AS cache_write, " +
			"COALESCE(SUM(output_tokens), 0) AS output " +
			"FROM model_calls WHERE started_at >= ?",
		).get(since) as Record<string, number>;
		const sceneRows = this.db.prepare(
			"SELECT scene, COUNT(*) AS runs, COALESCE(AVG(duration_ms), 0) AS avg_duration, " +
			"COALESCE(SUM(model_call_count), 0) AS model_calls, COALESCE(SUM(tool_call_count), 0) AS tool_calls " +
			"FROM agent_runs WHERE started_at >= ? AND status <> 'running' GROUP BY scene ORDER BY runs DESC",
		).all(since) as Array<Record<string, number | string>>;
		const durations = runRows
			.map((row) => Number(row.duration_ms ?? 0))
			.filter((value) => value >= 0)
			.sort((a, b) => a - b);
		const inputTotal = Number(call.input_total ?? 0);
		const cacheRead = Number(call.cache_read ?? 0);
		return {
			runs: runRows.length,
			modelCalls: Number(call.calls ?? 0),
			inputTokensTotal: inputTotal,
			inputTokensUncached: Number(call.input_uncached ?? 0),
			cacheReadTokens: cacheRead,
			cacheWriteTokens: Number(call.cache_write ?? 0),
			outputTokens: Number(call.output ?? 0),
			cacheHitRate: inputTotal > 0 ? cacheRead / inputTotal : 0,
			p50DurationMs: percentile(durations, 0.5),
			p95DurationMs: percentile(durations, 0.95),
			failures: runRows.filter((row) => row.status === "error").length,
			byScene: sceneRows.map((row) => ({
				scene: String(row.scene),
				runs: Number(row.runs),
				avgDurationMs: Math.round(Number(row.avg_duration)),
				modelCalls: Number(row.model_calls),
				toolCalls: Number(row.tool_calls),
			})),
		};
	}
}

function percentile(values: readonly number[], quantile: number): number {
	if (values.length === 0) return 0;
	const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1));
	return values[index];
}
