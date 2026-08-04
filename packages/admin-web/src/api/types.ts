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
  messages: AgentMessage[];
  messageCount: number;
  lastActivityAt: number;
}

/** pi-agent-core 的消息（只取前端渲染关心的字段）。 */
export interface AgentMessage {
  role: string;
  content?: unknown;
  // pi-agent-core 扩展消息可能带的字段
  command?: string;
  text?: string;
  toolName?: string;
  timestamp?: number;
  [key: string]: unknown;
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

export interface SkillSummary {
  name: string;
  description: string;
  dir: string;
  files: string[];
}

export interface SkillDetail {
  name: string;
  description: string;
  dir: string;
  filePath: string;
  content: string;
  body: string;
  attachments: { path: string; content: string }[];
}
