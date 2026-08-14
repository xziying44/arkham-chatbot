/**
 * 「自由排班」演示：读默认排班表 → 编辑（改列数/合并块/加水印）→ 重渲。
 * 证明引擎是数据驱动的：agent 改 spec 就能改版式，无需碰渲染代码。
 */
import { readFile, writeFile } from "node:fs/promises";
import { registerFonts } from "../src/fonts.ts";
import { createCardImageResolver } from "../src/data/card-image-resolver.ts";
import { renderDeck } from "../src/engine.ts";

const CARD_DB = "/Users/xziying/project/arkham/card-database";
const FONTS = "/Users/xziying/project/arkham/arkham-homebrew/fonts";

const layout = JSON.parse(await readFile("fixtures/layout-4723683.json", "utf8"));

// 1) 支援卡改成 5 列大卡
const asset = layout.sections.find((s: { title: string }) => s.title === "支援卡");
asset.cols = 5;
asset.cardSize = [520, 750];
asset.gap = 16;

// 2) 合并「事件卡」+「技能卡」
const ev = layout.sections.find((s: { title: string }) => s.title === "事件卡");
const sk = layout.sections.find((s: { title: string }) => s.title === "技能卡");
ev.title = "事件 / 技能";
ev.cards = [...ev.cards, ...sk.cards];
layout.sections = layout.sections.filter((s: { title: string }) => s.title !== "技能卡");

// 3) 紫色(mystic)标题 + 水印浮层
const mystic = "#7d53b0";
for (const s of layout.sections) s.headerColor = mystic;
layout.extras = [
	{
		kind: "text",
		text: "✦ 重排版演示 ✦",
		pos: [1410, 6780],
		fontSize: 40,
		color: mystic,
		font: "HanyiLiShu",
		align: "center",
	},
];

await writeFile("fixtures/layout-4723683-edited.json", JSON.stringify(layout, null, 2));
registerFonts(FONTS);
const resolver = createCardImageResolver({ cardDatabaseDir: CARD_DB });
const buf = await renderDeck(layout, { resolver, format: "jpeg" });
await writeFile("output/deck-4723683-edited.jpg", buf);
console.log("✓ 重排版渲染完成");
console.log("  sections:", layout.sections.map((s: { title: string; cards: unknown[] }) => `${s.title}(${s.cards.length})`).join(", "));
console.log("  JPG:", `${(buf.length / 1024).toFixed(0)}KB`);
