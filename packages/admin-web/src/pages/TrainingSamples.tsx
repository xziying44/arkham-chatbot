import { useEffect, useState } from "react";
import { Table, Tag, Select, Space, Typography, Card, Button, Drawer, Spin } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import type { Bot, TrainingSampleListItem, TrainingSampleRecord, PagedResult } from "../api/types";
import { fmtTime, truncate } from "../utils";

/**
 * 训练样本页面：每次 agent run 的完整自包含快照。
 * 列表展示 + 点击查看完整样本 JSON + 批量导出 jsonl。
 */
export default function TrainingSamples() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [data, setData] = useState<PagedResult<TrainingSampleListItem>>({ items: [], page: 1, size: 50, total: 0 });
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ botId: "", scopeKind: "", scopeId: "" });
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<TrainingSampleRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    api.listBots().then((r) => setBots(r.items));
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      setData(await api.listTrainingSamples({ ...filters, page, size: 50 }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [filters, page]);

  const applyFilter = (key: keyof typeof filters, value: string) => {
    setPage(1);
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    try {
      setDetail(await api.getTrainingSample(id));
    } finally {
      setDetailLoading(false);
    }
  };

  const exportAll = () => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v) qs.set(k, v);
    }
    api.rawGet(`/api/training-samples/export/all?${qs}`).then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `training-samples-${Date.now()}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  interface ParsedSample {
    systemPrompt?: string;
    userText?: string;
    messages?: unknown;
    model?: string;
    thinkingLevel?: string;
  }
  let parsedSample: ParsedSample | null = null;
  if (detail?.sampleJson) {
    try { parsedSample = JSON.parse(detail.sampleJson) as ParsedSample; } catch { /* */ }
  }

  return (
    <div>
      <Typography.Title level={4}>训练样本</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: -8, marginBottom: 16 }}>
        每次 agent 处理的完整快照（系统提示词 + 完整消息序列含工具调用/结果/思考链 + 元信息）。自包含，可直接用于训练。
      </Typography.Paragraph>

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
            placeholder="类型"
            allowClear
            style={{ width: 100 }}
            value={filters.scopeKind || undefined}
            onChange={(v) => applyFilter("scopeKind", v ?? "")}
            options={[{ label: "群", value: "group" }, { label: "私聊", value: "user" }]}
          />
          <Button icon={<DownloadOutlined />} onClick={exportAll} disabled={!data.items.length}>
            导出全部 JSONL
          </Button>
        </Space>
      </Card>

      <Table<TrainingSampleListItem>
        size="small"
        loading={loading}
        dataSource={data.items}
        rowKey="id"
        pagination={{
          current: data.page,
          pageSize: data.size,
          total: data.total,
          onChange: setPage,
          showTotal: (t) => `共 ${t} 个样本`,
        }}
        onRow={(r) => ({ onClick: () => openDetail(r.id), style: { cursor: "pointer" } })}
        columns={[
          { title: "时间", dataIndex: "ts", width: 170, render: fmtTime },
          { title: "类型", width: 70, render: (_: unknown, r: TrainingSampleListItem) => (
            <Tag color={r.scopeKind === "group" ? "blue" : "green"}>{r.scopeKind === "group" ? "群" : "私聊"}</Tag>
          ) },
          { title: "用户消息", dataIndex: "preview", render: (p: string | null) => p ? truncate(p, 60) : "（空）" },
          { title: "消息数", dataIndex: "messageCount", width: 80, align: "center" as const },
          { title: "状态", dataIndex: "status", width: 70, render: (s: string | null) => (s === "ok" ? <Tag color="green">成功</Tag> : s === "error" ? <Tag color="red">错误</Tag> : "-") },
        ]}
      />

      <Drawer
        width="70%"
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? `训练样本 ${detail.id.slice(0, 8)}…` : ""}
      >
        {detailLoading ? <Spin /> : (parsedSample ? (
          <div>
            <Card size="small" style={{ marginBottom: 12 }}>
              <Space wrap>
                <Tag color={detail!.scopeKind === "group" ? "blue" : "green"}>{detail!.scopeKind === "group" ? "群" : "私聊"}</Tag>
                <Typography.Text type="secondary">模型: {String(parsedSample.model ?? "?")}</Typography.Text>
                <Typography.Text type="secondary">thinkingLevel: {String(parsedSample.thinkingLevel ?? "?")}</Typography.Text>
                <Typography.Text type="secondary">消息数: {detail!.messageCount}</Typography.Text>
                <Typography.Text type="secondary">状态: {detail!.status}</Typography.Text>
              </Space>
            </Card>
            {parsedSample.systemPrompt ? (
              <Card size="small" title="系统提示词" style={{ marginBottom: 12 }}>
                <pre style={{ whiteSpace: "pre-wrap", margin: 0, maxHeight: 200, overflow: "auto", fontSize: 12 }}>
                  {parsedSample.systemPrompt}
                </pre>
              </Card>
            ) : null}
            <Card size="small" title="用户消息" style={{ marginBottom: 12 }}>
              <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 12 }}>{String(parsedSample.userText ?? "")}</pre>
            </Card>
            <Card size="small" title={`完整消息序列（${detail!.messageCount} 条）`}>
              <pre style={{ whiteSpace: "pre-wrap", margin: 0, maxHeight: 500, overflow: "auto", fontSize: 12 }}>
                {JSON.stringify(parsedSample.messages, null, 2)}
              </pre>
            </Card>
          </div>
        ) : null)}
      </Drawer>
    </div>
  );
}
