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
  memoryCount: number;
  activeTaskCount: number;
  active: boolean;
}

export interface ScopeDetail {
  scope: { kind: "group" | "user"; id: string };
  systemPrompt: string;
  tools: { name: string; description: string }[];
  messages: ConversationEvent[];
  messageCount: number;
  lastActivityAt: number;
  tasks: AgentTask[];
  memories: MemoryEntry[];
  segments: ConversationSegment[];
}

export interface ConversationEvent {
  id: number;
  taskId: string | null;
  direction: "in" | "out";
  senderId: string | null;
  visibleText: string;
  tokenCount: number;
  compacted: boolean;
  createdAt: number;
}

export interface AgentTask {
  id: string;
  scene: string;
  creatorId: string;
  title: string;
  status: string;
  state: Record<string, unknown>;
  latestArtifactId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryEntry {
  id: number;
  category: string;
  content: string;
  triggers: string[];
  status: "active" | "archived";
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationSegment {
  id: number;
  firstEventId: number;
  lastEventId: number;
  summary: string;
  keywords: string[];
  tokenCount: number;
  createdAt: number;
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

export interface PromptBundle {
  version: number;
  loadedAt: number;
  hash: string;
  characterCount: number;
  estimatedTokens: number;
  items: Array<{
    id: string;
    content: string;
    characterCount: number;
    estimatedTokens: number;
  }>;
}

export interface UsageSummary {
  runs: number;
  modelCalls: number;
  inputTokensTotal: number;
  inputTokensUncached: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  cacheHitRate: number;
  p50DurationMs: number;
  p95DurationMs: number;
  failures: number;
  byScene: Array<{
    scene: string;
    runs: number;
    avgDurationMs: number;
    modelCalls: number;
    toolCalls: number;
  }>;
}

export interface UsageWindows {
  lastHour: UsageSummary;
  last24Hours: UsageSummary;
  last7Days: UsageSummary;
  all: UsageSummary;
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
