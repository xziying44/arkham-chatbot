import { useState } from "react";
import { Modal, Tag, Typography } from "antd";
import type { AgentMessage } from "../api/types";

/**
 * 聊天式消息列表：把 pi 的 AgentMessage 渲染成左右气泡（用户右侧蓝、机器人左侧白），
 * 工具调用/结果折叠成系统提示。点击任意气泡查看原始 JSON。
 */

interface TextPart {
  type: "text";
  text: string;
}

/** 从消息 content 里提取纯文本。 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is TextPart => typeof c === "object" && c !== null && (c as { type: string }).type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

/** 从消息 content 里提取 send_message 工具调用的文本参数。 */
function extractSentMessage(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const c of content) {
    if (typeof c === "object" && c !== null && (c as { type: string }).type === "toolCall") {
      const tc = c as { type: string; name?: string; arguments?: Record<string, unknown> };
      if (tc.name === "send_message" && tc.arguments?.text) {
        return String(tc.arguments.text);
      }
    }
  }
  return null;
}

/** 从消息 content 里提取 ask_user 工具调用的参数（question + options）。 */
function extractAskUser(content: unknown): { question: string; options: string[] } | null {
  if (!Array.isArray(content)) return null;
  for (const c of content) {
    if (typeof c === "object" && c !== null && (c as { type: string }).type === "toolCall") {
      const tc = c as { type: string; name?: string; arguments?: Record<string, unknown> };
      if (tc.name === "ask_user" && tc.arguments?.question) {
        const opts = Array.isArray(tc.arguments.options)
          ? (tc.arguments.options as { label?: string }[]).map((o) => String(o.label ?? ""))
          : [];
        return { question: String(tc.arguments.question), options: opts };
      }
    }
  }
  return null;
}

/** 判断消息在聊天视图里的归类。 */
function classify(msg: AgentMessage): "user" | "assistant" | "system" | "tool" {
  if (msg.role === "user") return "user";
  if (msg.role === "assistant") return "assistant";
  if (msg.role === "toolResult") return "tool";
  // pi-agent-core 扩展：bashExecution / custom / branchSummary / compactionSummary
  return "system";
}

function MessageBubble({ msg, index }: { msg: AgentMessage; index: number }) {
  const [modalOpen, setModalOpen] = useState(false);
  const kind = classify(msg);
  const text = extractText(msg.content);
  // send_message 工具调用的文本——渲染为普通消息气泡而非工具调用。
  const sentMessage = extractSentMessage(msg.content);
  // ask_user 工具调用——渲染为带选项的提问气泡。
  const askUser = extractAskUser(msg.content);
  const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString("zh-CN", { hour12: false }) : null;

  // ask_user 工具调用渲染为提问气泡（显示问题 + 选项按钮列表）。
  if (kind === "assistant" && askUser !== null) {
    return (
      <>
        <div style={{ display: "flex", justifyContent: "flex-start", margin: "8px 0" }}>
          <div
            onClick={() => setModalOpen(true)}
            style={{
              maxWidth: "70%",
              cursor: "pointer",
              background: "#fff7e6",
              color: "#333",
              padding: "8px 14px",
              borderRadius: 12,
              boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
            }}
          >
            <div style={{ fontSize: 12, marginBottom: 2, opacity: 0.7 }}>
              ❓ 提问{time ? ` · ${time}` : ""}
            </div>
            <div style={{ marginBottom: 6 }}>{askUser.question}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {askUser.options.map((opt, i) => (
                <span
                  key={i}
                  style={{
                    display: "inline-block",
                    padding: "2px 10px",
                    borderRadius: 8,
                    border: i === 0 ? "1px solid #1677ff" : "1px solid #d9d9d9",
                    color: i === 0 ? "#1677ff" : "#666",
                    fontSize: 13,
                  }}
                >
                  {opt}
                </span>
              ))}
            </div>
          </div>
        </div>
        <Modal title={`原始消息 #${index}`} open={modalOpen} onCancel={() => setModalOpen(false)} footer={null} width={640}>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: "60vh", overflow: "auto" }}>{JSON.stringify(msg, null, 2)}</pre>
        </Modal>
      </>
    );
  }

  // 如果 assistant 消息包含 send_message 工具调用，渲染为普通气泡（实际发给用户的消息）。
  // 其它工具调用（read/write/bash/send_image 等）仍然渲染为系统条。
  if (kind === "assistant" && sentMessage !== null) {
    return (
      <>
        <div style={{ display: "flex", justifyContent: "flex-start", margin: "8px 0" }}>
          <div
            onClick={() => setModalOpen(true)}
            style={{
              maxWidth: "70%",
              cursor: "pointer",
              background: "#f0f0f0",
              color: "#333",
              padding: "8px 14px",
              borderRadius: 12,
              wordBreak: "break-word",
              whiteSpace: "pre-wrap",
              boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
            }}
          >
            <div style={{ fontSize: 12, marginBottom: 2, opacity: 0.7 }}>
              机器人{time ? ` · ${time}` : ""}
            </div>
            <div>{sentMessage}</div>
          </div>
        </div>
        <Modal title={`原始消息 #${index}`} open={modalOpen} onCancel={() => setModalOpen(false)} footer={null} width={640}>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: "60vh", overflow: "auto" }}>{JSON.stringify(msg, null, 2)}</pre>
        </Modal>
      </>
    );
  }

  // 系统类消息（工具调用/结果/bash 执行）渲染成居中的小条。
  if (kind === "system" || kind === "tool") {
    // send_message / ask_user 的工具结果不需要显示（已渲染为气泡）。
    if (kind === "tool" && (msg.toolName === "send_message" || msg.toolName === "ask_user")) return null;
    const label =
      msg.role === "bashExecution"
        ? `🔧 执行命令：${(msg.command ?? "").slice(0, 80)}`
        : msg.role === "toolResult"
          ? `📎 工具结果${msg.toolName ? `（${msg.toolName}）` : ""}`
          : msg.role === "branchSummary" || msg.role === "compactionSummary"
            ? "📝 摘要"
            : `⚙️ ${msg.role}`;
    return (
      <>
        <div style={{ textAlign: "center", margin: "8px 0" }}>
          <Tag
            style={{ cursor: "pointer", background: "#f5f5f5", border: "none", color: "#999", maxWidth: "80%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }}
            onClick={() => setModalOpen(true)}
          >
            {label}
          </Tag>
        </div>
        <Modal title={`原始消息 #${index}`} open={modalOpen} onCancel={() => setModalOpen(false)} footer={null} width={640}>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: "60vh", overflow: "auto" }}>{JSON.stringify(msg, null, 2)}</pre>
        </Modal>
      </>
    );
  }

  const isUser = kind === "user";
  return (
    <>
      <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", margin: "8px 0" }}>
        <div
          onClick={() => setModalOpen(true)}
          style={{
            maxWidth: "70%",
            cursor: "pointer",
            background: isUser ? "#1677ff" : "#f0f0f0",
            color: isUser ? "#fff" : "#333",
            padding: "8px 14px",
            borderRadius: 12,
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
            boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
          }}
        >
          <div style={{ fontSize: 12, marginBottom: 2, opacity: 0.7 }}>
            {isUser ? "用户" : "机器人"}{time ? ` · ${time}` : ""}
          </div>
          <div>{text || <span style={{ opacity: 0.5 }}>（无文本内容，点击查看原始数据）</span>}</div>
        </div>
      </div>
      <Modal title={`原始消息 #${index}`} open={modalOpen} onCancel={() => setModalOpen(false)} footer={null} width={640}>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: "60vh", overflow: "auto" }}>{JSON.stringify(msg, null, 2)}</pre>
      </Modal>
    </>
  );
}

export default function MessageList({ messages }: { messages: AgentMessage[] }) {
  if (messages.length === 0) {
    return <Typography.Text type="secondary">暂无消息</Typography.Text>;
  }
  return (
    <div style={{ background: "#fafafa", padding: 16, borderRadius: 8, maxHeight: "70vh", overflow: "auto" }}>
      {messages.map((m, i) => (
        <MessageBubble key={i} msg={m} index={i} />
      ))}
    </div>
  );
}
