/**
 * 调试渲染：给每张卡叠上 code 标注，缺图卡画亮红底 + code。
 * 用来精确定位「黑/白」卡是哪些 code、为什么。
 */
import { readFileSync, existsSync } from "node:fs";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import { registerFonts } from "../src/fonts.ts";
import { loadCardMetadata } from "../src/data/card-metadata.ts";
import { organizeDeck } from "../src/deck/organize.ts";
import { autoLayout, DEFAULT_LAYOUT_PARAMS as P } from "../src/deck/auto-layout.ts";
import { createCardImageResolver } from "../src/data/card-image-resolver.ts";
import { sectionHeight } from "../src/engine.ts";

const ROOT = "/Users/xziying/project/arkham";
const CARD_IMG = `${ROOT}/card-database/card_images`;
const deckFile = process.argv[2] ?? "fixtures/deck-4689495.json";
const outFile = process.argv[3] ?? "output/debug-labeled.jpg";

registerFonts(`${ROOT}/arkham-homebrew/fonts`);
const meta = await loadCardMetadata(`${ROOT}/社区数据库/arkhamdb-json-data`, `${ROOT}/card-database`);
const deck = JSON.parse(readFileSync(deckFile, "utf8")) as Parameters<typeof organizeDeck>[0];
const org = organizeDeck(deck, meta);
const layout = autoLayout(org, { title: deck.name });
const resolver = createCardImageResolver({ cardDatabaseDir: `${ROOT}/card-database` });

// 计算画布高
let maxBottom = 0;
for (const s of layout.sections) maxBottom = Math.max(maxBottom, s.pos[1] + sectionHeight(s, layout.canvas.width));
const height = Math.ceil(maxBottom + 50);
const canvas = createCanvas(layout.canvas.width, height);
const ctx = canvas.getContext("2d");
ctx.fillStyle = layout.canvas.background ?? "#f6faff";
ctx.fillRect(0, 0, layout.canvas.width, height);

let missingCount = 0;
let foundCount = 0;

function drawSlot(code: string, label: string, x: number, y: number, w: number, h: number) {
	const hasImg = existsSync(`${CARD_IMG}/${code}_a.jpg`) || code.endsWith("-t") && existsSync(`${CARD_IMG}/${code.slice(0, -2)}_a.jpg`);
	if (hasImg) {
		foundCount++;
		// 正常：画个绿框 + code，表示有图（这里不画真图，只标注，更快）
		ctx.strokeStyle = "#00a000";
		ctx.lineWidth = 4;
		ctx.strokeRect(x, y, w, h);
	} else {
		missingCount++;
		// 缺图：亮红底 + code
		ctx.fillStyle = "#e02020";
		ctx.fillRect(x, y, w, h);
	}
	// code 标注（黄底黑字，右下角）
	const tag = code;
	ctx.font = `bold 22px SourceHanSans`;
	const tw = ctx.measureText(tag).width;
	ctx.fillStyle = "rgba(255,220,0,0.9)";
	ctx.fillRect(x + w - tw - 10, y + h - 32, tw + 8, 28);
	ctx.fillStyle = "#000";
	ctx.textAlign = "left";
	ctx.textBaseline = "middle";
	ctx.fillText(tag, x + w - tw - 6, y + h - 18);
}

// 画 section 框 + 卡牌槽标注
for (const s of layout.sections) {
	const sh = sectionHeight(s, layout.canvas.width);
	// 框
	ctx.strokeStyle = s.headerColor ?? "#515f66";
	ctx.lineWidth = 3;
	ctx.roundRect(s.pos[0], s.pos[1], s.width ?? layout.canvas.width - 100, sh, 10);
	ctx.stroke();
	// 标题
	ctx.fillStyle = s.headerColor ?? "#515f66";
	ctx.fillRect(s.pos[0], s.pos[1], s.width ?? layout.canvas.width - 100, s.titleHeight ?? 70);
	ctx.fillStyle = "#fff";
	ctx.font = `28px SourceHanSans`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(s.title + " " + s.cards.length + "张", (s.pos[0] + (s.width ?? layout.canvas.width - 100)) / 2, s.pos[1] + (s.titleHeight ?? 70) / 2);
	// 卡槽
	const cols = s.cols ?? 7;
	const cw = s.cardSize[0], ch = s.cardSize[1], gap = s.gap ?? 12;
	const innerX = s.pos[0] + 30;
	const cardsY = s.pos[1] + 30 + (s.titleHeight ?? 70) + gap;
	for (let i = 0; i < s.cards.length; i++) {
		const r = Math.floor(i / cols), c = i % cols;
		drawSlot(s.cards[i].code, s.cards[i].label ?? s.cards[i].code, innerX + c * (cw + gap), cardsY + r * (ch + gap), cw, ch);
	}
}

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, canvas.toBuffer("image/jpeg", 0.9));
console.log(`✓ 调试图 → ${outFile}`);
console.log(`有图: ${foundCount}  缺图: ${missingCount}`);
void GlobalFonts;
