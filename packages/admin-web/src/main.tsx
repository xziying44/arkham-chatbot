import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider, App as AntdApp } from "antd";
import "./index.css";
import zhCN from "antd/locale/zh_CN";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import App from "./App";
import Login from "./pages/Login";
import Layout from "./layout/Layout";
import Dashboard from "./pages/Dashboard";
import Bots from "./pages/Bots";
import Sessions from "./pages/Sessions";
import SessionDetail from "./pages/SessionDetailV2";
import Messages from "./pages/Messages";
import Logs from "./pages/Logs";
import Settings from "./pages/Settings";
import Prompts from "./pages/PromptsV2";
import Memories from "./pages/MemoriesV2";
import Usage from "./pages/Usage";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: "#1677ff" } }}>
      <AntdApp>
        <HashRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/"
              element={
                <App>
                  <Layout />
                </App>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path="bots" element={<Bots />} />
              <Route path="sessions" element={<Sessions />} />
              <Route path="sessions/:botId/:kind/:scopeId" element={<SessionDetail />} />
              <Route path="messages" element={<Messages />} />
              <Route path="logs" element={<Logs />} />
              <Route path="memories" element={<Memories />} />
              <Route path="usage" element={<Usage />} />
              <Route path="prompts" element={<Prompts />} />
              <Route path="settings" element={<Settings />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </HashRouter>
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
