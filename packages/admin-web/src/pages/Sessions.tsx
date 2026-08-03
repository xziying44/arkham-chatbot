import { useEffect, useState } from "react";
import { Select, Table, Tag, Button, Typography, Space, Empty, App as AntdApp } from "antd";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { ActiveScope, Bot } from "../api/types";
import { fmtTime, fmtDuration } from "../utils";

export default function Sessions() {
  const nav = useNavigate();
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState<string | undefined>();
  const [scopes, setScopes] = useState<ActiveScope[]>([]);
  const [loading, setLoading] = useState(false);
  const { message } = AntdApp.useApp();

  useEffect(() => {
    api.listBots().then((r) => {
      setBots(r.items);
      if (!botId && r.items.length > 0) setBotId(r.items[0].id);
    });
  }, []);

  const load = async () => {
    if (!botId) return;
    setLoading(true);
    try {
      setScopes((await api.listSessions(botId)).items);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [botId]);

  const openDetail = (scope: ActiveScope) => {
    if (!botId) return;
    nav(`/sessions/${botId}/${scope.scope.kind}/${scope.scope.id}`);
  };

  const forceReap = async (e: React.MouseEvent, scope: ActiveScope) => {
    e.stopPropagation();
    if (!botId) return;
    try {
      const r = await api.forceReap(botId, scope.scope.kind, scope.scope.id);
      message.success(r.ok ? "已回收" : "会话不存在");
      load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>会话</Typography.Title>
        <Select
          placeholder="选择机器人"
          style={{ width: 240 }}
          value={botId}
          onChange={setBotId}
          options={bots.map((b) => ({ label: b.name, value: b.id }))}
        />
      </Space>

      <Table
        size="small"
        loading={loading}
        dataSource={scopes}
        rowKey="key"
        pagination={false}
        onRow={(r) => ({ onClick: () => openDetail(r), style: { cursor: "pointer" } })}
        locale={{ emptyText: <Empty description="无活跃会话（会话 1 小时无活动后自动回收）" /> }}
        columns={[
          { title: "类型", dataIndex: ["scope", "kind"], width: 80, render: (k: string) => <Tag color={k === "group" ? "blue" : "green"}>{k === "group" ? "群" : "私聊"}</Tag> },
          { title: "Scope ID", dataIndex: ["scope", "id"], ellipsis: true },
          { title: "最后活动", dataIndex: "lastActivityAt", width: 180, render: fmtTime },
          { title: "TTL 剩余", dataIndex: "ttlRemainingMs", width: 100, render: fmtDuration },
          { title: "消息数", dataIndex: "messageCount", width: 80 },
          {
            title: "操作",
            width: 100,
            render: (_: unknown, r: ActiveScope) => (
              <Button size="small" danger onClick={(e) => forceReap(e, r)}>回收</Button>
            ),
          },
        ]}
      />
    </div>
  );
}
