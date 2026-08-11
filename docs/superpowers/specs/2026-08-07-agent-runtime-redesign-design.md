# 智能体运行时重设计（Spec 1：地基）

**状态**：待评审
**日期**：2026-08-07
**关联**：本文是「智能体重设计」系列的第 1 个（地基）。后续 spec 见末尾「后续 spec」索引。

---

## 1. 背景与问题

现在的智能体逻辑（`packages/core/`）和 QQ 群聊机器人业务深度耦合，导致：

1. **找不到代码**：通用智能体指令（安全约束、使用准则、回复格式）与 QQ 专属格式（`<qqbot-at-user>` 标签、QQ markdown 限制、`[openid]:` 消息前缀、平台审核合规话术）混写在同一个 200 行的 `system-prompt.ts` 里。群消息合并语义、被动回复引用（replyToHolder）焊进了 agent 循环（`bot-session.ts`）。`send_message`/`send_image`/`ask_user` 工具直接绑定 QQ 的 sendText/sendImage/keyboard。
2. **提示词固化**：整个系统提示词是个硬编码函数。改一个字 = 改 TS 代码 → `pnpm build` → 重启。
3. **双重维护**：`admin-api/src/routes/settings.ts` 里手抄了一份 `PROMPT_TEMPLATE` 副本（注释自承"与 core 保持同步"），已经会漂移。
4. **缓存几乎不命中**：provider 缓存按最长公共前缀匹配。当前提示词第 2 段就是动态的 `scopeName`，从第 2 段往后每个群/每个机器人/每次记忆更新都 cache miss，占提示词 70%+ 的稳定内容（安全+准则+回复格式+技能引导）吃不到缓存。
5. **交互重**：askUser 工具把群聊当 RPC（阻塞 Promise + pending 状态机 + 超时清理 + 按钮回调），但群聊是多对多异步流——A 发起提问的瞬间 B 可能要说话，没有理由为"等 A 点按钮"冻结整个会话。
6. **工具链慢、回复慢、经常要确认**：load_skill 串行往返、能并行没并行、技能里"先问用户"的门太多。（这些问题留 Spec 2/3，但 Spec 1 的接口要预留扩展点，避免返工。）

**好消息**：`packages/core/src/` 下的 `session/`（TTL 回收/串行/记忆续接）、`history`（按天归档）、`memory`（摘要落盘）、`memory-files`（memories/ 自管理）、`skills/skill-loader.ts`、`identity/scope.ts`、平台无关的 `tools/`（restricted-bash/read/edit/write/load-skill）——这些是已验证、通用的，可作为新模块的底座，不必从零重写。

## 2. 目标

把"平台无关的智能体"从"QQ 群机器人"里剥离出来，独立成 npm 包：

- **独立新仓库**（`arkham-agent-runtime`），平台无关、零 QQ 依赖。
- **从现有 core 抽取通用部分**作为底座（已验证的逻辑直接迁移，不重写）。
- **智能体定义接入接口，宿主实现**：智能体内部完全不知道自己挂在 QQ、CLI 还是 Web。
- **进程内 npm 库**：和现在 core 的形态一致，迁移成本最低。
- **先在 CLI REPL 里测稳，再回填替换 QQ**；这个智能体以后要接其他系统。
- **提示词文件化 + 缓存三层分层**：把"内容"和"逻辑"解耦，且按稳定性从高到低排序拼接，最大化缓存命中率。
- **交互轻量化**：废弃 askUser 的 RPC 模型，改用文本内中性 `<suggest>` 标记，宿主各自翻译成平台渲染。

## 3. 非目标（留待后续 spec）

- **Spec 2**：工具链提速（load_skill 默认批量带 references、并行工具调用）。
- **Spec 3**：交互减负（重写技能引导段、审计各技能的确认门）。
- **Spec 4**：thinking level 拆分（接 `.wip/` 里 group/user 分离的活）+ 模型调优。
- **Spec 5**：QQ 适配器迁移——智能体在 CLI 测稳之后，把 `bot-manager.ts` 的回调改成 Transport 实现，替换旧 core。

Spec 1 只交付地基，不含上述。

## 4. 架构

### 4.1 仓库与包结构

新独立仓库（`arkham-agent-runtime`），pnpm workspace，初版一个包足够：

```
arkham-agent-runtime/
├─ package.json
├─ tsconfig.json
├─ src/
│  ├─ index.ts                 # 公共导出
│  ├─ transport.ts             # Transport / AgentHost 接口（承重墙）
│  ├─ agent/
│  │  ├─ session.ts            # 迁自 core session/session-manager.ts
│  │  ├─ history.ts            # 迁自 core session/history.ts
│  │  ├─ memory.ts             # 迁自 core session/memory.ts
│  │  ├─ memory-files.ts       # 迁自 core session/memory-files.ts
│  │  └─ scope.ts              # 迁自 core identity/scope.ts
│  ├─ prompt/
│  │  ├─ builder.ts            # 三层分层拼接 + 占位符插值
│  │  ├─ loader.ts             # 启动加载 + reload()
│  │  └─ templates/            # 提示词文件源（见 4.4）
│  ├─ skills/
│  │  └─ loader.ts             # 迁自 core skills/skill-loader.ts
│  ├─ tools/
│  │  ├─ bash.ts               # 迁自 core tools/restricted-bash.ts（白名单外置）
│  │  ├─ files.ts              # read/edit/write（迁自 core tools/index.ts）
│  │  ├─ load-skill.ts         # 迁自 core tools/load-skill.ts
│  │  ├─ send-message.ts       # 调 Transport.sendMessage
│  │  └─ send-image.ts         # 调 Transport.sendImage
│  ├─ suggest.ts               # <suggest> 中性标记契约（仅类型 + 文档，不解析）
│  └─ logging.ts               # 迁自 core logging.ts
├─ cli/
│  └─ repl.ts                  # CLI REPL 测试宿主（实现 Transport）
├─ examples/
│  └─ minimal-host.ts          # 最小宿主示例（文档用）
└─ test/
   └─ ...                      # 迁移 core 的测试
```

**依赖方向**（无环）：`cli → agent-runtime`；未来的 `qq-adapter → agent-runtime`。`agent-runtime` 不依赖任何 IM 包。

### 4.2 Transport 接口（承重墙）

智能体与外界唯一的耦合点。智能体只调 Transport，宿主只实现它。

```ts
/** 智能体 → 宿主：智能体调，宿主实现。 */
export interface Transport {
  /** send_message 工具触发：把正文发给会话用户。 */
  sendMessage(scope: ScopeKey, text: string): Promise<void>;
  /** send_image 工具触发：把工作目录内的图片发给用户。未实现则不装配 send_image 工具。 */
  sendImage?(scope: ScopeKey, localPath: string): Promise<void>;
  /** 收到带图片的消息时，下载附件到工作目录。未实现则不支持收图。 */
  downloadAttachment?(url: string): Promise<Buffer>;
}

/** 宿主 → 智能体：宿主调，智能体实现。 */
export interface AgentHost {
  /** 处理一条入站消息，返回回复（智能体已通过 send_message 发出时 text 为空）。 */
  dispatch(scope: ScopeKey, message: InboundMessage): Promise<Reply>;
  /** 回收某 scope 的活跃会话（记忆摘要落盘）。 */
  reap(scope: ScopeKey): Promise<boolean>;
  /** 关闭所有会话。 */
  shutdown(): Promise<void>;
}
```

**刻意没有的方法**：
- ❌ `askUser` —— 交互改为文本内 `<suggest>` 标记（见 4.3），不再走接口。
- ❌ `dispatchInteraction` —— 没有"按钮回调"这条路径了，点击就是一条普通入站消息。
- ❌ `sendKeyboard` —— 平台专属（QQ keyboard），由宿主在翻译 `<suggest>` 时自行处理。
- ❌ `logIntermediateText` —— 旧 core 有"边想边说"机制（agent 在工具调用间自然输出的文字立即发送）。**新仓去掉**：群里容易碎消息刷屏、且与 send_message 职责重叠导致重复发送。智能体想发消息只能调 send_message，群里永远一条一条干净。代价是长任务时用户要干等——由 Spec 3 在提示词层引导 agent 在 send_message 里主动报进度来缓解，而非靠中间消息拦截。

**待确认**：Transport 是否需要 `onDispose`/连接生命周期钩子？初版倾向不要（YAGNI），宿主自己管连接。

### 4.3 中性 `<suggest>` 标记（替代 askUser）

智能体在回复正文里写：

```
要继续的话，点下面的选项：
<suggest text="深入解释第二点" show="📖 深入解释第二点" />
<suggest text="换个例子" show="🔄 换个例子" />
```

**语义**：
- `text` —— 用户点击后**实际回发的内容**（智能体下次 dispatch 收到的消息正文）。
- `show` —— 给用户看的显示文字（可带 emoji/格式，平台渲染优化用）。
- 两者分离：text 要语义清晰（智能体能处理），show 要面向用户（带视觉装饰），不必相同。

**归属**：
- 智能体**只产生** `<suggest>`，提示词里不出现任何 `qqbot-`/`slack-`/平台专属词。
- `<suggest>` 是契约，不是语法——智能体不"知道"它会被渲染成什么。
- 翻译完全在**宿主侧**，单向、无状态。

**宿主翻译表**：

| 宿主 | 翻译结果 |
|---|---|
| QQ adapter（未来 Spec） | `<qqbot-cmd-input text="深入解释第二点" show="📖 深入解释第二点" />` |
| CLI REPL | `[1] 📖 深入解释第二点   [2] 🔄 换个例子`（用户输 `1` = 回发 `text`） |
| Web（未来） | 渲染成可点击按钮，点击 → POST 那条 `text` |

**关键不变量**（写进 spec 与测试）：
1. 智能体永远只产 `<suggest>`，提示词与技能文件里零平台词。
2. 翻译是**单向、无状态**的——宿主对回复正文做一次正则/解析替换即可，无回调、无 Promise、无 pending。
3. 用户点击 → 一条**普通入站消息**，走正常 `dispatch`，与打字发的消息完全一样。智能体不区分、也无法区分它是点出来的还是打出来的。

**带走的复杂度**：旧 core 里为 askUser 存在的东西，新仓全部不要——`PendingAskHolder`、`dispatchInteraction`、`ask-user.ts` 工具、提示词里 ask_user 用法引导段。

### 4.4 提示词缓存架构（核心约束）

provider 缓存按最长公共前缀匹配。因此提示词按**稳定性从高到低**分三层拼接：

```
┌─ Tier 1：全局稳定（所有会话×所有时刻完全一致）── 缓存满命中 ─┐
│  prompts/safety.md          安全约束（去 QQ 审核话术，留通用护栏）
│  prompts/usage.md           使用准则（send_image/<suggest> 通用指引，去 <qqbot-at>）
│  prompts/reply-format.md    回复格式（通用；QQ markdown 限制由宿主在 Transport 翻译时补）
│  prompts/memory.md          记忆机制说明（memories/ 自管理、history/ 归档）
│  prompts/skills-routing.md  技能加载判断 + 调用方式（预留 Spec 2 批量 references）
│  formatSkillsForSystemPrompt(skills)   技能清单（全局共享，稳定）
└──────────────────────────────────────────────────────────────┘
┌─ Tier 2：每机器人稳定 ── 同机器人内命中 ──────────────────────┐
│  persona        （宿主提供，仅新会话/换机器人时变）
└──────────────────────────────────────────────────────────────┘
┌─ Tier 3：每会话动态 ── 不缓存，压最底 ────────────────────────┐
│  identity       scopeName / 群或私聊措辞
│  memory         memory.md 摘要
│  memoryIndex    memories/MEMORY.md
│  recentMessageCount
└──────────────────────────────────────────────────────────────┘
```

**对比旧设计**：旧提示词 `scopeName` 在第 2 段（身份段）就出现，导致其后 70%+ 的稳定内容全部 miss。新设计把 scopeName 推到 Tier 3（最底），Tier 1（提示词大头）跨所有群/所有机器人/所有时刻命中。

**文件形态**（已定：纯文本 + 占位符插值）：
- 每个 `.md` = 一段提示词，正文直接写 `{{persona}}` `{{scope_name}}` `{{memory}}` 等占位符。
- 加载器启动时读入内存，按上表顺序拼接；占位符在对应 Tier 填充。
- **加载时机**：启动时加载到内存 + 暴露 `reload()`。会话激活用内存版本。改文件后调 `reload()`（CLI 一条命令，或进程重启）。不上热重载（YAGNI，非高频改）。

**Tier 1 与平台无关的保证**：safety/usage/reply-format/memory/skills-routing 五段，正文里不得出现 `qqbot-`、`QQ`、`openid`、`<qqbot-at-user>` 等任何平台词。平台专属的格式约束（如"QQ 不支持代码块"）由宿主在 Transport 层补充，不写进智能体提示词。这是新仓的可测不变量。

**副作用收益**：`admin-api` 里手抄的 `PROMPT_TEMPLATE` 删除——预览改成读 builder 产出的真实字符串，漂移问题根除（但 admin-api 属旧仓，是 Spec 1 的收尾小改）。

### 4.5 工具集

| 工具 | 来源 | 平台无关 |
|---|---|---|
| bash（受限，白名单外置） | 迁自 core `restricted-bash.ts`，`ALLOWED_COMMANDS`/`FORBIDDEN_PATTERNS` 抽到 `config/bash-policy.json` | ✅ |
| read / edit / write | 迁自 core | ✅ |
| load_skill | 迁自 core（Spec 2 改默认批量带 references） | ✅ |
| send_message | 调 `Transport.sendMessage` | ✅（接口中立） |
| send_image | 调 `Transport.sendImage`，仅当 Transport 实现了 sendImage 才装配 | ✅ |
| ~~ask_user~~ | **删除** | — |

工具描述（给 LLM 看的 `description` 字段）随工具代码走，**不外置到提示词文件**——description 通过 pi-agent-core 的 function-calling tools API 单独发给 LLM，不进系统提示词正文（旧 core 已如此，保持）。白名单/黑名单是配置，外置到 JSON。

### 4.6 会话生命周期（迁自 core，去 QQ 特化）

保留 core 的成熟设计，只剥离 QQ 耦合点：

- **激活**：首条消息 → 读 `memory.md` + 历史 → 建 pi Agent（装 bash/read/edit/write + send_message + 可选 send_image + load_skill）→ 进入 active。
- **对话**：同 scope 消息串行 dispatch（pi Agent 不可重入）。
- **回收**（TTL 无活动）：agent 自总结 → 写 `memory.md` → 落盘 `session.jsonl` + 按天归档 → 销毁 Agent。
- **续接**：下次消息到达重载记忆与历史。

**剥离的 QQ 特化**：
- 群消息合并（`steeringMode="all"`）——保留机制，但"群 vs 私聊"的措辞/前缀格式化从核心循环移到宿主传入的 `InboundMessage`（宿主负责把消息格式化成 `[sender]: text` 或裸 text 再传进来）。
- `replyToHolder`（被动回复引用）——这是 QQ 的被动消息机制，移到 QQ adapter（未来 Spec），不进新仓。新仓的 `dispatch` 只返回 `{ text, replyToMessageId? }`，replyToMessageId 由宿主自己管。
- `onAttachment` 回调——改成 `Transport.downloadAttachment`，宿主下载后把相对路径拼进 text 传进来（与旧逻辑一致，只是接口形态变了）。

### 4.7 CLI REPL 测试宿主

新仓自带 `cli/repl.ts`，第一版交付用它验证稳定性。实现最简 Transport：

```ts
const cliTransport: Transport = {
  async sendMessage(_scope, text) { console.log(`\n🤖 ${text}`); },
  async sendImage?(_scope, path) { console.log(`\n🖼️  [图片已保存] ${path}`); },
  // downloadAttachment 不实现（CLI 不收图）
};
```

CLI 命令：

```
> 帮我做张支援卡                       # 普通对话
🤖 要继续的话，点下面的选项：           # 回复正文含 <suggest>
  [1] 📖 深入解释   [2] 🔄 换例子      # CLI 翻译的渲染
> 1                                    # 等于回发 "深入解释"（suggest.text）
> /prompt                              # 查看完整 system prompt（含分段标注 + 缓存前缀估算）
> /reload                              # 改完 prompts/*.md 后重载
> /session new                         # 开新会话看缓存命中
> /trace on                            # 显示每次工具调用耗时
> /skills                              # 列出已加载技能
> /quit
```

调试输出是"外部测稳"的核心价值：提示词分段（Tier1/Tier2/Tier3 各多少字）、缓存前缀估算、工具调用 trace——这些在 QQ 端很难看到。

## 5. 数据流（一次 dispatch）

```
用户消息
  ↓ 宿主格式化（如 QQ 加 [openid]: 前缀）+ 下载附件拼路径
  ↓ 作为 InboundMessage 调 AgentHost.dispatch(scope, msg)
  ↓
SessionManager 找/建该 scope 的会话
  ↓ 激活时：builder 按 Tier1→2→3 拼系统提示词，建 pi Agent
  ↓
pi Agent 跑循环：
  ├─ send_message 工具 → Transport.sendMessage → 宿主发正文（含 <suggest>）
  │     └─ 宿主翻译 <suggest> 为平台渲染（QQ→<qqbot-cmd-input>、CLI→编号列表）
  ├─ send_image 工具 → Transport.sendImage → 宿主发图
  ├─ bash/read/edit/write/load_skill → 沙箱/宿主文件系统
  └─ 最终文字 → dispatch 返回 { text }（用了 send_message 则为空）
  ↓
用户点击 <suggest> 渲染出的按钮
  ↓ 平台回发 text（如 "深入解释第二点"）
  ↓ 作为普通 InboundMessage 再次 dispatch（与打字消息无差别）
```

## 6. 错误处理

- **Transport 方法抛错**：send_message/send_image 失败 → 捕获记日志，向 agent 返回工具错误结果（agent 可重试或换方式），不让单条发送失败拖垮会话。
- **提示词文件缺失/语法错**：启动加载时校验所有占位符可解析、必需段存在；失败则启动失败并报清楚缺哪个文件（fail-fast，不静默跑空提示词）。
- **reload 失败**：保留旧内存版本，记日志，CLI 打印错误，不替换。
- **沙箱命令越权**：restricted-bash 拒绝并返回原因给 agent（迁自旧 core 行为）。

## 7. 测试

- **迁自 core 的测试**：session 生命周期、记忆落盘/续接、技能加载路径重写、restricted-bash 白名单——这些 core 已有测试，迁移并适配新接口。
- **新增**：
  - `prompt/builder` 三层分层拼接顺序、占位符插值正确性、Tier1 零平台词扫描。
  - `suggest` 标记：智能体产出 → 宿主翻译的单向性、点击回发 = 普通消息。
  - CLI REPL 冒烟（用脚本喂输入流验端到端）。
- 测试用真的 pi-agent-core Agent + mock Transport，不打真实 LLM（用假 streamFn）。

## 8. Spec 1 交付边界

**做（新仓 `agent-runtime`）**：
1. 新仓库脚手架（包结构、构建、tsconfig、pi-agent-core/pi-ai 依赖）。
2. Transport / AgentHost 接口定义。
3. 从 core 迁移 session/skills/memory/identity/tools(平台无关)。
4. 提示词文件化 + 三层缓存分层 builder + 占位符插值 + reload()。
5. 中性 `<suggest>` 标记契约 + 文档。
6. CLI REPL 宿主（含调试输出）。

**做（旧仓 `群聊机器人/` 收尾小改）**：
7. 删除 `admin-api/src/routes/settings.ts` 里的 `PROMPT_TEMPLATE` 副本，预览改成读真实 builder 产出。这条改动在旧仓，目的是根除漂移源；与新仓代码无依赖关系，可独立提交。

**不做**（后续单独 spec）：
- Spec 2：工具链提速。
- Spec 3：交互减负（技能引导重写 + 确认门审计）。
- Spec 4：thinking level 拆分 + 模型调优。
- Spec 5：QQ 适配器迁移（智能体 CLI 测稳之后）。

## 9. 待定项

- **Transport 是否需要连接生命周期钩子**：初版倾向不要（YAGNI）。
- **包名（npm scope）**：占位 `@arkham-agent-runtime/core`，评审时定。

## 10. 后续 spec（仅索引，本文不展开）

- **Spec 2 — 工具链提速**：load_skill 默认批量带 references、并行工具调用、砍冗余往返。
- **Spec 3 — 交互减负**：重写 skills-routing 引导段、审计各技能确认门、默认自主推进。
- **Spec 4 — 延迟调优**：thinking level group/user 拆分（接 `.wip/`）+ 模型选择。
- **Spec 5 — QQ 适配器迁移**：把 `bot-manager.ts` 的回调改成 Transport 实现，替换旧 core。
