import { useEffect, useState } from "react";
import { Layout as AntLayout, Menu, Button, Space, Typography, App as AntdApp } from "antd";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";

const { Header, Sider, Content } = AntLayout;

const menuItems = [
  { key: "/", label: "概览" },
  { key: "/bots", label: "机器人" },
  { key: "/sessions", label: "会话" },
  { key: "/messages", label: "消息" },
  { key: "/logs", label: "日志" },
  { key: "/memories", label: "记忆" },
  { key: "/skills", label: "技能" },
  { key: "/prompts", label: "提示词" },
  { key: "/settings", label: "设置" },
];

export default function Layout() {
  const nav = useNavigate();
  const loc = useLocation();
  const { message } = AntdApp.useApp();
  const [username, setUsername] = useState("");

  useEffect(() => {
    api.me().then((r) => setUsername(r.username)).catch(() => {});
  }, []);

  const selectedKey = menuItems.find((m) => loc.pathname === m.key || (m.key !== "/" && loc.pathname.startsWith(m.key)))?.key ?? "/";

  const logout = async () => {
    await api.logout().catch(() => {});
    message.success("已退出");
    window.location.hash = "#/login";
  };

  return (
    <AntLayout style={{ minHeight: "100vh" }}>
      <Sider breakpoint="lg" collapsedWidth={0}>
        <div style={{ height: 56, margin: 8, color: "#fff", fontSize: 16, textAlign: "center", lineHeight: "56px", fontWeight: 600 }}>
          群聊机器人
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => nav(key)}
        />
      </Sider>
      <AntLayout style={{ background: "#fff" }}>
        <Header style={{ background: "#fff", padding: "0 24px", display: "flex", justifyContent: "flex-end", alignItems: "center", borderBottom: "1px solid #f0f0f0", height: 48, lineHeight: "48px" }}>
          <Space>
            <Typography.Text>{username}</Typography.Text>
            <Button size="small" onClick={logout}>退出</Button>
          </Space>
        </Header>
        <Content style={{ padding: 24, background: "#fff", minHeight: 360, overflow: "auto" }}>
          <Outlet />
        </Content>
      </AntLayout>
    </AntLayout>
  );
}
