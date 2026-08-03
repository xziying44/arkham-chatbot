import { useEffect, useState } from "react";
import { Table, Tag, Input, Select, Space, Typography, Card } from "antd";
import { api } from "../api/client";
import type { Bot, Message, PagedResult } from "../api/types";
import { fmtTime, truncate } from "../utils";

export default function MessagesPage() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [data, setData] = useState<PagedResult<Message>>({ items: [], page: 1, size: 50, total: 0 });
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ botId: "", scopeKind: "", scopeId: "", direction: "", text: "" });
  const [page, setPage] = useState(1);

  useEffect(() => {
    api.listBots().then((r) => setBots(r.items));
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      setData(await api.listMessages({ ...filters, page, size: 50 }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [filters, page]);

  const applyFilter = (key: keyof typeof filters, value: string) => {
    setPage(1);
    setFilters((f) => ({ ...f, [key]: value }));
  };

  return (
    <div>
      <Typography.Title level={4}>消息</Typography.Title>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select
            placeholder="机器人"
            allowClear
            style={{ width: 180 }}
            value={filters.botId || undefined}
            onChange={(v) => applyFilter("botId", v ?? "")}
            options={bots.map((b) => ({ label: b.name, value: b.id }))}
          />
          <Select
            placeholder="方向"
            allowClear
            style={{ width: 120 }}
            value={filters.direction || undefined}
            onChange={(v) => applyFilter("direction", v ?? "")}
            options={[{ label: "入站", value: "in" }, { label: "出站", value: "out" }]}
          />
          <Select
            placeholder="类型"
            allowClear
            style={{ width: 100 }}
            value={filters.scopeKind || undefined}
            onChange={(v) => applyFilter("scopeKind", v ?? "")}
            options={[{ label: "群", value: "group" }, { label: "私聊", value: "user" }]}
          />
          <Input
            placeholder="Scope ID"
            allowClear
            style={{ width: 220 }}
            value={filters.scopeId}
            onChange={(e) => applyFilter("scopeId", e.target.value)}
          />
          <Input.Search
            placeholder="搜索消息内容"
            allowClear
            style={{ width: 200 }}
            onSearch={(v) => applyFilter("text", v)}
          />
        </Space>
      </Card>

      <Table
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
        expandable={{
          expandedRowRender: (r) => (
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{r.text}{r.error ? `\n\n错误: ${r.error}` : ""}</pre>
          ),
          rowExpandable: (r) => !!r.text && r.text.length > 60,
        }}
        columns={[
          { title: "时间", dataIndex: "ts", width: 170, render: fmtTime },
          { title: "方向", dataIndex: "direction", width: 70, render: (d: string) => <Tag color={d === "in" ? "blue" : "green"}>{d === "in" ? "入" : "出"}</Tag> },
          { title: "机器人", dataIndex: "botId", width: 120, ellipsis: true },
          { title: "会话", width: 160, render: (_: unknown, r: Message) => <Tag color={r.scopeKind === "group" ? "blue" : "green"}>{r.scopeKind === "group" ? "群" : "私聊"}</Tag> },
          { title: "发送者", dataIndex: "senderName", width: 120, ellipsis: true },
          { title: "内容", dataIndex: "text", ellipsis: true, render: (t: string) => truncate(t) },
          { title: "状态", dataIndex: "status", width: 80, render: (s: string | null) => (s === "error" ? <Tag color="red">错误</Tag> : s === "ok" ? <Tag color="green">成功</Tag> : "-") },
        ]}
      />
    </div>
  );
}
