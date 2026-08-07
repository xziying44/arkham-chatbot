import { useEffect, useState } from "react";
import { Alert, Col, Row, Segmented, Spin, Statistic, Table, Typography } from "antd";
import { api } from "../api/client";
import type { UsageSummary, UsageWindows } from "../api/types";

type WindowKey = keyof UsageWindows;

export default function Usage() {
  const [data, setData] = useState<UsageWindows | null>(null);
  const [error, setError] = useState<string>();
  const [windowKey, setWindowKey] = useState<WindowKey>("last24Hours");

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await api.getUsage();
        if (!isUsageWindows(next)) {
          throw new Error("用量接口与管理页面版本不一致，请重启后端服务后刷新页面");
        }
        if (active) {
          setData(next);
          setError(undefined);
        }
      } catch (loadError) {
        if (active) setError(errorMessage(loadError));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  if (!data) return error ? <Alert type="error" showIcon message="无法加载模型用量" description={error} /> : <Spin />;
  const summary: UsageSummary = data[windowKey];
  return (
    <div>
      {error && <Alert type="warning" showIcon message="用量刷新失败" description={error} style={{ marginBottom: 16 }} />}
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

function isUsageWindows(value: unknown): value is UsageWindows {
  if (!value || typeof value !== "object") return false;
  const windows = value as Record<string, unknown>;
  return ["lastHour", "last24Hours", "last7Days", "all"].every((key) => isUsageSummary(windows[key]));
}

function isUsageSummary(value: unknown): value is UsageSummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Record<string, unknown>;
  return typeof summary.runs === "number"
    && typeof summary.modelCalls === "number"
    && typeof summary.cacheHitRate === "number"
    && Array.isArray(summary.byScene);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
