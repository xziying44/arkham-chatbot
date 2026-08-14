/**
 * 像素级测量：扫描渲染图，测出卡牌实际宽度/高度 和 卡牌间真实间隙(px)。
 * 不靠肉眼看，用 getImageData 数像素。
 *
 * 用法：tsx scripts/measure-gaps.ts <图片> <sectionY> <cardsY> <cardH预期>
 */
import { readFileSync } from "node:fs";
import { createCanvas, Image } from "@napi-rs/canvas";

const file = process.argv[2] ?? "output/deck-plan-4689495.jpg";
const sectionY = Number(process.argv[3] ?? 1360); // 支援卡 section y
const img = new Image();
img.src = readFileSync(file);
const c = createCanvas(img.width, img.height);
const ctx = c.getContext("2d");
ctx.drawImage(img, 0, 0);
const W = img.width;
const id = ctx.getImageData(0, 0, W, img.height);
const d = id.data;

const isWhite = (x: number, y: number) => {
	const i = (y * W + x) * 4;
	return d[i] > 248 && d[i + 1] > 248 && d[i + 2] > 248;
};

// cardsY = sectionY + INNER_PADDING(30) + titleH(70) + gap(8) = sectionY+108
const cardsY = sectionY + 108;
console.log(`图片 ${W}×${img.height}  sectionY=${sectionY}  cardsY=${cardsY}`);

// ---- 水平扫描：在第1行卡牌的中间高度，逐列统计该列在卡高范围内的白像素占比 ----
// 用探测法找第1行卡牌的实际 y 范围：从 cardsY 往下找连续非白区域
let yTop = cardsY;
// 卡高范围取 cardsY+20 .. cardsY+500
const bandTop = cardsY + 20;
const bandBot = cardsY + 500;
console.log(`水平扫描带 y=${bandTop}..${bandBot}`);

interface Run {
	isGap: boolean;
	startX: number;
	endX: number;
}
const runs: Run[] = [];
let cur: Run | null = null;
for (let x = 50; x < W - 50; x++) {
	// 该列在 band 内的白像素占比
	let white = 0;
	let total = 0;
	for (let y = bandTop; y < bandBot; y += 3) {
		if (isWhite(x, y)) white++;
		total++;
	}
	const frac = white / total;
	const isGap = frac >= 0.85; // 该列整列几乎全白 → 间隙列
	if (!cur || cur.isGap !== isGap) {
		if (cur) runs.push(cur);
		cur = { isGap, startX: x, endX: x };
	} else {
		cur.endX = x;
	}
}
if (cur) runs.push(cur);

console.log("\n水平方向 runs（CARD=卡牌列区间, GAP=间隙列区间）:");
let cardCount = 0;
let gapTotal = 0;
for (const r of runs) {
	const w = r.endX - r.startX + 1;
	if (r.isGap) {
		gapTotal += w;
		console.log(`  GAP  x[${r.startX}..${r.endX}] 宽=${w}px`);
	} else {
		cardCount++;
		console.log(`  CARD x[${r.startX}..${r.endX}] 宽=${w}px`);
	}
}
console.log(`→ 检测到 ${cardCount} 张卡（横向），间隙合计 ${gapTotal}px`);

// ---- 垂直扫描：在第1列卡牌的中间宽度，逐行统计白像素占比，测行间隙 ----
const colMid = 80 + 180; // 第1列卡牌中间附近
const vRuns: Run[] = [];
let vcur: Run | null = null;
for (let y = cardsY; y < cardsY + 1100; y++) {
	let white = 0;
	let total = 0;
	for (let x = colMid; x < colMid + 300; x += 3) {
		if (isWhite(x, y)) white++;
		total++;
	}
	const isGap = white / total >= 0.85;
	if (!vcur || vcur.isGap !== isGap) {
		if (vcur) vRuns.push(vcur);
		vcur = { isGap, startX: y, endX: y };
		// 用 startX/endX 存 y
	} else vcur.endX = y;
}
if (vcur) vRuns.push(vcur);
console.log("\n垂直方向 runs（在第1列卡牌 x 区间内，测行/行间隙）:");
for (const r of vRuns) {
	const h = r.endX - r.startX + 1;
	console.log(`  ${r.isGap ? "GAP " : "CARD"} y[${r.startX}..${r.endX}] 高=${h}px`);
}
