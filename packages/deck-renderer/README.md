# @arkham/deck-renderer

诡镇奇谭（Arkham Horror LCG）**卡组分享渲染引擎**。把旧的 `create_deck.py`（布局写死的 PIL 脚本）重构成数据驱动：核心是一份「排班表 JSON」，引擎忠实渲染它；`autoLayout` 能从卡组数据自动生成一版默认排班表，智能体拿到后可自由编辑再重渲。

## 设计：数据 → 布局 → 渲染 三层解耦

```
deck_id ──fetch──▶ slots 映射
                  │
              organize ──▶ 调查员/永久支援/支援/事件/技能/副卡（分类+排序）
                  │            （metadata 合并 社区数据库标准字段 + card-database 中文名/卡图）
             autoLayout ──▶ DeckLayout（排班表 JSON）
                  │
        ┌─────────┴──────────┐
        ▼ agent 自由编辑 spec  ▼
     renderDeck ◀────────── （改顺序/合并块/换列数/挪位置/加浮层）
        │
        ▼
     JPEG/PNG（send_image 发送）
```

### 排班表（DeckLayout）核心契约

```ts
interface DeckLayout {
  canvas: { width: number; height?: number; background?: string };
  header?: { investigator?; signature?; title?; subtitle? };
  sections: DeckSection[];   // 自由排班核心
  extras?: Array<TextItem | FreeImage>;
}
interface DeckSection {
  title: string; pos: [x,y]; width?; cols?; cardSize: [w,h];
  gap?; titleHeight?; headerColor?; background?: "rounded"|"none";
  cards: CardRef[];   // 顺序=排班顺序，块内按 cols 自动换行
}
```

agent 拿到这份 JSON 可任意改：调块顺序、合并/拆分块、改列数、并排两块（改 pos）、加水印/宣传语（extras），改完丢回 `renderDeck` 重渲。

## 分层结构

| 文件 | 职责 |
|---|---|
| `src/types.ts` | 排班表类型契约（DeckLayout / DeckSection / CardRef …） |
| `src/engine.ts` | Layer1 渲染引擎：spec → 图片。纯渲染，卡图经 resolver 注入，cover-fit + LRU 缓存 |
| `src/theme.ts` / `src/fonts.ts` | 默认主题（阵营色/字体/宣传语）+ 字体注册 |
| `src/data/card-image-resolver.ts` | Layer2 code+face → 卡图 buffer（card-database/card_images，含 taboo `-t` 回退） |
| `src/data/card-metadata.ts` | Layer2 合并标准字段（permanent/slot/restrictions…）+ 中文名/卡图，进程级缓存 |
| `src/deck/fetch-deck.ts` | Layer3 ArkhamDB 公开 API 拉取 deck JSON |
| `src/deck/organize.ts` | Layer3 分类排序（移植旧 organize_deck + asset_slot_weight） |
| `src/deck/auto-layout.ts` | Layer3 organized deck → 默认 DeckLayout |
| `src/cli.ts` | CLI：inspect / plan / check / render |
| `src/validate.ts` | 静态图名校验：缺图卡 + 候选 ID 建议 + 文字报告 |
| `src/stress.ts` | 压测脚本 |

## 用法

### CLI（验收）

```bash
pnpm cli inspect --deck 4689495                      # 导入+分类，打印摘要
pnpm cli plan    --deck 4689495 --out plan.json      # 默认槽位 plan（agent 可编辑）
pnpm cli check   --plan plan.json                    # 静态图名校验 → 缺图警告 + 候选 ID
pnpm cli render  --plan plan.json --out deck.jpg     # plan → 渲染 + 每卡位置 + 缺图校验
pnpm cli render  --deck 4689495 --out deck.jpg       # 一步：导入+排班+渲染
pnpm cli render  --deck 4689495 --format png         # 输出 PNG（无损，慢）
```

`--deck` 接数字（在线拉取）或本地 `.json` 文件；路径默认指向本机 `card-database` / `社区数据库/arkhamdb-json-data` / `arkham-homebrew/fonts`，可用 `--card-db/--arkhamdb/--fonts` 或环境变量覆盖。

### 编程式

```ts
import { registerFonts, loadCardMetadata, fetchDeck, organizeDeck, autoLayout, createCardImageResolver, renderDeck } from "@arkham/deck-renderer";

registerFonts(fontsDir);
const meta = await loadCardMetadata(arkhamDbDir, cardDbDir);
const deck = await fetchDeck("4689495");
const layout = autoLayout(organizeDeck(deck, meta), { title: deck.name });
const jpg = await renderDeck(layout, { resolver: createCardImageResolver({ cardDatabaseDir: cardDbDir }) });
```

## 性能（压测，真实公开卡组）

| 指标 | 结果 |
|---|---|
| 冷启动单卡组 | 65ms（36 槽）/ 含卡图解码 |
| 热渲染 p50 / p95 | **56ms / 90ms**（200 次） |
| heap | 稳定 9MB，0 增长（LRU 缓存 + 原生 canvas 内存托管） |
| 最大卡组（54 槽） | 56ms |

瓶颈是图片编码：默认 **JPEG q0.9**（~30ms，视觉无损，旧版同样存 JPEG）比 PNG（~290ms）快约 9 倍。需要无损时 `format: "png"`。

## 与旧 create_deck.py 的差异

- 旧版布局全写死在 `draw_deck`；新版**全部以坐标/参数输出到 spec**，引擎只忠实渲染。
- 每个类别块自带圆角背板（旧版是「玩家卡组」一个大框套 4 子块），更利于自由排班（合并/拆分/并排）。
- 渲染从 Python/PIL 换成 TypeScript `@napi-rs/canvas`，与机器人同栈，无跨进程依赖。
- 分类逻辑（permanent/slot/restrictions/slot_weight）等价移植，数据源用本地社区数据库 + card-database。

## 静态图名校验（缺图警告）

渲染前可调 `validateDeckPlan(plan, cardImagesDir)`：检查每个卡 code 在卡图目录是否有图。
缺图的返回结构化警告（含卡名/槽位/候选文件），并尝试建议修正 ID——比如 code 带尾字母
（`11068a`）但目录图是 `11068_a.jpg` 时，建议改用 `11068`。常见的缺图原因：粉丝/扩展卡
本地未收录（60xxx/11xxx）、随机弱点占位卡（01000）本就无图。agent 拿到警告后可以改 ID、
换卡，或提示用户该卡无图。

## 测试

```bash
pnpm test      # organize + engine 单测（13 项）
pnpm stress    # 压测 + 生成示例图
```

## Phase 2（待集成，尚未实现）

验收通过后，包成 3 个 agent 工具（仿 `render-card.ts` 范式），在 `packages/server/src/bot-manager.ts` 的 `extraToolsFactory` 注册：
- `import_deck(deck_id)` → fetch + organize，返回卡组摘要
- `auto_layout_deck(deck_id)` → 生成排班表 JSON（agent 可编辑）
- `render_deck(layoutJson)` → 渲染图片，返回路径，接 `send_image`

新增 env `CHATBOT_ARKHAMDB_DATA_DIR`（社区数据库）；卡图复用 `CHATBOT_CARD_DATABASE_DIR`。
