import { useEffect, useState } from "react";
import { Card, Form, Input, InputNumber, Switch, Button, Space, Typography, App as AntdApp, Alert, Select, Tag } from "antd";
import { api } from "../api/client";
import type { Settings as SettingsType } from "../api/types";

/**
 * LLM 端点预设：常见的 provider 配置一键切换。
 * 选择预设后自动填充 model / base_url；也可手动自定义。
 */
const LLM_PRESETS: {
  label: string;
  provider: "anthropic" | "openai";
  model: string;
  baseUrl?: string;
  baseUrlKey: "llm_anthropic_base_url" | "llm_openai_base_url";
  envKey: string;
  desc: string;
}[] = [
  {
    label: "OpenAI 官方",
    provider: "openai",
    model: "openai/gpt-4o",
    baseUrlKey: "llm_openai_base_url",
    envKey: "OPENAI_API_KEY",
    desc: "api.openai.com，需 OPENAI_API_KEY",
  },
  {
    label: "DeepSeek 官方 (Anthropic 兼容)",
    provider: "anthropic",
    model: "anthropic/deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com/anthropic",
    baseUrlKey: "llm_anthropic_base_url",
    envKey: "ANTHROPIC_AUTH_TOKEN",
    desc: "api.deepseek.com/anthropic，需 ANTHROPIC_AUTH_TOKEN",
  },
  {
    label: "DeepSeek 官方 (OpenAI 兼容)",
    provider: "openai",
    model: "openai/deepseek-chat",
    baseUrl: "https://api.deepseek.com",
    baseUrlKey: "llm_openai_base_url",
    envKey: "OPENAI_API_KEY",
    desc: "api.deepseek.com/v1，需 OPENAI_API_KEY 填 DeepSeek key",
  },
  {
    label: "智谱 BigModel (Anthropic 兼容)",
    provider: "anthropic",
    model: "anthropic/glm-4.6",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    baseUrlKey: "llm_anthropic_base_url",
    envKey: "ANTHROPIC_AUTH_TOKEN",
    desc: "open.bigmodel.cn，需 ANTHROPIC_AUTH_TOKEN 填智谱 key",
  },
  {
    label: "自定义",
    provider: "openai",
    model: "",
    baseUrlKey: "llm_openai_base_url",
    envKey: "OPENAI_API_KEY",
    desc: "手动填写 model 和 base URL",
  },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsType>({});
  const [loading, setLoading] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<string>("custom");
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

  /** 根据当前 settings 推断匹配的预设。 */
  const detectPreset = (s: SettingsType): string => {
    const model = s.llm_model ?? "";
    const openaiUrl = s.llm_openai_base_url ?? "";
    const anthropicUrl = s.llm_anthropic_base_url ?? "";
    for (const p of LLM_PRESETS) {
      if (p.label === "自定义") continue;
      if (model === p.model && (p.baseUrl === undefined || openaiUrl === p.baseUrl || anthropicUrl === p.baseUrl)) {
        return p.label;
      }
    }
    return "自定义";
  };

  const applyPreset = (label: string) => {
    setSelectedPreset(label);
    const preset = LLM_PRESETS.find((p) => p.label === label);
    if (!preset) return;
    const updated = { ...settings };
    updated.llm_model = preset.model;
    // 清掉两个 base url，只设当前预设的
    delete updated.llm_anthropic_base_url;
    delete updated.llm_openai_base_url;
    if (preset.baseUrl) {
      updated[preset.baseUrlKey] = preset.baseUrl;
    }
    setSettings(updated);
  };

  const save = async (values: Record<string, string | boolean | number>) => {
    const payload: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      // 空字符串的 base URL 不提交（表示用官方默认）
      if (v === "" && (k === "llm_anthropic_base_url" || k === "llm_openai_base_url")) continue;
      payload[k] = String(v);
    }
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

  const currentPreset = selectedPreset || detectPreset(settings);
  const isAnthropic = (settings.llm_model ?? "").startsWith("anthropic/");
  const isOpenai = (settings.llm_model ?? "").startsWith("openai/");

  return (
    <div>
      <Typography.Title level={4}>设置</Typography.Title>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="LLM 端点、沙箱等运行参数改动后，对新激活的会话立即生效；已在运行的活跃会话需点下方「回收所有会话」才会应用。"
      />

      <Card title="LLM 端点" loading={loading} style={{ marginBottom: 16 }}>
        <Form
          layout="vertical"
          onFinish={save}
          initialValues={{
            llm_model: settings.llm_model,
            llm_anthropic_base_url: settings.llm_anthropic_base_url,
            llm_openai_base_url: settings.llm_openai_base_url,
          }}
          key={JSON.stringify(settings)}
        >
          <Form.Item label="端点预设" tooltip="选择常用 provider 一键填充；也可选「自定义」手动配置">
            <Select
              value={currentPreset}
              onChange={applyPreset}
              style={{ width: "100%" }}
              options={LLM_PRESETS.map((p) => ({
                value: p.label,
                label: (
                  <Space>
                    <span>{p.label}</span>
                    {p.model && <Tag>{p.model}</Tag>}
                  </Space>
                ),
              }))}
            />
          </Form.Item>

          {currentPreset !== "自定义" && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={LLM_PRESETS.find((p) => p.label === currentPreset)?.desc}
            />
          )}

          <Form.Item label="模型（<provider>/<model-id>）" name="llm_model" rules={[{ required: true }]}>
            <Input placeholder="openai/deepseek-v4-flash 或 anthropic/glm-4.6" />
          </Form.Item>

          {isOpenai && (
            <Form.Item
              label="OpenAI 兼容端点 BaseURL"
              name="llm_openai_base_url"
              tooltip="留空则用官方 api.openai.com。第三方兼容端点填到 /v1 即可（不含 /chat/completions）。需在服务器 .env 设 OPENAI_API_KEY。"
            >
              <Input placeholder="https://api.openai.com/v1 或 https://your-proxy.com/v1" />
            </Form.Item>
          )}

          {isAnthropic && (
            <Form.Item
              label="Anthropic 兼容端点 BaseURL"
              name="llm_anthropic_base_url"
              tooltip="留空则用官方 api.anthropic.com。DeepSeek/智谱等填其兼容端点。需在服务器 .env 设 ANTHROPIC_AUTH_TOKEN。"
            >
              <Input placeholder="https://api.anthropic.com 或 https://api.deepseek.com/anthropic" />
            </Form.Item>
          )}

          <Space>
            <Button type="primary" htmlType="submit">保存</Button>
          </Space>
        </Form>
      </Card>

      <Card title="运行参数" loading={loading} style={{ marginBottom: 16 }}>
        <Form
          layout="vertical"
          onFinish={save}
          initialValues={{
            session_ttl_ms: Number(settings.session_ttl_ms),
            sandbox_enabled: settings.sandbox_enabled === "true",
            sandbox_network_disabled: settings.sandbox_network_disabled === "true",
            sandbox_timeout_seconds: Number(settings.sandbox_timeout_seconds),
          }}
          key={JSON.stringify(settings) + "-runtime"}
        >
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

          <Space>
            <Button type="primary" htmlType="submit">保存</Button>
            <Button onClick={reapAll}>回收所有会话</Button>
          </Space>
        </Form>
      </Card>

      <Card title="管理员" loading={loading}>
        <Form layout="vertical">
          <Form.Item label="修改管理员密码" tooltip="留空不修改">
            <Input.Password value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="输入新密码（留空不修改）" />
          </Form.Item>
          <Button type="primary" onClick={() => save({})} disabled={!newPassword}>
            修改密码
          </Button>
        </Form>
      </Card>
    </div>
  );
}
