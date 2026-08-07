import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Descriptions, Empty, Space, Spin, Table, Tabs, Tag, Typography, App as AntdApp } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import type { ScopeDetail } from "../api/types";
import { fmtTime } from "../utils";

export default function SessionDetailV2() {
  const { botId = "", kind = "", scopeId = "" } = useParams();
  const nav = useNavigate();
  const { message } = AntdApp.useApp();
  const [detail, setDetail] = useState<ScopeDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getScopeDetail(botId, kind, scopeId)
      .then(setDetail)
      .catch((error) => message.error((error as Error).message))
      .finally(() => setLoading(false));
  }, [botId, kind, scopeId]);

  if (loading) return <Spin />;
  if (!detail) return <Empty description="会话不存在" />;
  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav("/sessions")} />
        <Typography.Title level={4} style={{ margin: 0 }}>{detail.scope.id}</Typography.Title>
        <Tag color={detail.scope.kind === "group" ? "blue" : "green"}>{detail.scope.kind === "group" ? "群" : "私聊"}</Tag>
      </Space>
      <Descriptions size="small" bordered column={3} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="最后活动">{fmtTime(detail.lastActivityAt)}</Descriptions.Item>
        <Descriptions.Item label="事件">{detail.messageCount}</Descriptions.Item>
        <Descriptions.Item label="热窗口 Token">{detail.messages.reduce((sum, item) => sum + item.tokenCount, 0)}</Descriptions.Item>
      </Descriptions>
      <Tabs items={[
        {
          key: "events",
          label: "热窗口",
          children: <Table size="small" rowKey="id" pagination={false} dataSource={detail.messages} columns={[
            { title: "时间", dataIndex: "createdAt", width: 170, render: fmtTime },
            { title: "方向", dataIndex: "direction", width: 70, render: (value: string) => <Tag color={value === "in" ? "blue" : "green"}>{value}</Tag> },
            { title: "发送者", dataIndex: "senderId", width: 140, ellipsis: true },
            { title: "内容", dataIndex: "visibleText", ellipsis: true },
            { title: "Token", dataIndex: "tokenCount", width: 80 },
          ]} />,
        },
        {
          key: "tasks",
          label: "任务 " + detail.tasks.length,
          children: <Table size="small" rowKey="id" pagination={false} dataSource={detail.tasks} columns={[
            { title: "标题", dataIndex: "title" },
            { title: "场景", dataIndex: "scene", width: 120 },
            { title: "创建者", dataIndex: "creatorId", width: 140, ellipsis: true },
            { title: "状态", dataIndex: "status", width: 100, render: (value: string) => <Tag>{value}</Tag> },
            { title: "更新时间", dataIndex: "updatedAt", width: 170, render: fmtTime },
          ]} />,
        },
        {
          key: "memories",
          label: "记忆 " + detail.memories.length,
          children: <Table size="small" rowKey="id" pagination={false} dataSource={detail.memories} columns={[
            { title: "分类", dataIndex: "category", width: 90 },
            { title: "内容", dataIndex: "content" },
            { title: "触发词", dataIndex: "triggers", width: 220, render: (items: string[]) => items.map((item) => <Tag key={item}>{item}</Tag>) },
            { title: "命中", dataIndex: "useCount", width: 70 },
          ]} />,
        },
        {
          key: "segments",
          label: "沉淀 " + detail.segments.length,
          children: <Table size="small" rowKey="id" pagination={false} dataSource={detail.segments} columns={[
            { title: "摘要", dataIndex: "summary" },
            { title: "关键词", dataIndex: "keywords", width: 240, render: (items: string[]) => items.map((item) => <Tag key={item}>{item}</Tag>) },
            { title: "Token", dataIndex: "tokenCount", width: 80 },
            { title: "时间", dataIndex: "createdAt", width: 170, render: fmtTime },
          ]} />,
        },
      ]} />
    </div>
  );
}
