import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api/client";

/**
 * 应用根：验证登录态。未登录跳 /login；已登录渲染子节点（Layout）。
 * 用一个轻量的「检查中」状态避免闪屏。
 */
export default function App({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "ok" | "unauth">("checking");

  useEffect(() => {
    api
      .me()
      .then(() => setState("ok"))
      .catch(() => setState("unauth"));
  }, []);

  if (state === "checking") return null;
  if (state === "unauth") {
    window.location.hash = "#/login";
    return null;
  }
  return <>{children}</>;
}
