import { useEffect, useState } from "react";
import { Table, Tag, Input, Select, Space, Typography, Card, Tooltip, Button } from "antd";
import { DownloadOutlined, ArrowLeftOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import type { Bot, ConversationRecord, ConversationScopeSummary, PagedResult } from "../api/types";
import { fmtTime, truncate } from "../utils";

/**
 * 会话归档页面（两级视图）：
 * 1. scope 列表：每行一个会话，带 dispose 时 LLM 生成的摘要，点进去看详情。
 * 2. scope 详情：该 scope 的完整消息（含工具调用/结果），支持搜索 + 导出。
 *
 * 摘要来自 dispose 压缩的 compactionSummary（LLM 真正理解的「这段对话干了什么」），
 * 不是自动拼凑。还没 dispose 过的活跃会话无摘要（显示消息数 + 时间）。
 */
export default function Conversations() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [scopes, setScopes] = useState<ConversationScopeSummary[]>([]);
  const [selected, setSelected] = useState<ConversationScopeSummary | null>(null);
  const [loadingScopes, setLoadingScopes] = useState(false);
  const [botFilter, setBotFilter] = useState("");

  useEffect(() => {
    api.listBots().then((r) => {
      setBots(r.items);
      if (r.items.length > 0 && !botFilter) setBotFilter(r.items[0].id);
    });
  }, []);

  const loadScopes = async () => {
    if (!botFilter) return;
    setLoadingScopes(true);
    try {
      setScopes(await api.listConversationScopes(botFilter));
    } finally {
      setLoadingScopes(false);
    }
  };

  useEffect(() => {
    loadScopes();
  }, [botFilter]);

  if (selected) {
    return (
      <ScopeDetail
        scope={selected}
        botId={botFilter}
        onBack={() => {
          setSelected(null);
          loadScopes();
        }}
      />
    );
  }

  return (
    <div>
      <Typography.Title level={4}>会话归档</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: -8, marginBottom: 16 }}>
        每行一段会话，摘要来自会话结束时的压缩总结。点击查看完整对话（含工具调用）。
      </Typography.Paragraph>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space>
          <Select
            placeholder="机器人"
            style={{ width: 200 }}
            value={botFilter || undefined}
            onChange={(v) => setBotFilter(v ?? "")}
            options={bots.map((b) => ({ label: b.name, value: b.id }))}
          />
        </Space>
      </Card>

      <Table<ConversationScopeSummary>
        size="small"
        loading={loadingScopes}
        dataSource={scopes}
        rowKey={(r) => `${r.scopeKind}:${r.scopeId}:${r.memberId ?? ""}`}
        pagination={{ pageSize: 50, showTotal: (t) => `共 ${t} 个会话` }}
        onRow={(r) => ({ onClick: () => setSelected(r), style: { cursor: "pointer" } })}
        columns={[
          { title: "类型", width: 70, render: (_: unknown, r: ConversationScopeSummary) => (
            <Tag color={r.scopeKind === "group" ? "blue" : "green"}>{r.scopeKind === "group" ? "群" : "私聊"}</Tag>
          ) },
          { title: "摘要", dataIndex: "summary", render: (s: string | null, r: ConversationScopeSummary) => (
            <div>
              {s ? (
                <Typography.Text>{truncate(s, 120)}</Typography.Text>
              ) : (
                <Typography.Text type="secondary" italic>（活跃中，尚未生成摘要）</Typography.Text>
              )}
              {r.memberId && <Tag style={{ marginLeft: 8 }}>成员</Tag>}
            </div>
          ) },
          { title: "消息数", dataIndex: "messageCount", width: 80, align: "center" as const },
          { title: "最后活动", dataIndex: "lastTs", width: 170, render: (t: number | null) => (t ? fmtTime(t) : "-") },
        ]}
      />
    </div>
  );
}

/** scope 详情：完整消息列表。 */
function ScopeDetail({ scope, botId, onBack }: { scope: ConversationScopeSummary; botId: string; onBack: () => void }) {
  const [data, setData] = useState<PagedResult<ConversationRecord>>({ items: [], page: 1, size: 100, total: 0 });
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const load = async () => {
    setLoading(true);
    try {
      setData(await api.listConversations({ botId, scopeKind: scope.scopeKind, scopeId: scope.scopeId, search, page, size: 100 }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [search, page]);

  const exportJsonl = () => {
    const qs = new URLSearchParams({ botId, scopeKind: scope.scopeKind, scopeId: scope.scopeId });
    api.rawGet(`/api/conversations/export?${qs}`).then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `conversations-${scope.scopeId.slice(0, 8)}-${Date.now()}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  return (
    <div>
      <Space style={{ marginBottom: 16, width: "100%" }} direction="vertical">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={onBack}>返回列表</Button>
          <Tag color={scope.scopeKind === "group" ? "blue" : "green"}>{scope.scopeKind === "group" ? "群" : "私聊"}</Tag>
          {scope.memberId && <Tag>成员会话</Tag>}
          <Typography.Text type="secondary">{scope.messageCount} 条消息</Typography.Text>
        </Space>
        {scope.summary && (
          <Card size="small" style={{ background: "#fafafa" }}>
            <Typography.Text strong style={{ fontSize: 12 }}>会话摘要（dispose 压缩生成）</Typography.Text>
            <Typography.Paragraph style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{scope.summary}</Typography.Paragraph>
          </Card>
        )}
      </Space>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space>
          <Input.Search
            placeholder="搜索这段对话的内容（含工具调用）"
            allowClear
            style={{ width: 300 }}
            onSearch={(v) => { setSearch(v); setPage(1); }}
          />
          <Button icon={<DownloadOutlined />} onClick={exportJsonl}>导出 JSONL</Button>
        </Space>
      </Card>

      <Table<ConversationRecord>
        size="small"
        loading={loading}
        dataSource={data.items}
        rowKey="id"
        pagination={{
          current: data.page,
          pageSize: data.size,
          total: data.total,
          onChange: setPage,
          showTotal: (t) => `共 ${t} 条`,
        }}
        expandable={{ expandedRowRender: (r) => <ConversationContent record={r} />, rowExpandable: () => true }}
        columns={[
          { title: "时间", dataIndex: "ts", width: 170, render: fmtTime },
          { title: "角色", dataIndex: "role", width: 100, render: (r: string) => <RoleTag role={r} /> },
          { title: "内容概要", render: (_: unknown, r: ConversationRecord) => <ContentSummary record={r} /> },
          {
            title: "stop",
            dataIndex: "stopReason",
            width: 90,
            render: (s: string | null) => (s ? <Tag color={s === "toolUse" ? "orange" : s === "error" ? "red" : "default"}>{s}</Tag> : "-"),
          },
        ]}
      />
    </div>
  );
}

/** 角色 Tag。 */
function RoleTag({ role }: { role: string }) {
  const color = role === "user" ? "blue" : role === "assistant" ? "purple" : role === "toolResult" ? "cyan" : "default";
  const label = role === "user" ? "用户" : role === "assistant" ? "助手" : role === "toolResult" ? "工具结果" : role;
  return <Tag color={color}>{label}</Tag>;
}

/** 内容概要。 */
function ContentSummary({ record }: { record: ConversationRecord }) {
  let blocks: unknown;
  try {
    blocks = JSON.parse(record.contentJson);
  } catch {
    return <Typography.Text type="secondary">（解析失败）</Typography.Text>;
  }
  if (!Array.isArray(blocks)) return <span>{truncate(String(blocks), 80)}</span>;
  const parts: string[] = [];
  for (const b of blocks as Array<Record<string, unknown>>) {
    if (b.type === "text" && b.text) parts.push(String(b.text));
    else if (b.type === "toolCall" && b.name) parts.push(`🔧 ${b.name}`);
    else if (b.type === "toolResult" && b.toolName) parts.push(`📋 ${b.toolName}`);
    else if (b.type === "thinking") parts.push("💭 思考");
  }
  return <span>{truncate(parts.join(" | ") || "（空）", 100)}</span>;
}

/** 展开行：完整 content blocks。 */
function ConversationContent({ record }: { record: ConversationRecord }) {
  let blocks: unknown;
  try {
    blocks = JSON.parse(record.contentJson);
  } catch {
    return <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{record.contentJson}</pre>;
  }
  if (!Array.isArray(blocks)) return <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{String(blocks)}</pre>;
  return (
    <div>
      {record.model && <Typography.Text type="secondary" style={{ fontSize: 12 }}>模型: {record.model}</Typography.Text>}
      {(blocks as Array<Record<string, unknown>>).map((b, i) => <BlockView key={i} block={b} />)}
    </div>
  );
}

/** 单个 content block 渲染。 */
function BlockView({ block }: { block: Record<string, unknown> }) {
  const type = block.type as string;
  if (type === "text") {
    return (
      <div style={{ margin: "4px 0", padding: 8, background: "#fafafa", borderRadius: 4 }}>
        <Typography.Text>{String(block.text ?? "")}</Typography.Text>
      </div>
    );
  }
  if (type === "thinking") {
    return (
      <Tooltip title="reasoning_content（思考链）">
        <div style={{ margin: "4px 0", padding: 8, background: "#f0f5ff", borderRadius: 4, borderLeft: "3px solid #adc6ff" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>💭 思考</Typography.Text>
          <Typography.Paragraph style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", color: "#597ef7" }}>
            {String(block.thinking ?? "")}
          </Typography.Paragraph>
        </div>
      </Tooltip>
    );
  }
  if (type === "toolCall") {
    return (
      <div style={{ margin: "4px 0", padding: 8, background: "#fff7e6", borderRadius: 4, borderLeft: "3px solid #ffd591" }}>
        <Typography.Text strong style={{ fontSize: 12 }}>🔧 {String(block.name ?? "")}</Typography.Text>
        <pre style={{ whiteSpace: "pre-wrap", margin: "4px 0 0", fontSize: 12 }}>
          {JSON.stringify(block.arguments ?? block.input ?? {}, null, 2)}
        </pre>
      </div>
    );
  }
  if (type === "toolResult") {
    const content = block.content as Array<{ type: string; text?: string }> | undefined;
    return (
      <div style={{ margin: "4px 0", padding: 8, background: "#e6fffb", borderRadius: 4, borderLeft: "3px solid #87e8de" }}>
        <Typography.Text strong style={{ fontSize: 12 }}>
          📋 {String(block.toolName ?? "")} {block.isError ? <Tag color="red">错误</Tag> : null}
        </Typography.Text>
        <pre style={{ whiteSpace: "pre-wrap", margin: "4px 0 0", fontSize: 12, maxHeight: 300, overflow: "auto" }}>
          {content?.map((c) => c.text ?? "").join("\n") ?? ""}
        </pre>
      </div>
    );
  }
  return <pre style={{ whiteSpace: "pre-wrap", margin: "4px 0", fontSize: 12 }}>{JSON.stringify(block, null, 2)}</pre>;
}
