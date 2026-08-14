/**
 * 整张图缩略字符画：把渲染图降采样成 ASCII，看出全局结构（卡牌块、间隙分布）。
 * '#'=暗(卡面/标题条) '.'=亮(背景/间隙)。
 */
import { readFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const file = process.argv[2] ?? "output/deck-plan-4689495.jpg";
const step = Number(process.argv[3] ?? 40);
const img = await loadImage(readFileSync(file));
const c = createCanvas(img.width, img.height);
const ctx = c.getContext("2d");
ctx.drawImage(img, 0, 0);
const W = img.width;
const H = img.height;
const id = ctx.getImageData(0, 0, W, H);
const d = id.data;

function blockBright(x0: number, y0: number): number {
	let sum = 0;
	let n = 0;
	for (let y = y0; y < Math.min(H, y0 + step); y += Math.max(2, Math.floor(step / 4))) {
		for (let x = x0; x < Math.min(W, x0 + step); x += Math.max(2, Math.floor(step / 4))) {
			const i = (y * W + x) * 4;
			sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
			n++;
		}
	}
	return sum / n;
}

console.log(`图片 ${W}×${H}  步进${step}  ('#'=暗卡面/标题 '.'=亮背景/间隙)`);
console.log("x→", "0".padStart(3), ...Array.from({ length: Math.ceil(W / step) }, (_, k) => (k % 10 === 0 ? String(k).slice(-1) : " ")));
for (let y0 = 0; y0 < H; y0 += step) {
	let line = "";
	for (let x0 = 0; x0 < W; x0 += step) {
		line += blockBright(x0, y0) < 210 ? "#" : ".";
	}
	console.log(String(y0).padStart(4), line);
}
