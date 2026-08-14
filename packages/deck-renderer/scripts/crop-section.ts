/**
 * 裁出某个 section 的局部，原始分辨率查看卡牌实际排列（间距/对齐）。
 */
import { readFileSync } from "node:fs";
import { createCanvas, Image } from "@napi-rs/canvas";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadCardMetadata } from "../src/data/card-metadata.ts";
import { organizeDeck } from "../src/deck/organize.ts";
import { autoLayout } from "../src/deck/auto-layout.ts";
import { sectionHeight } from "../src/engine.ts";

const ROOT = "/Users/xziying/project/arkham";
const deckFile = process.argv[2] ?? "fixtures/deck-4689495.json";
const srcImg = process.argv[3] ?? "output/deck-4689495-v2.jpg";
const out = process.argv[4] ?? "output/crop-section.jpg";

const meta = await loadCardMetadata(`${ROOT}/社区数据库/arkhamdb-json-data`, `${ROOT}/card-database`);
const deck = JSON.parse(readFileSync(deckFile, "utf8")) as Parameters<typeof organizeDeck>[0];
const layout = autoLayout(organizeDeck(deck, meta), { title: deck.name });

console.log("sections:");
for (let i = 0; i < layout.sections.length; i++) {
	const s = layout.sections[i];
	const h = sectionHeight(s, layout.canvas.width);
	console.log(`  [${i}] ${s.title}  pos=(${s.pos[0]},${s.pos[1]}) w=${s.width} h=${h} cards=${s.cards.length} cols=${s.cols} cardSize=${s.cardSize} gap=${s.gap}`);
}

// 裁哪个 section：第 5 个参数指定下标，否则取卡最多的
let pick = 0;
if (process.argv[5] !== undefined) {
	pick = Number(process.argv[5]);
} else {
	for (let i = 0; i < layout.sections.length; i++) if (layout.sections[i].cards.length > layout.sections[pick].cards.length) pick = i;
}
const s = layout.sections[pick];
const h = sectionHeight(s, layout.canvas.width);
const pad = 16;
const x0 = Math.max(0, s.pos[0] - pad);
const y0 = Math.max(0, s.pos[1] - pad);
const cw = (s.width ?? layout.canvas.width - 100) + pad * 2;
const ch = h + pad * 2;

const img = new Image();
img.src = readFileSync(srcImg);
const c = createCanvas(cw, ch);
const ctx = c.getContext("2d");
ctx.drawImage(img, x0, y0, cw, ch, 0, 0, cw, ch);
// 在每张卡的位置画红框（槽位边界），让间隙一目了然
const cols = s.cols ?? 7;
const cardW = s.cardSize[0], cardH = s.cardSize[1], gap = s.gap ?? 12;
const innerX = s.pos[0] + 30;
const cardsY = s.pos[1] + 30 + (s.titleHeight ?? 70) + gap;
ctx.strokeStyle = "#ff0000";
ctx.lineWidth = 3;
for (let i = 0; i < s.cards.length; i++) {
	const r = Math.floor(i / cols), col = i % cols;
	const cx = innerX + col * (cardW + gap);
	const cy = cardsY + r * (cardH + gap);
	ctx.strokeRect(cx - x0 + 1, cy - y0 + 1, cardW - 2, cardH - 2);
}
await mkdir(dirname(out), { recursive: true });
await writeFile(out, c.toBuffer("image/jpeg", 0.92));
console.log(`\n✓ 裁剪 section[${pick}] ${s.title} → ${out} (${cw}x${ch})`);
