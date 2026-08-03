/**
 * 会话作用域标识。一个 scope 对应一个独立的智能体实例、工作目录、会话记录与记忆。
 *
 * - `group`: 一群一智能体（默认）。
 * - `user`: 一用户一智能体（预留）。
 *
 * `id` 是 IM 平台无关的稳定标识：由 IM 适配器把平台原生 ID（如 QQ 的 group_openid）
 * 映射成 `{ kind, id }`。同一 scope 的 `id` 必须跨会话稳定，否则记忆与历史无法关联。
 */
export type ScopeKind = "group" | "user";

export interface ScopeKey {
	readonly kind: ScopeKind;
	readonly id: string;
}

/** 构造 group scope。 */
export function groupScope(id: string): ScopeKey {
	return { kind: "group", id };
}

/** 构造 user scope。 */
export function userScope(id: string): ScopeKey {
	return { kind: "user", id };
}

/** scope 的稳定字符串键，用于 Map/日志。 */
export function scopeKeyStr(scope: ScopeKey): string {
	return `${scope.kind}:${scope.id}`;
}
