/** 与后端 API 对齐的类型定义。 */

export interface Bot {
  id: string;
  appId: string;
  appSecret: string;
  name: string;
  apiBase: string;
  persona: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  // 运行时字段
  loaded: boolean;
  connectionState: string;
  connected: boolean;
  activeScopeCount: number;
}

export interface ActiveScope {
  key: string;
  scope: { kind: "group" | "user"; id: string };
  lastActivityAt: number;
  ttlRemainingMs: number;
  messageCount: number;
}

export interface ScopeDetail {
  scope: { kind: "group" | "user"; id: string };
  systemPrompt: string;
  tools: { name: string; description: string }[];
  messages: unknown[];
  messageCount: number;
  lastActivityAt: number;
}

export interface Message {
  id: number;
  botId: string;
  ts: number;
  direction: "in" | "out";
  scopeKind: "group" | "user";
  scopeId: string;
  senderId: string | null;
  senderName: string | null;
  text: string | null;
  platformMsgId: string | null;
  status: string | null;
  error: string | null;
}

export interface LogEntry {
  id: number;
  ts: number;
  level: "debug" | "info" | "warn" | "error";
  source: string | null;
  botId: string | null;
  scope: string | null;
  message: string;
  fields: string | null;
}

export interface PagedResult<T> {
  items: T[];
  page: number;
  size: number;
  total: number;
}

export interface Settings {
  [key: string]: string;
}

export interface PromptPreview {
  template: string;
  tools: { name: string; description: string }[];
}
