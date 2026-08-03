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
├── core/       核心运行时：ChatBotSession + SessionManager（TTL 回收/串行/记忆）+ 工具装配 + 结构化 logging
├── sandbox/    BwrapExecutionEnv + env-factory（平台判断 + 开发回退）
├── im-core/    IM 平台中立抽象：ImAdapter 接口 + ImEvent
├── im-qq/      QQ API v2 适配器：access_token + WebSocket + 发消息
├── store/      SQLite（node:sqlite，零原生依赖）+ repository（bots/settings/messages/logs/admin_sessions）
├── admin-api/  管理端 HTTP 后端：Hono + 鉴权 + 机器人 CRUD/会话查看/消息流水/日志 SSE/设置
├── admin-web/  管理端 SPA：React + Vite + Ant Design（6 个页面）
└── server/     组装层：app.ts（DB 驱动 + BotManager 多机器人 + AdminServer）+ config + 路由 + 启动入口
```

依赖方向（无环）：`sandbox ← core → im-qq`、`core ← im-core ← im-qq ← server`、`store ← admin-api ← server`。

## 多机器人 + 管理端

一个进程同时跑多个 QQ 机器人 + Web 管理后台：

- **BotManager** 持有 N 个 `{adapter, sessions}` 实例，每机器人独立 SessionManager + 独立 `data/bots/<botId>/` 数据子树，共享全局 LLM。
- **机器人配置/设置** 存 SQLite（`data/chatbot.db`），首次启动用 env 凭证引导种默认机器人；之后全部在管理端动态增改。
- **管理端**（React SPA）默认 `http://127.0.0.1:5180`，账号密码登录（scrypt 哈希 + cookie 会话）。
  - 概览：机器人总数/在线/活跃会话/最近错误 + 实时日志
  - 机器人：列表 + 新建/编辑 Modal（appId/appSecret/apiBase/persona/启用）+ 启停 + 删除
  - 会话：按机器人查看活跃会话（TTL 倒计时/消息数），抽屉看系统提示词 + 工具 + 最近消息，可强制回收
  - 消息：入站/出站流水，按机器人/会话/方向/内容筛选 + 分页
  - 日志：按级别/来源/机器人筛选 + 分页；SSE 实时尾随
  - 设置：LLM 端点（model/baseUrl）、TTL、沙箱、改密码；只读提示词模板预览；「回收所有会话」按钮

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

# 2. 构建后端（core/sandbox/im-*/store/admin-api/server）
pnpm build

# 3. 构建管理端前端 SPA
pnpm --filter @arkham/chatbot-admin-web build

# 4. 配置
cp .env.example .env
#   填入 QQ_APP_ID / QQ_APP_SECRET / CHATBOT_MODEL + 对应 API key
#   建议设 ADMIN_PASSWORD（默认 admin）
#   设 ADMIN_WEB_DIST=<仓库>/packages/admin-web/dist 让服务同时提供管理端 UI

# 5. 启动（连真实 QQ + 管理端）
ADMIN_WEB_DIST=$(pwd)/packages/admin-web/dist pnpm start
#   或开发模式：ADMIN_WEB_DIST=$(pwd)/packages/admin-web/dist pnpm dev

# 6. 打开管理端
open http://127.0.0.1:5180
```

首次启动会用 env 凭证在 SQLite（`data/chatbot.db`）种一条默认机器人；之后在管理端「机器人」页新增更多 QQ 机器人，全部在一个进程内运行。

### 管理端开发（前端热更新）

```bash
# 终端 1：跑后端
pnpm dev

# 终端 2：跑前端 dev server（5173，/api 自动代理到 5180）
pnpm --filter @arkham/chatbot-admin-web dev
# 浏览器开 http://127.0.0.1:5173
```

### 沙箱说明

- macOS 开发：`CHATBOT_SANDBOX_ENABLED` 无效（bwrap 仅 Linux），自动回退 NodeExecutionEnv 直接执行。
- Linux 生产：设 `CHATBOT_SANDBOX_ENABLED=true`，每条 bash 走 `bwrap`（只读系统根、读写群工作目录、默认断网 `--unshare-net`、`--die-with-parent`）。
- 详见 `packages/sandbox/src/bwrap-args.ts`。

## 配置项

见 `.env.example`。QQ 凭证/模型/persona 仅作 **首次启动引导默认值**，之后存 SQLite 可在管理端改。

| 变量 | 默认 | 说明 |
|---|---|---|
| `QQ_APP_ID` / `QQ_APP_SECRET` | — | QQ 凭据（仅引导种库） |
| `CHATBOT_MODEL` | `anthropic/deepseek-v4-flash` | `<provider>/<model-id>`（仅引导种库） |
| `ANTHROPIC_BASE_URL` | — | Anthropic 兼容端点（DeepSeek/智谱） |
| `ANTHROPIC_AUTH_TOKEN` | — | LLM API key（pi-ai 直读，不入库） |
| `CHATBOT_DATA_DIR` | `./data` | 数据根；每机器人 `data/bots/<id>/<kind>/<scopeId>/` |
| `CHATBOT_DB_PATH` | `<data>/chatbot.db` | SQLite 路径 |
| `ADMIN_HOST` | `127.0.0.1` | 管理端监听地址（远程访问改 `0.0.0.0`） |
| `ADMIN_PORT` | `5180` | 管理端端口 |
| `ADMIN_WEB_DIST` | — | admin-web 构建产物目录（不设则只服务 API） |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin` | 引导管理员（首次后改） |

会话/沙箱参数（`CHATBOT_SESSION_TTL_MS` / `CHATBOT_SANDBOX_*`）也仅作引导默认值，之后在管理端「设置」改。
