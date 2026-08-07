import { useEffect, useState } from "react";
import { Col, Row, Segmented, Spin, Statistic, Table, Typography } from "antd";
import { api } from "../api/client";
import type { UsageSummary, UsageWindows } from "../api/types";

type WindowKey = keyof UsageWindows;

export default function Usage() {
  const [data, setData] = useState<UsageWindows | null>(null);
  const [windowKey, setWindowKey] = useState<WindowKey>("last24Hours");

  useEffect(() => {
    const load = () => api.getUsage().then(setData);
    void load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, []);

  if (!data) return <Spin />;
  const summary: UsageSummary = data[windowKey];
  return (
    <div>
      <Row align="middle" justify="space-between" style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>模型用量</Typography.Title>
        <Segmented
          value={windowKey}
          onChange={(value) => setWindowKey(value as WindowKey)}
          options={[
            { label: "1 小时", value: "lastHour" },
            { label: "24 小时", value: "last24Hours" },
            { label: "7 天", value: "last7Days" },
            { label: "全部", value: "all" },
          ]}
        />
      </Row>
      <Row gutter={[24, 20]} style={{ marginBottom: 24 }}>
        <Col xs={12} lg={4}><Statistic title="回合" value={summary.runs} /></Col>
        <Col xs={12} lg={4}><Statistic title="模型调用" value={summary.modelCalls} /></Col>
        <Col xs={12} lg={4}><Statistic title="缓存命中" value={summary.cacheHitRate * 100} precision={1} suffix="%" /></Col>
        <Col xs={12} lg={4}><Statistic title="输入 Token" value={summary.inputTokensTotal} /></Col>
        <Col xs={12} lg={4}><Statistic title="P50 延迟" value={summary.p50DurationMs} suffix="ms" /></Col>
        <Col xs={12} lg={4}><Statistic title="P95 延迟" value={summary.p95DurationMs} suffix="ms" /></Col>
      </Row>
      <Table
        size="small"
        rowKey="scene"
        pagination={false}
        dataSource={summary.byScene}
        columns={[
          { title: "场景", dataIndex: "scene" },
          { title: "回合", dataIndex: "runs", width: 100 },
          { title: "平均延迟", dataIndex: "avgDurationMs", width: 130, render: (value: number) => value + " ms" },
          { title: "模型调用", dataIndex: "modelCalls", width: 110 },
          { title: "能力调用", dataIndex: "toolCalls", width: 110 },
        ]}
      />
    </div>
  );
}
