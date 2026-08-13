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
  /** 群成员会话的成员 openid（私聊 undefined）。 */
  memberId?: string;
  lastActivityAt: number;
  ttlRemainingMs: number;
  messageCount: number;
}

export interface ScopeDetail {
  scope: { kind: "group" | "user"; id: string };
  memberId?: string;
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

/** 会话完整归档记录（含工具调用/结果）。 */
export interface ConversationRecord {
  id: string;
  botId: string;
  scopeKind: string;
  scopeId: string;
  memberId: string | null;
  runId: string | null;
  ts: number;
  role: string;
  /** 完整 content blocks 的 JSON 字符串。 */
  contentJson: string;
  stopReason: string | null;
  model: string | null;
}

/** 训练样本列表项（不含 sample_json，轻量）。 */
export interface TrainingSampleListItem {
  id: string;
  botId: string;
  scopeKind: string;
  scopeId: string;
  memberId: string | null;
  ts: number;
  preview: string | null;
  messageCount: number | null;
  status: string | null;
  createdAt: number;
}

/** 训练样本完整记录（含 sample_json）。 */
export interface TrainingSampleRecord extends TrainingSampleListItem {
  sampleJson: string;
}

/** 按 scope 聚合的会话摘要（导航用）。 */
export interface ConversationScopeSummary {
  scopeKind: string;
  scopeId: string;
  memberId: string | null;
  summary: string | null;
  messageCount: number;
  firstTs: number | null;
  lastTs: number | null;
  updatedAt: number;
  hasSummary: boolean;
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
