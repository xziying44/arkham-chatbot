# 群聊机器人

基于 [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) 的隔离式群聊智能体。一个群一个智能体，1 小时无活动自动回收内存会话（提取记忆 + 落盘历史），下次消息到达时重载记忆续接。

## 技术选型

| 层 | 选型 |
|---|---|
| Agent 运行时 | `@earendil-works/pi-agent-core`（npm，通用 agentic 循环） |
| LLM 抽象 | `@earendil-works/pi-ai`（38 家 provider 统一接口） |
| 沙箱 | Bubblewrap（Linux 生产）+ NodeExecutionEnv（macOS 开发回退） |
| IM | QQ 官方机器人 API v2（WebSocket + AccessToken） |
| 运行平台 | Node 22.19+ / TypeScript / ESM / pnpm workspace |

核心判断：**agent 进程在宿主跑，仅 bash 命令执行被 bwrap 包裹隔离**。pi 的工具工厂通过 `ExecutionEnv` 接口执行命令——换掉 env，bash 工具零改动自动走沙箱。

## 仓库结构

```
packages/
├── core/      核心运行时：ChatBotSession + SessionManager（TTL 回收/串行/记忆）+ 工具装配
├── sandbox/   BwrapExecutionEnv + env-factory（平台判断 + 开发回退）
├── im-core/   IM 平台中立抽象：ImAdapter 接口 + ImEvent
├── im-qq/     QQ API v2 适配器：access_token + WebSocket + 发消息
└── server/    组装层：app.ts + config + message-router + 启动入口
```

依赖方向（无环）：`sandbox ← core → im-qq`、`core ← im-core ← im-qq ← server`。

## 会话生命周期

- **激活**：收到某 scope（群）首条消息 → 读 `memory.md` 拼入系统 prompt → 建 pi Agent（装 bash/read/edit/write + 该群 ExecutionEnv）→ 加载 `session.jsonl` 历史 → 进入 active
- **对话**：同群消息串行 prompt（pi Agent 不可重入，复用 steering 排队）
- **回收**（1h 无活动）：调 pi `generateSummary` 把会话压缩成 `memory.md` → 落盘 `session.jsonl` → 销毁 Agent（释放内存）→ 磁盘数据保留
- **续接**：下次消息到达，回到「激活」重载记忆与历史

## 快速开始

```bash
# 1. 装依赖（需 Node 22.19+，pnpm 通过 corepack 启用）
corepack enable && corepack prepare pnpm@9.14.0 --activate
pnpm install

# 2. 构建
pnpm build

# 3. 冒烟测试（无需 QQ/LLM 凭据，用 faux provider + NodeExecutionEnv）
pnpm --filter @arkham/chatbot-server smoke

# 4. 配置
cp .env.example .env
#   填入 QQ_APP_ID / QQ_APP_SECRET / CHATBOT_MODEL（如 anthropic/claude-sonnet-4-5）+ 对应 API key

# 5. 启动（连真实 QQ）
pnpm start
```

### 沙箱说明

- macOS 开发：`CHATBOT_SANDBOX_ENABLED` 无效（bwrap 仅 Linux），自动回退 NodeExecutionEnv 直接执行。
- Linux 生产：设 `CHATBOT_SANDBOX_ENABLED=true`，每条 bash 走 `bwrap`（只读系统根、读写群工作目录、默认断网 `--unshare-net`、`--die-with-parent`）。
- 详见 `packages/sandbox/src/bwrap-args.ts`。

## 配置项

见 `.env.example`。关键项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `QQ_APP_ID` / `QQ_APP_SECRET` | — | QQ 开放平台凭据 |
| `QQ_API_BASE` | `https://api.sgroup.qq.com` | 沙箱用 `https://sandbox.api.sgroup.qq.com` |
| `CHATBOT_MODEL` | — | `<provider>/<model-id>`，如 `anthropic/claude-sonnet-4-5` |
| `CHATBOT_SESSION_TTL_MS` | `3600000` | 会话回收阈值（1 小时） |
| `CHATBOT_SANDBOX_ENABLED` | `true` | 是否启用 bwrap（仅 Linux 生效） |
| `CHATBOT_SANDBOX_NETWORK_DISABLED` | `true` | 沙箱断网 |
| `CHATBOT_DATA_DIR` | `./data` | 每群 `data/groups/<id>/`（workspace + session.jsonl + memory.md） |

## 后续迭代（不在当前基础设施范围）

- 定制工具：`send_image` / `search_history` / `list_members` 等（在 `core/src/tools/custom/`）
- 资源限制：配合 systemd-run 加 CPU/内存上限
- 富媒体/markdown 回复、频道消息、Webhook 接入
- SQLite 会话后端（替换 JSONL）
