import { useEffect, useState } from "react";
import { Select, Table, Tag, Button, Typography, Space, Empty, App as AntdApp, Card, Modal, Input } from "antd";
import { api } from "../api/client";
import type { Bot } from "../api/types";

/**
 * 记忆审计页：选定机器人 + 会话 → 查看 agent 自管理的记忆文件 → 查看/删除。
 *
 * 记忆文件在 <scopeDir>/workspace/memories/，由 agent 用 read/write 自行维护。
 * 这里只读 + 删除（审计/清理），不提供新建/编辑。
 */
export default function Memories() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState<string | undefined>();
  const [kind, setKind] = useState<"group" | "user">("group");
  const [scopeId, setScopeId] = useState("");
  const [data, setData] = useState<{ index: string | null; files: { name: string; size: number }[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewing, setViewing] = useState<{ name: string; content: string } | null>(null);
  const { message, modal } = AntdApp.useApp();

  useEffect(() => {
    api.listBots().then((r) => {
      setBots(r.items);
      if (!botId && r.items.length > 0) setBotId(r.items[0].id);
    });
  }, []);

  const load = async () => {
    if (!botId || !scopeId.trim()) return;
    setLoading(true);
    try {
      setData(await api.listMemories(botId, kind, scopeId.trim()));
    } catch (e) {
      message.error((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (botId && scopeId.trim()) load();
  }, [botId, kind]);

  const view = async (name: string) => {
    if (!botId || !scopeId.trim()) return;
    try {
      const content = await api.readMemory(botId, kind, scopeId.trim(), name);
      setViewing({ name, content });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const remove = (name: string) => {
    modal.confirm({
      title: `删除记忆「${name}」？`,
      content: "删除后 agent 下次激活时若该记忆被引用会读到空。MEMORY.md 索引里的行需 agent 自行清理或手动编辑。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await api.deleteMemory(botId!, kind, scopeId.trim(), name);
          message.success("已删除");
          load();
        } catch (e) {
          message.error((e as Error).message);
        }
      },
    });
  };

  return (
    <div>
      <Typography.Title level={4}>记忆审计</Typography.Title>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select
            placeholder="选择机器人"
            style={{ width: 200 }}
            value={botId}
            onChange={(v) => { setBotId(v); setData(null); }}
            options={bots.map((b) => ({ label: b.name, value: b.id }))}
          />
          <Select
            value={kind}
            onChange={(v) => { setKind(v); setData(null); }}
            style={{ width: 100 }}
            options={[{ label: "群", value: "group" }, { label: "私聊", value: "user" }]}
          />
          <Input
            placeholder="Scope ID（群/用户 openid）"
            style={{ width: 280 }}
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            onPressEnter={load}
          />
          <Button type="primary" onClick={load} disabled={!botId || !scopeId.trim()}>查询</Button>
        </Space>
      </Card>

      {data && (
        <>
          {data.index && (
            <Card title="MEMORY.md 索引" size="small" style={{ marginBottom: 16 }}>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, margin: 0 }}>{data.index}</pre>
            </Card>
          )}

          <Table
            size="small"
            loading={loading}
            dataSource={data.files}
            rowKey="name"
            pagination={false}
            locale={{ emptyText: <Empty description="无记忆文件（memories/ 目录为空或不存在）" /> }}
            columns={[
              { title: "文件名", dataIndex: "name", render: (n: string) => <Tag color="blue">{n}</Tag> },
              { title: "大小", dataIndex: "size", width: 100, render: (s: number) => `${s} B` },
              {
                title: "操作",
                width: 160,
                render: (_: unknown, r: { name: string }) => (
                  <Space>
                    <Button size="small" onClick={() => view(r.name)}>查看</Button>
                    <Button size="small" danger onClick={() => remove(r.name)}>删除</Button>
                  </Space>
                ),
              },
            ]}
          />
        </>
      )}

      <Modal
        title={viewing?.name}
        open={!!viewing}
        onCancel={() => setViewing(null)}
        footer={null}
        width={640}
      >
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: "60vh", overflow: "auto" }}>{viewing?.content}</pre>
      </Modal>
    </div>
  );
}
