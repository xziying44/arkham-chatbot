# WIP: thinkingLevel 拆分重构（群聊/私聊分离）

2026-08-06 暂存。目标：`thinking_level` 拆成 `thinking_level_group` / `thinking_level_user`。

- `thinking-level-split-WIP.patch` — 标准 git patch（store/settings.ts、bootstrap.ts、admin-api/settings.ts），可 `git apply`
- `thinking-level-split-WIP-2-manual-hunks.diff` — 手工记录的重构 hunk（app.ts、bot-manager.ts、config.ts），与 minimax 改动混在一起无法机械 apply，照着手改即可

**未完成的部分（当时 typecheck 失败的根因）**：core 侧没改——
`packages/core/src/session/session-manager.ts` 和 `packages/core/src/agent/bot-session.ts`
仍是单数 `thinkingLevel`。收尾时需要：SessionManagerOptions 加 group/user 两个字段，
按 scope.kind 选择传给 ChatBotSession。另外别忘了管理端 admin-web 的设置页表单。
