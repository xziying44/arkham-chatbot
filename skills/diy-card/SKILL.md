---
name: diy-card
description: >
  生成诡镇奇谭（Arkham Horror LCG）DIY 自定义卡牌图片。Use when the user wants to
  create/design/generate a card (「帮我做张卡」「设计一张敌人卡」「来张DIY卡」「生成卡图」).
  Covers all card types: 支援卡/事件卡/技能卡/调查员/敌人/地点/诡计/场景/密谋/升级卡.
---

# DIY 卡牌图片生成

用 `arkham-cli` 把卡牌 JSON 渲染成阿卡姆恐怖 LCG 风格的卡牌图片，发送给用户。

## 工作流（严格按顺序执行）

### Step 1：收集信息

确认用户想要什么卡。必须收集：
- **卡牌类型**：若用户没指定，用 ask_user 问（支援卡/事件卡/技能卡/调查员/敌人/地点/升级卡）
- **名称**（name）
- **正文**（body）：效果描述。**把大白话翻译成规范语法是你的核心工作**——如果用户描述不标准，读 `skills/card-text-lint/SKILL.md` 校准
- **职业**（class）：守护者/探求者/流浪者/潜修者/生存者/中立

若用户已给全，直接下一步。不足则用 ask_user 或 send_message 简短地问。

### Step 2：查卡牌类型模板

**根据卡牌类型，读对应模板**——不要凭记忆写，模板里有必填字段和 JSON 结构：

| 卡牌类型 | 说明 |
|---|---|
| 支援卡/事件卡/技能卡/升级卡/调查员/敌人卡/地点卡/诡计卡/场景卡/密谋卡/故事卡 | **读 `references/card-types.md`** 查完整字段说明和 JSON 模板 |

### Step 3：数值配平（自由设计数值时必须做）

当你需要自己决定 cost/属性/生命理智/伤害等数值时（用户没精确指定）：

1. **调用 `load_skill("arkham-card-numbers")`** 加载数值模型专家技能
2. 按卡牌类型读它的 references 文件锁定预算区间
3. 写完 .card 后跑校验脚本（见 Step 5）

**用户已精确指定所有数值时可跳过**，但仍建议跑校验兜底。

### Step 4：写 .card 文件

用 write 工具写 JSON 到 `cards/in/000.card`（文件名前3位必须是数字）。

**常见错误提醒**：
- 调查员卡背的 `class` 必须和正面一致（漏填会用中立卡框）
- 被动触发效果（「在…后」「当…时」）用 ⭕ 反应图标，不要用 ⚡ 闪电（⚡ 仅用于主动免费行动）
- 完整语法规范见 `skills/card-text-lint/SKILL.md`（调 load_skill 加载）

**图标语法速查**（body 里必须用 emoji，不用尖括号标签）：

| 含义 | emoji | | 含义 | emoji |
|---|---|---|---|---|
| 意志 | 🧠 | | 战斗 | 👊 |
| 智识 | 📚 | | 敏捷 | 🦶 |
| 行动 | ➡️ | | 快速/反应 | ⚡ |
| 回合结束 | ⭕ | | 独特 | 🏅 |

常用写法：`得到+2👊`、`造成1点伤害`、`发现1个线索`、`获得2资源`、`【攻击】`、`【调查】`。
完整标签参考见 `references/tag-reference.md`。

### Step 5：数值校验（配了数值的卡建议跑）

```bash
python3 skills/arkham-card-numbers/scripts/balance_check.py "$(cat cards/in/000.card)"
```

error 必须清零，warning 需在回复里给出补偿理由。脚本只读 JSON 输出校验结果，安全。

### Step 6：渲染卡图

```bash
mkdir -p cards/out
.arkham/bin/arkham-cli render \
  --corpus cards/in \
  --assets .arkham/assets \
  --workspace . \
  --out cards/out
```

- `--workspace .` **必须带**：解析 picture_path 的相对路径
- 输出：`cards/out/000.png`
- 看输出里的 `[OK ]` / `[ERR]` 判断成功

### Step 7：发送图片

用 send_image 工具发送 `cards/out/000.png`。

## 图片处理

- 升级卡（DIY卡）：不需要图片，用固定模板卡框
- 其它卡类型用用户提供的底图：用户发图片时自动存到 `inbox/`，在 .card 里写 `"picture_path": "inbox/xxx.jpg"`（**不加 @ 前缀**）
- 沙箱断网，无法下载网上图片 URL

## 常见问题

- **渲染失败**：检查 JSON 合法性，body 里引号要 `\"` 转义
- **文件名错误**：必须是 `NNN*.card`（前3位数字），如 `000.card`
- **图标没渲染**：确认用 emoji（👊📚🧠🦶）不是尖括号标签（`<拳>` 是错的）
- **底图没贴上**：确认 picture_path 不带 `@`，渲染命令带了 `--workspace .`

## 参考文件索引

| 你想做什么 | 读这个文件 |
|---|---|
| 查卡牌类型字段和 JSON 模板 | `references/card-types.md` |
| 查完整富文本标签（emoji/花括号/方括号） | `references/tag-reference.md` |
| 给用户的制卡引导（怎么做卡） | `references/guide.md` |
| 数值配平（cost/属性/伤害预算） | 调用 `load_skill("arkham-card-numbers")` |
| 卡牌正文语法校准（大白话→规范语法） | 调用 `load_skill("card-text-lint")` |
