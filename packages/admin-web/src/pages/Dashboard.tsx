import { useEffect, useState } from "react";
import { Card, Col, Row, Statistic, Table, Tag, Typography } from "antd";
import { api } from "../api/client";
import type { Bot, LogEntry } from "../api/types";
import { fmtTime } from "../utils";

export default function Dashboard() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [b, l] = await Promise.all([api.listBots(), api.listLogs({ size: 5 })]);
      setBots(b.items);
      setLogs(l.items);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const online = bots.filter((b) => b.connected).length;
  const enabled = bots.filter((b) => b.enabled).length;
  const activeScopes = bots.reduce((s, b) => s + b.activeScopeCount, 0);
  const errors = logs.filter((l) => l.level === "error");

  const levelColor: Record<string, string> = { debug: "default", info: "blue", warn: "orange", error: "red" };

  return (
    <div>
      <Typography.Title level={4}>概览</Typography.Title>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic title="机器人总数" value={bots.length} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="在线" value={online} suffix={`/ ${enabled} 启用`} valueStyle={{ color: online > 0 ? "#3f8600" : "#cf1322" }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="活跃会话" value={activeScopes} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="最近错误" value={errors.length} valueStyle={{ color: errors.length > 0 ? "#cf1322" : "#3f8600" }} />
          </Card>
        </Col>
      </Row>

      <Typography.Title level={5}>最近日志</Typography.Title>
      <Table
        size="small"
        loading={loading}
        dataSource={logs}
        rowKey="id"
        pagination={false}
        columns={[
          { title: "时间", dataIndex: "ts", width: 180, render: fmtTime },
          { title: "级别", dataIndex: "level", width: 80, render: (v: string) => <Tag color={levelColor[v]}>{v}</Tag> },
          { title: "来源", dataIndex: "source", width: 120 },
          { title: "消息", dataIndex: "message" },
        ]}
      />
    </div>
  );
}
