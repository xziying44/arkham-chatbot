import { useEffect, useState } from "react";
import { Typography, Card, Tag, Spin, Alert } from "antd";
import { api } from "../api/client";
import type { PromptPreview } from "../api/types";

/**
 * 全局提示词查看页：展示系统提示词模板骨架 + 所有工具的描述。
 * 运行时某会话的真实提示词（含 persona/memory 渲染结果）在「会话详情」里看。
 */
export default function Prompts() {
  const [data, setData] = useState<PromptPreview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getPrompts()
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spin />;
  if (!data) return <Alert type="error" message="加载失败" />;

  return (
    <div>
      <Typography.Title level={4}>提示词</Typography.Title>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="这是系统提示词的通用模板与工具描述"
        description="每个会话的实际提示词会在此基础上填入群名/用户名、该机器人的 persona、长期记忆，以及当前工具列表。要查看某个会话的真实渲染结果，去「会话」→ 点开某会话详情。"
      />

      <Card title="工具描述" size="small" style={{ marginBottom: 16 }}>
        {data.tools.map((t) => (
          <div key={t.name} style={{ marginBottom: 12 }}>
            <Tag color="blue">{t.name}</Tag>
            <Typography.Text type="secondary">{t.description}</Typography.Text>
          </div>
        ))}
      </Card>

      <Card title="系统提示词模板" size="small">
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.6, margin: 0 }}>{data.template}</pre>
      </Card>
    </div>
  );
}
