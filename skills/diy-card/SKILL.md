---
name: diy-card
description: >
  诡镇奇谭（Arkham Horror LCG）DIY 卡牌助手。两种模式：
  (1) 生成卡牌图片（「帮我做张卡」「设计一张敌人卡」「来张DIY卡」「生成卡图」）；
  (2) 帮用户把大白话效果描述翻译成官方规范语法（「帮我写个效果」「这个效果怎么写」「翻译成卡牌用语」）。
  Covers all card types: 支援卡/事件卡/技能卡/调查员/敌人/地点/诡计/场景/密谋/升级卡.
---

# DIY 卡牌助手

两种模式：**生成卡图** 和 **纯文本效果编写**。根据用户意图选择。

> **🚨 铁律（最高优先级）**
> 1. **渲染出的卡图必须带插画**。除非用户自己发了图，否则渲染前必须先调 generate_image 画插画并写进 .card 的 `picture_path`（唯一例外：升级卡用固定模板卡框）。没有 `picture_path` 就直接渲染 = 事故。
> 2. **直接出图，不要问「是否确认生成」**。把卡做出来发出去，用结果说话。
> 3. **用户给的东西能用就用，绝不替用户操心**。数值/正文是用户给的 → 原样写进 .card，不校验、不改写。
> 4. **不要用 bash 探索工作目录结构**。下面的「工作目录布局」已经告诉你了，直接用。

## 工作目录布局（不用 ls 探索，直接用）

```
cards/in/     ← 你写的 .card 文件放这里（文件名 000.card, 001.card...）
cards/out/    ← 渲染产物（.png），arkham-cli 自动生成
generated/    ← generate_image 画的插画（art-xxx-1.jpg）
inbox/        ← 用户发来的图片
.arkham/bin/arkham-cli  ← 渲染工具
.arkham/assets/         ← 渲染资源
skills/       ← 技能源文件（只读）
```

## 渲染说明
渲染通过 `render_card` 工具完成——传 JSON 内容，工具自动写文件 + 调 arkham-cli 渲染。你不需要手动跑 bash render。

## 加载规则（系统提示词的 skills-routing 已说明，这里只强调本技能视角）

- **用户输入完整**（数值+正文都给齐，正文用了规范术语）→ **只加载 diy-card**。
- **正文是大白话** → 额外加载 `card-text-lint`。
- **要设计数值** → 额外加载 `arkham-card-numbers`。
- 不确定 → 先 `send_message` 问用户意图。

---

## 模式 A：生成卡图（固定 4 步，不要自由发挥）

### Step 1：首条反馈 + 一轮并行启动

收到制卡请求，**第一轮就并行做这两件事**（不要串行，不要先探索）：

1. `send_message("收到，开始做这张卡，先画插画")` —— 首条反馈
2. `generate_image(description, type)` —— 画插画（用户没发图且不是升级卡时）

技能说明已经在你上下文里了，不需要加载。需要查字段模板时用 `read skills/diy-card/references/card-types.md`。

**不要在第一轮调 bash/read 探索目录**——你知道布局（见上）。

### Step 2：渲染卡图（用 render_card 工具，传 JSON 内容）

用 `render_card` 工具，把 .card 的 JSON 内容作为 `cardJson` 参数传入。工具内部自动写文件 + 渲染，返回图片路径（如 `cards/out/000.png`）。**不需要先 write 再 bash render——一步到位。**

**数值/正文处理原则**：
- 用户给的数值 → **原样写入** JSON
- 用户给的正文（已用规范术语）→ **原样写入** JSON
- 走了 card-text-lint 的 → 写 lint 后的规范版本
- 走了 arkham-card-numbers 的 → 写配平后的数值；跑 balance_check，error 清零
- **A 流程（用户给全的）不要跑 balance_check**

**picture_path**（必须填，除非升级卡）：
- 用户发图 → `"picture_path": "inbox/xxx.jpg"`（**不加 @ 前缀**）
- 自动画的 → `"picture_path": "generated/art-xxx-1.jpg"`（用第 1 张）
- 升级卡 → 不填

查字段模板用 `read skills/diy-card/references/card-types.md`。

### Step 3：发图 + 交付

`send_image(cards/out/000.png)` 发卡图，然后 `send_message` 附一句：
```
出了，要改哪里告诉我（数值/正文/插画都可以调）。
需要我把可编辑的 .card 源文件也发给你吗？要用编辑器自己改的话说一声。
```

用户要 .card → 调 `send_card(cards/in/000.card)`。

---

## 模式 B：纯文本效果编写（不生成卡图）

1. `load_skill("card-text-lint")` 加载语法技能，按官方规范重写。
2. `send_message` 把校准后的效果发给用户。
3. 用户确认后可问「要不要帮你生成卡图？」——说要就切到模式 A。

---

## generate_image 要点

- description 公式：`[主体+外观]+[动作/状态]+[环境]+[唯一光源]+[情绪]`。必须指定唯一光源（提灯/月光/窗口）；只写画面主体，风格词不用写（工具模板已带）。
- 卡牌类型 → type 映射：

| 卡牌类型 | type |
|---|---|
| 调查员 / 盟友 | `character` |
| 敌人 | `monster` |
| 地点 / 场景 / 事件 / 诡计 / 密谋 | `scene` |
| 支援（道具/武器/法术）/ 技能 | `item` |

- `n` 用默认值 1（只生成 1 张，够用）。用户不满意再调 n=2 生成备选。
- 用第 1 张（`generated/art-xxx-1.jpg`）。
- **绝对不要 read 生成的图片**——模型不支持图片输入，read 图片后后续对话会空回复卡死。
- 生成失败 → 告诉用户「画插画失败了」，问他自己发图还是重试。

---

## 字段缺失处理（最小发问）

能从上下文推断就推断。只在关键字段推断不了、且选错方向就全废时才 ask_user 一次。副标题/背景故事等可选字段一律留空或默认。

---

## 图标语法速查

body 里必须用 emoji，不用尖括号标签：

| 含义 | emoji | | 含义 | emoji |
|---|---|---|---|---|
| 意志 | 🧠 | | 战斗 | 👊 |
| 智识 | 📚 | | 敏捷 | 🦶 |
| 行动 | ➡️ | | 快速/反应 | ⚡ |
| 回合结束 | ⭕ | | 独特 | 🏅 |

被动触发（「在…后」「当…时」）用 ⭕ 不用 ⚡。完整标签参考见 `references/tag-reference.md`。

## 常见错误

- 没画插画就渲染（必须先 generate_image）
- 发预览等用户确认再渲染（直接做）
- 替用户改数值/正文（用户没要求时）
- 用 bash 探索目录（布局已知，直接用）
- 渲染命令改路径（固定命令，照抄）
- 调查员卡背的 `class` 必须和正面一致

## 参考文件索引

| 你想做什么 | 读这个文件 |
|---|---|
| 查卡牌类型字段和 JSON 模板 | `references/card-types.md` |
| 查完整富文本标签（emoji/花括号/方括号） | `references/tag-reference.md` |
| 给用户的制卡引导 | `references/guide.md` |
| 数值配平 | 调用 `load_skill("arkham-card-numbers")` |
| 卡牌正文语法校准 | 调用 `load_skill("card-text-lint")` |
