import { useEffect, useState } from "react";
import { Card, Form, Input, InputNumber, Switch, Button, Space, Typography, App as AntdApp, Alert } from "antd";
import { api } from "../api/client";
import type { Settings as SettingsType } from "../api/types";

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsType>({});
  const [loading, setLoading] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const { message, modal } = AntdApp.useApp();

  const load = async () => {
    setLoading(true);
    try {
      setSettings(await api.getSettings());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const save = async (values: Record<string, string | boolean | number>) => {
    const payload: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) payload[k] = String(v);
    if (newPassword) payload.admin_password = newPassword;
    try {
      const r = await api.updateSettings(payload);
      message.success(`已保存（${r.changed} 项）。${r.note ?? ""}`);
      setNewPassword("");
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const reapAll = () => {
    modal.confirm({
      title: "回收所有活跃会话？",
      content: "改 LLM 端点/沙箱设置后，活跃会话仍持有旧配置。回收后下次激活才会应用新设置。回收会提取记忆并落盘，不影响数据。",
      okText: "回收",
      cancelText: "取消",
      onOk: async () => {
        const r = await api.reapAll();
        message.success(`已回收 ${r.reaped} 个会话`);
      },
    });
  };

  return (
    <div>
      <Typography.Title level={4}>设置</Typography.Title>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="LLM 端点、沙箱等运行参数改动后，对新激活的会话立即生效；已在运行的活跃会话需点下方「回收所有会话」才会应用。"
      />

      <Card title="运行参数" loading={loading} style={{ marginBottom: 16 }}>
        <Form
          layout="vertical"
          onFinish={save}
          initialValues={{
            llm_model: settings.llm_model,
            llm_anthropic_base_url: settings.llm_anthropic_base_url,
            session_ttl_ms: Number(settings.session_ttl_ms),
            sandbox_enabled: settings.sandbox_enabled === "true",
            sandbox_network_disabled: settings.sandbox_network_disabled === "true",
            sandbox_timeout_seconds: Number(settings.sandbox_timeout_seconds),
          }}
          key={JSON.stringify(settings)}
        >
          <Form.Item label="模型（<provider>/<model-id>）" name="llm_model" rules={[{ required: true }]}>
            <Input placeholder="anthropic/deepseek-v4-flash" />
          </Form.Item>
          <Form.Item label="Anthropic 兼容端点 BaseURL" name="llm_anthropic_base_url" tooltip="留空则用官方 api.anthropic.com。DeepSeek/智谱等填其兼容端点。">
            <Input placeholder="https://api.deepseek.com/anthropic" />
          </Form.Item>
          <Form.Item label="会话回收阈值（毫秒）" name="session_ttl_ms" rules={[{ required: true }]}>
            <InputNumber min={60000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="沙箱启用" name="sandbox_enabled" valuePropName="checked" tooltip="Linux 生产用 Bubblewrap 隔离 bash；macOS 开发回退直接执行">
            <Switch />
          </Form.Item>
          <Form.Item label="沙箱断网" name="sandbox_network_disabled" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label="沙箱命令超时（秒）" name="sandbox_timeout_seconds" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>

          <Form.Item label="修改管理员密码（可选）" tooltip="留空不修改">
            <Input.Password value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="输入新密码（留空不修改）" />
          </Form.Item>

          <Space>
            <Button type="primary" htmlType="submit">保存</Button>
            <Button onClick={reapAll}>回收所有会话</Button>
          </Space>
        </Form>
      </Card>
    </div>
  );
}
