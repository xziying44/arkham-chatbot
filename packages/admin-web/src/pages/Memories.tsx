import { useEffect, useState } from "react";
import { Select, Table, Tag, Button, Typography, Space, Empty, App as AntdApp, Card, Modal, Input, Tooltip, Popconfirm } from "antd";
import { api } from "../api/client";
import type { Bot } from "../api/types";

interface ScopeRow {
  kind: "group" | "user";
  id: string;
  label: string | null;
  memoryCount: number;
}

interface MemData {
  index: string | null;
  files: { name: string; size: number }[];
}

/**
 * 会话管理 + 记忆审计页。
 *
 * 左侧：某机器人的所有会话列表（磁盘扫描），可编辑备注（32 位哈希起可读名）。
 * 右侧/展开：某会话的记忆文件（查看/编辑/删除）+ 清除操作。
 */
export default function Memories() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState<string | undefined>();
  const [scopes, setScopes] = useState<ScopeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ScopeRow | null>(null);
  const [memData, setMemData] = useState<MemData | null>(null);
  const [viewing, setViewing] = useState<{ name: string; content: string; editing: boolean } | null>(null);
  const [editContent, setEditContent] = useState("");
  const { message, modal } = AntdApp.useApp();

  useEffect(() => {
    api.listBots().then((r) => {
      setBots(r.items);
      if (!botId && r.items.length > 0) setBotId(r.items[0].id);
    });
  }, []);

  const loadScopes = async () => {
    if (!botId) return;
    setLoading(true);
    try {
      const r = await api.listScopes(botId);
      setScopes(r.items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadScopes();
  }, [botId]);

  const loadMemories = async (s: ScopeRow) => {
    if (!botId) return;
    try {
      setMemData(await api.listMemories(botId, s.kind, s.id));
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const selectScope = (s: ScopeRow) => {
    setSelected(s);
    loadMemories(s);
  };

  const saveLabel = async (s: ScopeRow, label: string) => {
    if (!botId) return;
    try {
      if (label.trim()) {
        await api.setScopeLabel(botId, s.kind, s.id, label.trim());
      } else {
        await api.deleteScopeLabel(botId, s.kind, s.id);
      }
      message.success("已保存");
      loadScopes();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const viewFile = async (name: string) => {
    if (!botId || !selected) return;
    try {
      const content = await api.readMemory(botId, selected.kind, selected.id, name);
      setViewing({ name, content, editing: false });
      setEditContent(content);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const saveFile = async () => {
    if (!botId || !selected || !viewing) return;
    try {
      await api.writeMemory(botId, selected.kind, selected.id, viewing.name, editContent);
      message.success("已保存");
      setViewing({ ...viewing, content: editContent, editing: false });
      loadMemories(selected);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const deleteFile = async (name: string) => {
    if (!botId || !selected) return;
    try {
      await api.deleteMemory(botId, selected.kind, selected.id, name);
      message.success("已删除");
      loadMemories(selected);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const clearAllMemories = () => {
    if (!botId || !selected) return;
    modal.confirm({
      title: `清除「${selected.label || selected.id}」的所有记忆文件？`,
      content: "将删除 memories/ 目录下的全部文件（含 MEMORY.md 索引）。不可恢复。",
      okText: "清除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await api.clearMemories(botId, selected.kind, selected.id);
          message.success("已清除所有记忆文件");
          loadMemories(selected);
          loadScopes();
        } catch (e) {
          message.error((e as Error).message);
        }
      },
    });
  };

  const clearHistory = () => {
    if (!botId || !selected) return;
    modal.confirm({
      title: `清除「${selected.label || selected.id}」的最近聊天记录？`,
      content: "下次会话激活时不注入 session.jsonl 历史记录（文件保留不删，只是不加载）。agent 会像「失忆」一样开始新对话。",
      okText: "标记清除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await api.clearHistory(botId, selected.kind, selected.id);
          message.success("已标记清除历史，下次激活生效");
        } catch (e) {
          message.error((e as Error).message);
        }
      },
    });
  };

  return (
    <div>
      <Typography.Title level={4}>会话管理</Typography.Title>

      <Space style={{ marginBottom: 16 }}>
        <Select
          placeholder="选择机器人"
          style={{ width: 200 }}
          value={botId}
          onChange={(v) => { setBotId(v); setSelected(null); setMemData(null); }}
          options={bots.map((b) => ({ label: b.name, value: b.id }))}
        />
      </Space>

      <div style={{ display: "flex", gap: 16 }}>
        {/* 左：会话列表 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Table
            size="small"
            loading={loading}
            dataSource={scopes}
            rowKey={(r) => `${r.kind}:${r.id}`}
            pagination={false}
            onRow={(r) => ({ onClick: () => selectScope(r), style: { cursor: "pointer", background: selected?.id === r.id ? "#e6f4ff" : undefined } })}
            locale={{ emptyText: <Empty description="无会话" /> }}
            columns={[
              { title: "类型", dataIndex: "kind", width: 60, render: (k: string) => <Tag color={k === "group" ? "blue" : "green"}>{k === "group" ? "群" : "私聊"}</Tag> },
              {
                title: "备注",
                dataIndex: "label",
                width: 150,
                render: (label: string | null, r: ScopeRow) => (
                  <Input
                    size="small"
                    placeholder="点此添加备注"
                    defaultValue={label ?? ""}
                    onClick={(e) => e.stopPropagation()}
                    onPressEnter={(e) => saveLabel(r, (e.target as HTMLInputElement).value)}
                    onBlur={(e) => { if (e.target.value !== (label ?? "")) saveLabel(r, e.target.value); }}
                  />
                ),
              },
              { title: "Scope ID", dataIndex: "id", ellipsis: true, render: (id: string, r: ScopeRow) => <Tooltip title={id}><span>{r.label ?? id.slice(0, 16) + "…"}</span></Tooltip> },
              { title: "记忆", dataIndex: "memoryCount", width: 60 },
            ]}
          />
        </div>

        {/* 右：选中会话的记忆详情 */}
        {selected && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <Card
              size="small"
              title={
                <Space>
                  <Tag color={selected.kind === "group" ? "blue" : "green"}>{selected.kind === "group" ? "群" : "私聊"}</Tag>
                  <span>{selected.label ?? selected.id.slice(0, 16) + "…"}</span>
                </Space>
              }
              extra={
                <Space>
                  <Button size="small" danger onClick={clearAllMemories}>清除记忆</Button>
                  <Button size="small" danger onClick={clearHistory}>清除聊天记录</Button>
                </Space>
              }
            >
              {memData?.index && (
                <div style={{ marginBottom: 12 }}>
                  <Typography.Text type="secondary" strong>MEMORY.md 索引（agent 自管理记忆）</Typography.Text>
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, background: "#fafafa", padding: 8, borderRadius: 4, margin: "4px 0" }}>{memData.index}</pre>
                </div>
              )}
              <Table
                size="small"
                dataSource={memData?.files ?? []}
                rowKey="name"
                pagination={false}
                locale={{ emptyText: <Empty description="无记忆文件" /> }}
                columns={[
                  { title: "文件", dataIndex: "name", render: (n: string) => <Tag color="blue">{n}</Tag> },
                  { title: "大小", dataIndex: "size", width: 70, render: (s: number) => `${s}B` },
                  {
                    title: "操作",
                    width: 140,
                    render: (_: unknown, r: { name: string }) => (
                      <Space size="small">
                        <Button size="small" onClick={() => viewFile(r.name)}>查看</Button>
                        <Popconfirm title="删除？" onConfirm={() => deleteFile(r.name)} okText="删除" cancelText="取消">
                          <Button size="small" danger>删除</Button>
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]}
              />
            </Card>
          </div>
        )}
      </div>

      {/* 记忆文件查看/编辑弹窗 */}
      <Modal
        title={viewing?.name}
        open={!!viewing}
        onCancel={() => setViewing(null)}
        width={640}
        footer={
          viewing?.editing ? (
            <Space>
              <Button onClick={() => { setViewing({ ...viewing, editing: false }); setEditContent(viewing.content); }}>取消</Button>
              <Button type="primary" onClick={saveFile}>保存</Button>
            </Space>
          ) : (
            <Space>
              <Button onClick={() => setViewing(null)}>关闭</Button>
              <Button type="primary" onClick={() => viewing && setViewing({ ...viewing, editing: true })}>编辑</Button>
            </Space>
          )
        }
      >
        {viewing?.editing ? (
          <Input.TextArea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={20} style={{ fontFamily: "monospace", fontSize: 12 }} />
        ) : (
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: "55vh", overflow: "auto" }}>{viewing?.content}</pre>
        )}
      </Modal>
    </div>
  );
}
