import { useEffect, useState } from "react";
import { Select, Table, Tag, Typography, Space, Empty } from "antd";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { ActiveScope, Bot } from "../api/types";
import { fmtTime } from "../utils";

export default function Sessions() {
  const nav = useNavigate();
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState<string | undefined>();
  const [scopes, setScopes] = useState<ActiveScope[]>([]);
  const [loading, setLoading] = useState(false);

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
        locale={{ emptyText: <Empty description="暂无 v2 会话" /> }}
        columns={[
          { title: "类型", dataIndex: ["scope", "kind"], width: 80, render: (k: string) => <Tag color={k === "group" ? "blue" : "green"}>{k === "group" ? "群" : "私聊"}</Tag> },
          { title: "Scope ID", dataIndex: ["scope", "id"], ellipsis: true },
          { title: "运行", dataIndex: "active", width: 80, render: (v: boolean) => <Tag color={v ? "green" : "default"}>{v ? "活跃" : "持久化"}</Tag> },
          { title: "最后活动", dataIndex: "lastActivityAt", width: 180, render: fmtTime },
          { title: "消息数", dataIndex: "messageCount", width: 80 },
          { title: "任务", dataIndex: "activeTaskCount", width: 70 },
          { title: "记忆", dataIndex: "memoryCount", width: 70 },
        ]}
      />
    </div>
  );
}
