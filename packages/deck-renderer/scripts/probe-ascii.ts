/**
 * ASCII 探针：把渲染图的指定行/列渲染成字符画，直观看出卡牌与间隙结构。
 * '#' = 暗（卡面），'.' = 亮（背景/间隙）。
 */
import { readFileSync } from "node:fs";
import { createCanvas, Image } from "@napi-rs/canvas";

const file = process.argv[2] ?? "output/deck-plan-4689495.jpg";
const img = new Image();
img.src = readFileSync(file);
const c = createCanvas(img.width, img.height);
const ctx = c.getContext("2d");
ctx.drawImage(img, 0, 0);
const W = img.width;
const id = ctx.getImageData(0, 0, W, img.height);
const d = id.data;
const bright = (x: number, y: number) => {
	const i = (y * W + x) * 4;
	return (d[i] + d[i + 1] + d[i + 2]) / 3;
};

function asciiH(y: number, label: string, x0 = 40, x1 = W - 40, step = 8) {
	let line = "";
	let lastState: boolean | null = null;
	const marks: string[] = [];
	for (let x = x0; x < x1; x += step) {
		const b = bright(x, y);
		const dark = b < 220; // 卡面通常较暗
		line += dark ? "#" : ".";
	}
	// 标注暗/亮 run 长度
	console.log(`\n[水平 y=${y}] ${label}  (步进${step}px, '#'=卡面 '.'=亮隙)`);
	console.log(line);
	// 统计 run
	const runs: { ch: string; n: number }[] = [];
	for (const ch of line) {
		if (runs.length && runs[runs.length - 1].ch === ch) runs[runs.length - 1].n++;
		else runs.push({ ch, n: 1 });
	}
	console.log("  runs(字符数×步进=px):", runs.map((r) => `${r.ch}${r.n * step}`).join(" "));
	void lastState;
}

function asciiV(x: number, label: string, y0: number, y1: number, step = 8) {
	let line = "";
	for (let y = y0; y < y1; y += step) {
		const b = bright(x, y);
		line += b < 220 ? "#" : ".";
	}
	console.log(`\n[垂直 x=${x}] ${label}  y${y0}..${y1} (步进${step}px)`);
	console.log(line);
}

// 支援卡: sectionY=1360, cardsY=1468, cardH=522, gap=8
// row1: y 1468..1990, middle ≈ 1730
// row2: y 1998..2520, middle ≈ 2260
console.log(`图片 ${W}×${img.height}`);
asciiH(1730, "支援卡 第1行 中间");
asciiH(2260, "支援卡 第2行 中间");
asciiV(260, "支援卡 第1列（测行间隙）", 1450, 2550);
