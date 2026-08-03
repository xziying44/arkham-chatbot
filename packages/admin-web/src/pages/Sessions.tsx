import { useEffect, useState } from "react";
import { Select, Table, Tag, Drawer, Button, Descriptions, Typography, Space, Empty, App as AntdApp, Collapse } from "antd";
import { api } from "../api/client";
import type { ActiveScope, Bot, ScopeDetail } from "../api/types";
import { fmtTime, fmtDuration } from "../utils";

export default function Sessions() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState<string | undefined>();
  const [scopes, setScopes] = useState<ActiveScope[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<ScopeDetail | null>(null);
  const [detailScope, setDetailScope] = useState<ActiveScope | null>(null);
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

  const openDetail = async (scope: ActiveScope) => {
    if (!botId) return;
    setDetailScope(scope);
    try {
      setDetail(await api.getScopeDetail(botId, scope.scope.kind, scope.scope.id));
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const forceReap = async (scope: ActiveScope) => {
    if (!botId) return;
    try {
      const r = await api.forceReap(botId, scope.scope.kind, scope.scope.id);
      message.success(r.ok ? "已回收" : "会话不存在");
      if (detailScope === scope) setDetail(null);
      load();
    } catch (e) {
      message.error((e as Error).message);
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
        locale={{ emptyText: <Empty description="无活跃会话（会话 1 小时无活动后自动回收）" /> }}
        columns={[
          { title: "类型", dataIndex: ["scope", "kind"], width: 80, render: (k: string) => <Tag color={k === "group" ? "blue" : "green"}>{k === "group" ? "群" : "私聊"}</Tag> },
          { title: "Scope ID", dataIndex: ["scope", "id"], ellipsis: true },
          { title: "最后活动", dataIndex: "lastActivityAt", width: 180, render: fmtTime },
          { title: "TTL 剩余", dataIndex: "ttlRemainingMs", width: 100, render: fmtDuration },
          { title: "消息数", dataIndex: "messageCount", width: 80 },
          {
            title: "操作",
            width: 160,
            render: (_: unknown, r: ActiveScope) => (
              <Space>
                <Button size="small" onClick={() => openDetail(r)}>详情</Button>
                <Button size="small" danger onClick={() => forceReap(r)}>回收</Button>
              </Space>
            ),
          },
        ]}
      />

      <Drawer
        title={detailScope ? `会话详情 · ${detailScope.scope.kind}:${detailScope.scope.id}` : "会话详情"}
        open={!!detail}
        onClose={() => { setDetail(null); setDetailScope(null); }}
        width={640}
      >
        {detail && (
          <>
            <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="最后活动">{fmtTime(detail.lastActivityAt)}</Descriptions.Item>
              <Descriptions.Item label="消息总数">{detail.messageCount}</Descriptions.Item>
              <Descriptions.Item label="工具">
                {detail.tools.map((t) => (
                  <Tag key={t.name}>{t.name}</Tag>
                ))}
              </Descriptions.Item>
            </Descriptions>

            <Collapse
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
                {
                  key: "messages",
                  label: `最近消息（${detail.messages.length}）`,
                  children: (
                    <div style={{ maxHeight: 400, overflow: "auto" }}>
                      {detail.messages.map((m, i) => (
                        <pre key={i} style={{ whiteSpace: "pre-wrap", fontSize: 12, background: "#fafafa", padding: 8, margin: "4px 0", borderRadius: 4 }}>
                          {JSON.stringify(m, null, 2)}
                        </pre>
                      ))}
                    </div>
                  ),
                },
              ]}
            />
          </>
        )}
      </Drawer>
    </div>
  );
}
