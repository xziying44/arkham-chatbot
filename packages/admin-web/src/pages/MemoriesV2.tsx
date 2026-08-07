import { useEffect, useState } from "react";
import { Button, Input, Modal, Select, Space, Table, Tabs, Tag, Typography, App as AntdApp } from "antd";
import { EditOutlined, InboxOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import type { AgentTask, Bot, ConversationSegment, MemoryEntry } from "../api/types";
import { fmtTime } from "../utils";

interface ScopeRow {
  kind: "group" | "user";
  id: string;
  label: string | null;
  memoryCount: number;
  activeTaskCount: number;
  eventCount: number;
  lastActivityAt: number;
}

export default function MemoriesV2() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState<string>();
  const [scopes, setScopes] = useState<ScopeRow[]>([]);
  const [selected, setSelected] = useState<ScopeRow>();
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [segments, setSegments] = useState<ConversationSegment[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [editing, setEditing] = useState<MemoryEntry>();
  const [content, setContent] = useState("");
  const [triggers, setTriggers] = useState("");
  const { message } = AntdApp.useApp();

  useEffect(() => {
    api.listBots().then((result) => {
      setBots(result.items);
      setBotId((current) => current ?? result.items[0]?.id);
    });
  }, []);

  useEffect(() => {
    if (!botId) return;
    api.listScopesV2(botId).then((result) => setScopes(result.items));
  }, [botId]);

  const selectScope = async (scope: ScopeRow) => {
    if (!botId) return;
    setSelected(scope);
    const detail = await api.getMemoryV2(botId, scope.kind, scope.id);
    setMemories(detail.memories);
    setSegments(detail.segments);
    setTasks(detail.tasks);
  };

  const openEdit = (memory: MemoryEntry) => {
    setEditing(memory);
    setContent(memory.content);
    setTriggers(memory.triggers.join("，"));
  };

  const save = async () => {
    if (!editing) return;
    const updated = await api.updateMemoryV2(editing.id, {
      content,
      triggers: triggers.split("，").map((item) => item.trim()).filter(Boolean),
    });
    setMemories((items) => items.map((item) => item.id === updated.id ? updated : item));
    setEditing(undefined);
    message.success("记忆已更新");
  };

  const archive = async (memory: MemoryEntry) => {
    await api.updateMemoryV2(memory.id, { status: "archived" });
    setMemories((items) => items.filter((item) => item.id !== memory.id));
    message.success("记忆已归档");
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>记忆与任务</Typography.Title>
        <Select
          style={{ width: 240 }}
          value={botId}
          onChange={(value) => { setBotId(value); setSelected(undefined); }}
          options={bots.map((bot) => ({ label: bot.name, value: bot.id }))}
        />
      </Space>
      <Table
        size="small"
        rowKey={(row) => row.kind + ":" + row.id}
        pagination={false}
        dataSource={scopes}
        onRow={(row) => ({ onClick: () => void selectScope(row), style: { cursor: "pointer" } })}
        columns={[
          { title: "类型", dataIndex: "kind", width: 70, render: (value: string) => <Tag color={value === "group" ? "blue" : "green"}>{value === "group" ? "群" : "私聊"}</Tag> },
          { title: "备注 / Scope", render: (_: unknown, row: ScopeRow) => row.label ?? row.id },
          { title: "事件", dataIndex: "eventCount", width: 80 },
          { title: "任务", dataIndex: "activeTaskCount", width: 80 },
          { title: "记忆", dataIndex: "memoryCount", width: 80 },
          { title: "最后活动", dataIndex: "lastActivityAt", width: 180, render: fmtTime },
        ]}
      />
      {selected && (
        <Tabs style={{ marginTop: 20 }} items={[
          {
            key: "memories",
            label: "记忆 " + memories.length,
            children: <Table size="small" rowKey="id" pagination={false} dataSource={memories} columns={[
              { title: "分类", dataIndex: "category", width: 90 },
              { title: "内容", dataIndex: "content" },
              { title: "触发词", dataIndex: "triggers", width: 220, render: (items: string[]) => items.map((item) => <Tag key={item}>{item}</Tag>) },
              { title: "命中", dataIndex: "useCount", width: 70 },
              { title: "操作", width: 110, render: (_: unknown, row: MemoryEntry) => <Space><Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} /><Button size="small" icon={<InboxOutlined />} onClick={() => void archive(row)} /></Space> },
            ]} />,
          },
          {
            key: "tasks",
            label: "任务 " + tasks.length,
            children: <Table size="small" rowKey="id" pagination={false} dataSource={tasks} columns={[
              { title: "标题", dataIndex: "title" },
              { title: "场景", dataIndex: "scene", width: 120 },
              { title: "状态", dataIndex: "status", width: 100, render: (value: string) => <Tag>{value}</Tag> },
              { title: "更新时间", dataIndex: "updatedAt", width: 180, render: fmtTime },
            ]} />,
          },
          {
            key: "segments",
            label: "沉淀 " + segments.length,
            children: <Table size="small" rowKey="id" pagination={false} dataSource={segments} columns={[
              { title: "摘要", dataIndex: "summary" },
              { title: "关键词", dataIndex: "keywords", width: 240, render: (items: string[]) => items.map((item) => <Tag key={item}>{item}</Tag>) },
              { title: "时间", dataIndex: "createdAt", width: 180, render: fmtTime },
            ]} />,
          },
        ]} />
      )}
      <Modal title="编辑记忆" open={!!editing} onCancel={() => setEditing(undefined)} onOk={() => void save()} okText="保存">
        <Typography.Text type="secondary">内容</Typography.Text>
        <Input.TextArea rows={6} value={content} onChange={(event) => setContent(event.target.value)} style={{ margin: "6px 0 14px" }} />
        <Typography.Text type="secondary">触发词（中文逗号分隔）</Typography.Text>
        <Input value={triggers} onChange={(event) => setTriggers(event.target.value)} style={{ marginTop: 6 }} />
      </Modal>
    </div>
  );
}
