import { readFileSync } from "node:fs";
import { createCanvas, Image, loadImage } from "@napi-rs/canvas";

const buf = readFileSync("/Users/xziying/project/arkham/card-database/card_images/01020_a.jpg");

// 旧方式：new Image + src（疑似异步，立即 drawImage 画不出）
const c1 = createCanvas(400, 560);
const x1 = c1.getContext("2d");
x1.fillStyle = "#ddd";
x1.fillRect(0, 0, 400, 560);
const im1 = new Image();
im1.src = buf;
x1.drawImage(im1, 0, 0, 400, 560);
const p1 = x1.getImageData(200, 280, 1, 1).data;

// 新方式：await loadImage（等解码完）
const c2 = createCanvas(400, 560);
const x2 = c2.getContext("2d");
x2.fillStyle = "#ddd";
x2.fillRect(0, 0, 400, 560);
const im2 = await loadImage(buf);
x2.drawImage(im2, 0, 0, 400, 560);
const p2 = x2.getImageData(200, 280, 1, 1).data;

console.log("旧(new Image+src) 中央像素:", `rgb(${p1[0]},${p1[1]},${p1[2]})`, `${im1.width}x${im1.height}`);
console.log("新(await loadImage) 中央像素:", `rgb(${p2[0]},${p2[1]},${p2[2]})`, `${im2.width}x${im2.height}`);
