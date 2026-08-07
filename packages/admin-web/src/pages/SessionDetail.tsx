import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button, Descriptions, Tag, Typography, Space, Spin, Collapse, App as AntdApp, Empty } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import type { AgentMessage, ScopeDetail } from "../api/types";
import MessageList from "../components/MessageList";
import { fmtTime } from "../utils";

export default function SessionDetail() {
  const { botId = "", kind = "", scopeId = "" } = useParams();
  const nav = useNavigate();
  const { message } = AntdApp.useApp();
  const [detail, setDetail] = useState<ScopeDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!botId || !kind || !scopeId) return;
    setLoading(true);
    try {
      setDetail(await api.getScopeDetail(botId, kind, scopeId));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [botId, kind, scopeId]);

  const forceReap = async () => {
    try {
      const r = await api.forceReap(botId, kind, scopeId);
      message.success(r.ok ? "已回收" : "会话不存在");
      if (r.ok) nav("/sessions");
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  if (loading) return <Spin />;
  if (!detail) return <Empty description="会话不在活跃池中（可能已回收）" />;

  return (
    <div>
      <Space style={{ marginBottom: 16, width: "100%", justifyContent: "space-between" }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => nav("/sessions")}>返回</Button>
          <Typography.Title level={4} style={{ margin: 0 }}>
            <Tag color={detail.scope.kind === "group" ? "blue" : "green"}>{detail.scope.kind === "group" ? "群" : "私聊"}</Tag>
            {detail.scope.id}
          </Typography.Title>
        </Space>
        <Button danger onClick={forceReap}>强制回收</Button>
      </Space>

      <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
        <Descriptions.Item label="最后活动">{fmtTime(detail.lastActivityAt)}</Descriptions.Item>
        <Descriptions.Item label="消息总数">{detail.messageCount}</Descriptions.Item>
        <Descriptions.Item label="工具" span={2}>
          {detail.tools.map((t) => <Tag key={t.name}>{t.name}</Tag>)}
        </Descriptions.Item>
      </Descriptions>

      <Typography.Title level={5}>对话记录（最近 {detail.messages.length} 条，点击气泡看原始数据）</Typography.Title>
      <MessageList messages={detail.messages as unknown as AgentMessage[]} />

      <Collapse
        style={{ marginTop: 16 }}
        items={[
          {
            key: "prompt",
            label: "系统提示词",
            children: <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 300, overflow: "auto" }}>{detail.systemPrompt}</pre>,
          },
          {
            key: "tools",
            label: "工具描述",
            children: detail.tools.map((t) => (
              <div key={t.name} style={{ marginBottom: 8 }}>
                <Typography.Text strong>{t.name}</Typography.Text>: <Typography.Text type="secondary">{t.description}</Typography.Text>
              </div>
            )),
          },
        ]}
      />
    </div>
  );
}
