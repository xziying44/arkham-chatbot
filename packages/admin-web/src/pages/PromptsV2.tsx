import { useEffect, useState } from "react";
import { Button, Collapse, Descriptions, Space, Spin, Tag, Typography, App as AntdApp } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import type { PromptBundle } from "../api/types";
import { fmtTime } from "../utils";

export default function PromptsV2() {
  const [data, setData] = useState<PromptBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const { message } = AntdApp.useApp();

  const load = async () => {
    setLoading(true);
    try {
      setData(await api.getPromptBundle());
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const reload = async () => {
    try {
      await api.reloadPrompts();
      await load();
      message.success("提示词已热重载");
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  if (loading && !data) return <Spin />;
  return (
    <div>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>提示词</Typography.Title>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={reload}>热重载</Button>
      </Space>
      {data && (
        <>
          <Descriptions size="small" bordered column={4} style={{ marginBottom: 16 }}>
            <Descriptions.Item label="版本">{data.version}</Descriptions.Item>
            <Descriptions.Item label="加载时间">{fmtTime(data.loadedAt)}</Descriptions.Item>
            <Descriptions.Item label="估算 Token">{data.estimatedTokens.toLocaleString()}</Descriptions.Item>
            <Descriptions.Item label="Hash"><Typography.Text code>{data.hash.slice(0, 16)}</Typography.Text></Descriptions.Item>
          </Descriptions>
          <Collapse
            items={data.items.map((item) => ({
              key: item.id,
              label: <Space><Typography.Text strong>{item.id}</Typography.Text><Tag>{item.estimatedTokens} tokens</Tag></Space>,
              children: <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.6, margin: 0 }}>{item.content}</pre>,
            }))}
          />
        </>
      )}
    </div>
  );
}
