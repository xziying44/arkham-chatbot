import { useEffect, useState } from "react";
import { Button, Space, Table, Tag, Modal, Form, Input, Switch, App as AntdApp, Typography, Tooltip } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import type { Bot } from "../api/types";

interface FormValues {
  name: string;
  appId: string;
  appSecret: string;
  apiBase: string;
  persona?: string;
  enabled: boolean;
}

export default function Bots() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Bot | null>(null);
  const [form] = Form.useForm<FormValues>();
  const { message, modal } = AntdApp.useApp();

  const load = async () => {
    setLoading(true);
    try {
      setBots((await api.listBots()).items);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ apiBase: "https://api.sgroup.qq.com", enabled: true });
    setModalOpen(true);
  };

  const openEdit = (bot: Bot) => {
    setEditing(bot);
    form.setFieldsValue({
      name: bot.name,
      appId: bot.appId,
      appSecret: "", // 编辑时不回显密钥；留空=不改
      apiBase: bot.apiBase,
      persona: bot.persona ?? "",
      enabled: bot.enabled,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    try {
      if (editing) {
        const patch: Partial<Bot> = {
          name: values.name,
          appId: values.appId,
          apiBase: values.apiBase,
          persona: values.persona ?? null,
          enabled: values.enabled,
        };
        if (values.appSecret) patch.appSecret = values.appSecret;
        await api.updateBot(editing.id, patch);
        message.success("已更新");
      } else {
        await api.createBot({
          name: values.name,
          appId: values.appId,
          appSecret: values.appSecret,
          apiBase: values.apiBase,
          persona: values.persona ?? null,
          enabled: values.enabled,
        });
        message.success("已创建");
      }
      setModalOpen(false);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const toggleEnabled = async (bot: Bot) => {
    try {
      if (bot.enabled) {
        await api.stopBot(bot.id);
        message.success("已停止");
      } else {
        await api.startBot(bot.id);
        message.success("已启动");
      }
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const remove = (bot: Bot) => {
    modal.confirm({
      title: `删除机器人「${bot.name}」？`,
      content: "默认保留磁盘数据（会话历史/记忆）。如需彻底清理，请用「连同数据删除」。",
      okText: "保留数据删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        await api.deleteBot(bot.id, false);
        message.success("已删除（保留数据）");
        load();
      },
      onCancel: () => {},
    });
  };

  const removeAllData = (bot: Bot) => {
    modal.confirm({
      title: `彻底删除「${bot.name}」及其所有数据？`,
      content: "此操作不可恢复：会删除该机器人的会话历史、记忆、工作区文件。",
      okText: "确认彻底删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        await api.deleteBot(bot.id, true);
        message.success("已彻底删除（含数据）");
        load();
      },
    });
  };

  const stateColor: Record<string, string> = { connected: "green", connecting: "blue", reconnecting: "orange", disconnected: "default", fatal: "red" };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>机器人</Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建机器人</Button>
      </div>

      <Table
        loading={loading}
        dataSource={bots}
        rowKey="id"
        pagination={false}
        columns={[
          { title: "名称", dataIndex: "name" },
          { title: "AppID", dataIndex: "appId", width: 140 },
          { title: "连接状态", dataIndex: "connectionState", width: 120, render: (s: string, r: Bot) => <Tag color={stateColor[s] ?? "default"}>{s}{r.connected ? "" : ""}</Tag> },
          { title: "活跃会话", dataIndex: "activeScopeCount", width: 90 },
          {
            title: "启用",
            dataIndex: "enabled",
            width: 80,
            render: (v: boolean, r: Bot) => <Switch checked={v} onChange={() => toggleEnabled(r)} size="small" />,
          },
          {
            title: "操作",
            width: 220,
            render: (_: unknown, r: Bot) => (
              <Space>
              <Button size="small" onClick={() => openEdit(r)}>编辑</Button>
              <Button size="small" danger onClick={() => remove(r)}>删除</Button>
              <Button size="small" type="link" danger onClick={() => removeAllData(r)}>彻底删除</Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? "编辑机器人" : "新建机器人"}
        open={modalOpen}
        onOk={submit}
        onCancel={() => setModalOpen(false)}
        width={520}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item label="名称" name="name" rules={[{ required: true, message: "请输入名称" }]}>
            <Input />
          </Form.Item>
          <Form.Item label="AppID" name="appId" rules={[{ required: true, message: "请输入 AppID" }]}>
            <Input />
          </Form.Item>
          <Tooltip title={editing ? "留空表示不修改" : ""}>
            <Form.Item
              label="AppSecret"
              name="appSecret"
              rules={editing ? [] : [{ required: true, message: "请输入 AppSecret" }]}
            >
              <Input.Password placeholder={editing ? "留空不修改" : ""} />
            </Form.Item>
          </Tooltip>
          <Form.Item label="API Base" name="apiBase">
            <Input />
          </Form.Item>
          <Form.Item label="人设（persona）" name="persona" tooltip="机器人性格/设定，会拼入系统提示词">
            <Input.TextArea rows={3} placeholder="如：你是一个喜欢用古诗词回答的机器人" />
          </Form.Item>
          <Form.Item label="启用并自动连接" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
