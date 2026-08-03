import { useState } from "react";
import { Card, Form, Input, Button, Typography, App as AntdApp } from "antd";
import { api } from "../api/client";

export default function Login() {
  const [loading, setLoading] = useState(false);
  const { message } = AntdApp.useApp();

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      await api.login(values.username, values.password);
      message.success("登录成功");
      window.location.hash = "#/";
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f0f2f5" }}>
      <Card style={{ width: 360 }}>
        <Typography.Title level={3} style={{ textAlign: "center", marginBottom: 24 }}>
          群聊机器人管理端
        </Typography.Title>
        <Form layout="vertical" onFinish={onFinish} initialValues={{ username: "admin" }}>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" loading={loading} block>
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
