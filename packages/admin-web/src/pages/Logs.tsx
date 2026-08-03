import { useEffect, useRef, useState } from "react";
import { Table, Tag, Input, Select, Space, Typography, Card, Switch, Button } from "antd";
import { api } from "../api/client";
import type { Bot, LogEntry, PagedResult } from "../api/types";
import { fmtTime, truncate } from "../utils";

export default function LogsPage() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [data, setData] = useState<PagedResult<LogEntry>>({ items: [], page: 1, size: 100, total: 0 });
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ level: "", source: "", botId: "", q: "" });
  const [page, setPage] = useState(1);
  const [live, setLive] = useState(false);
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    api.listBots().then((r) => setBots(r.items));
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      setData(await api.listLogs({ ...filters, page, size: 100 }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [filters, page]);

  // SSE 实时尾随。
  useEffect(() => {
    if (!live) {
      esRef.current?.close();
      esRef.current = null;
      return;
    }
    setLiveLogs([]);
    const es = new EventSource("/api/logs/stream");
    esRef.current = es;
    es.addEventListener("log", (e: MessageEvent) => {
      try {
        const entry = JSON.parse(e.data) as LogEntry;
        setLiveLogs((prev) => {
          const next = [...prev, entry];
          return next.length > 500 ? next.slice(next.length - 500) : next;
        });
      } catch {
        /* ignore parse error */
      }
    });
    es.onerror = () => {
      // EventSource 会自动重连；这里不打断。
    };
    return () => es.close();
  }, [live]);

  const applyFilter = (key: keyof typeof filters, value: string) => {
    setPage(1);
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const levelColor: Record<string, string> = { debug: "default", info: "blue", warn: "orange", error: "red" };
  const columns = [
    { title: "时间", dataIndex: "ts", width: 170, render: fmtTime },
    { title: "级别", dataIndex: "level", width: 70, render: (v: string) => <Tag color={levelColor[v]}>{v}</Tag> },
    { title: "来源", dataIndex: "source", width: 130 },
    { title: "机器人", dataIndex: "botId", width: 120, ellipsis: true, render: (v: string | null) => truncate(v ?? "", 16) },
    { title: "消息", dataIndex: "message", ellipsis: true, render: (t: string) => truncate(t, 100) },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: "space-between", width: "100%" }}>
        <Typography.Title level={4} style={{ margin: 0 }}>日志</Typography.Title>
        <Space>
          <span>实时尾随</span>
          <Switch checked={live} onChange={setLive} />
          {live && <Button size="small" onClick={() => setLiveLogs([])}>清屏</Button>}
        </Space>
      </Space>

      {live ? (
        <Card size="small" title={`实时日志（${liveLogs.length}）`} bodyStyle={{ maxHeight: "60vh", overflow: "auto" }}>
          {liveLogs.map((l) => (
            <div key={l.id} style={{ padding: "2px 0", borderBottom: "1px solid #f0f0f0", fontSize: 12 }}>
              <Tag color={levelColor[l.level]} style={{ marginRight: 8 }}>{l.level}</Tag>
              <span style={{ color: "#999", marginRight: 8 }}>{fmtTime(l.ts)}</span>
              <span style={{ color: "#666", marginRight: 8 }}>[{l.source}]{l.botId ? `(${l.botId.slice(0, 12)})` : ""}</span>
              <span>{l.message}</span>
              {l.fields && <span style={{ color: "#999", marginLeft: 8 }}>{truncate(l.fields, 80)}</span>}
            </div>
          ))}
        </Card>
      ) : (
        <>
          <Card size="small" style={{ marginBottom: 16 }}>
            <Space wrap>
              <Select
                placeholder="级别"
                allowClear
                style={{ width: 110 }}
                value={filters.level || undefined}
                onChange={(v) => applyFilter("level", v ?? "")}
                options={["debug", "info", "warn", "error"].map((l) => ({ label: l, value: l }))}
              />
              <Input
                placeholder="来源"
                allowClear
                style={{ width: 140 }}
                value={filters.source}
                onChange={(e) => applyFilter("source", e.target.value)}
              />
              <Select
                placeholder="机器人"
                allowClear
                style={{ width: 180 }}
                value={filters.botId || undefined}
                onChange={(v) => applyFilter("botId", v ?? "")}
                options={bots.map((b) => ({ label: b.name, value: b.id }))}
              />
              <Input.Search
                placeholder="搜索日志"
                allowClear
                style={{ width: 200 }}
                onSearch={(v) => applyFilter("q", v)}
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
                <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                  {r.message}
                  {r.fields ? `\n\n字段: ${r.fields}` : ""}
                </pre>
              ),
            }}
            columns={columns}
          />
        </>
      )}
    </div>
  );
}
