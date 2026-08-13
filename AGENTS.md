# AGENTS.md — 给 AI 助手的项目须知

> 这个文件记录容易踩错的项目架构事实。动手前先读。

## 机器人凭证：在后台 DB，不在 .env

**机器人的 appId/appSecret/name/persona 都存在 SQLite 的 `bots` 表里**，通过管理后台
（admin-api / admin-web）增改。**不在 `.env` 里。**

`.env` 里曾经有 `QQ_APP_ID` / `QQ_APP_SECRET`，但那只是**首次种库的引导默认值**
（`config.ts` 的 `loadConfig` 注释明确写了）。DB 一旦有机器人，这两个变量就再也没用。
**它们已被注释掉**——别再恢复，也别拿 `.env` 里的 QQ_APP_ID 去判断「这台机器连的是哪个机器人」。

判断「当前会连哪个机器人」的唯一方法是查 DB：
```bash
sqlite3 data/chatbot.db "SELECT id, app_id, name, enabled FROM bots;"
```

## 本地 / 测试 / 生产 = 不同机器人

- **本地**（这台 mac，`/Users/xziying/project/arkham/群聊机器人`）：DB 里的机器人是**本地测试专用**，
  appId 和生产不同。本地启动**不会**和生产抢连接，可以随便测。
- **生产**：SSH 别名 `arkham`，systemd user 服务 `arkham-chatbot.service`，数据在服务器上。
- 本地的 `data/chatbot.db` 是独立的一份，和生产不共享。

所以：**本地 `pnpm dev` 启动是安全的，不会影响线上**。别再用「.env 的 appId = 生产 appId」
这种错误前提去警告用户。

## 本地启动

```bash
pnpm dev
```

`packages/server/.env` 是指向 `../../.env` 的软链（dev 脚本的 `--env-file=.env` 在 server 目录找）。
如果软链没了，重建：`cd packages/server && ln -sf ../../.env .env`。

启动后：
- IM WebSocket 连本地 DB 里 enabled=1 的机器人。
- 管理后台在 `http://127.0.0.1:5180`。

### ⚠️ 排查：用户报告「消息发了两次」或行为诡异时，先查多进程

**这是最高频的误判源。** 重启 dev 时，`TaskStop` / Ctrl-C 只停了 `pnpm` 父进程，
`node src/bin.ts` 子进程会**孤儿化继续运行**。结果多个 dev 实例同时连同一个 QQ appId，
WS 互相踢 + 每条消息被所有实例都处理 → **消息重复回复、连接不稳、行为前后矛盾**。

症状：用户说「消息发了两次」「回复了两条」「行为不一致」，且代码看着没问题。

**第一步永远是查进程数**：
```bash
ps aux | grep "bin\.ts" | grep -v grep | wc -l   # 应为 1
```
如果不是 1，全部杀掉再重启：
```bash
pkill -9 -f "node.*bin\.ts"   # 杀干净
pnpm dev                       # 重新启动单个
```
确认 `wc -l` 回到 1 再继续排查别的。

**预防**：每次重启 dev 前，先 `pkill -9 -f "node.*bin\.ts"` 杀干净，不要只依赖 TaskStop。


## 关键架构事实（一句话版）

- **发送模型**：agent 的文字输出是**私有思考**，用户看不到；主回复靠 agent 主动调
  `send_message` 工具发送（`send-message.ts:28`）。别假设「文字输出会自动发给用户」。
- **LLM 是非流式**：生产用 `createNonStreamStreamFn`（`app.ts:129`）对 DeepSeek 端点强制非流式，
  每轮文字在一个伪造 `text_delta` 里一次性到达。单轮内没有 token 级流式，多轮 run 有轮间更新。
- **私聊流式（C2C streaming）**：把 agent 每轮非工具文字流到 QQ `stream_messages` 的 markdown
  引用块作为「思考可见」。C2C only，群聊无原生流式。开关 `QQ_C2C_STREAMING`（默认 ON）。
  详见 `docs/qq-c2c-streaming.md`。
- **群聊每成员一会话**：`group:<gid>:<memberId>`，群内并发信号量（默认 3），同成员 steer 合并。
- **卡片/生图群共享**：群成员沙箱的 `workspace/cards` 和 `workspace/generated` rw-bind 到群级共享目录。
- **制卡校验器**：`validate-card.ts` 编码硬规则（字段名/枚举/尖括号 XML/必填），render_card/send_card
  执行前强制校验。原则：只拦铁错误，猜测的不乱改。

## 渲染引擎是独立仓库

卡图渲染在 `/Users/xziying/project/arkham/arkham-workshop`（Rust，arkham-cli）。
注意：那个仓库的本地 master 比 origin 领先约 80 个 commit，**是用户的 WIP，不要 push**。
