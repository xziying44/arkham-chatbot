/**
 * API 客户端：fetch 封装，自动带 cookie，统一错误处理。
 * 所有方法返回 JSON；非 2xx 抛错（含后端 error 字段）。
 */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    // 仅在「需要登录的接口」上 401 才跳登录页。
    // /api/auth/login 的 401 是「用户名或密码错误」，必须把错误抛给登录页显示，不能跳转。
    if (res.status === 401 && !path.startsWith("/api/auth/login")) {
      window.location.hash = "#/login";
    }
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

export const api = {
  // auth
  login: (username: string, password: string) =>
    request<{ ok: true; username: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ username: string }>("/api/auth/me"),

  // bots
  listBots: () => request<{ items: import("./types").Bot[] }>("/api/bots"),
  getBot: (id: string) => request<import("./types").Bot>(`/api/bots/${id}`),
  createBot: (data: Partial<import("./types").Bot>) =>
    request<import("./types").Bot>("/api/bots", { method: "POST", body: JSON.stringify(data) }),
  updateBot: (id: string, data: Partial<import("./types").Bot>) =>
    request<import("./types").Bot>(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  startBot: (id: string) => request<{ ok: true }>(`/api/bots/${id}/start`, { method: "POST" }),
  stopBot: (id: string) => request<{ ok: true }>(`/api/bots/${id}/stop`, { method: "POST" }),
  deleteBot: (id: string, deleteData = false) =>
    request<{ ok: true }>(`/api/bots/${id}?deleteData=${deleteData}`, { method: "DELETE" }),

  // sessions
  listSessions: (botId: string) =>
    request<{ items: import("./types").ActiveScope[] }>(`/api/bots/${botId}/sessions`),
  getScopeDetail: (botId: string, kind: string, scopeId: string) =>
    request<import("./types").ScopeDetail>(`/api/bots/${botId}/sessions/${kind}/${scopeId}`),
  forceReap: (botId: string, kind: string, scopeId: string) =>
    request<{ ok: boolean }>(`/api/bots/${botId}/sessions/${kind}/${scopeId}`, { method: "DELETE" }),

  // memories（审计）
  listScopes: (botId: string) =>
    request<{ items: { kind: "group" | "user"; id: string; label: string | null; memoryCount: number }[] }>(`/api/memories/${botId}/scopes`),
  setScopeLabel: (botId: string, kind: string, scopeId: string, label: string) =>
    request<{ ok: true }>(`/api/memories/${botId}/scopes/${kind}/${scopeId}/label`, { method: "PUT", body: JSON.stringify({ label }) }),
  deleteScopeLabel: (botId: string, kind: string, scopeId: string) =>
    request<{ ok: true }>(`/api/memories/${botId}/scopes/${kind}/${scopeId}/label`, { method: "DELETE" }),
  listMemories: (botId: string, kind: string, scopeId: string) =>
    request<{ index: string | null; files: { name: string; size: number }[] }>(`/api/memories/${botId}/${kind}/${scopeId}`),
  readMemory: (botId: string, kind: string, scopeId: string, name: string) =>
    request<string>(`/api/memories/${botId}/${kind}/${scopeId}/${name}`),
  writeMemory: (botId: string, kind: string, scopeId: string, name: string, content: string) =>
    request<{ ok: true }>(`/api/memories/${botId}/${kind}/${scopeId}/${name}`, { method: "PUT", body: content, headers: { "Content-Type": "text/plain" } }),
  deleteMemory: (botId: string, kind: string, scopeId: string, name: string) =>
    request<{ ok: true; note?: string }>(`/api/memories/${botId}/${kind}/${scopeId}/${name}`, { method: "DELETE" }),
  clearMemories: (botId: string, kind: string, scopeId: string) =>
    request<{ ok: true; note?: string }>(`/api/memories/${botId}/${kind}/${scopeId}/clear-memories`, { method: "POST" }),
  clearHistory: (botId: string, kind: string, scopeId: string) =>
    request<{ ok: true; note?: string }>(`/api/memories/${botId}/${kind}/${scopeId}/clear-history`, { method: "POST" }),

  // messages
  listMessages: (params: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
    return request<import("./types").PagedResult<import("./types").Message>>(`/api/messages?${qs}`);
  },

  // logs
  listLogs: (params: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
    return request<import("./types").PagedResult<import("./types").LogEntry>>(`/api/logs?${qs}`);
  },

  // settings
  getSettings: () => request<import("./types").Settings>("/api/settings"),
  updateSettings: (data: Record<string, string>) =>
    request<{ ok: true; changed: number; note?: string }>("/api/settings", { method: "PATCH", body: JSON.stringify(data) }),
  reapAll: () => request<{ ok: true; reaped: number }>("/api/settings/reap-all", { method: "POST" }),
  getPrompts: () => request<import("./types").PromptPreview>("/api/settings/prompts"),
};
