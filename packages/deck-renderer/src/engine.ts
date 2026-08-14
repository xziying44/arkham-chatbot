/**
 * 布局引擎（Layer 1）：把 DeckLayout 排班表忠实渲染成 PNG。
 *
 * 设计原则：
 * - 纯渲染：不读文件、不查卡牌库。卡图经 CardImageResolver 注入，缺图走占位。
 * - 无状态：位置全用 spec 里的绝对坐标；引擎只算「块内换行」这种局部几何。
 * - 可预测：spec 改完，出图按字面变化，没有隐式排版副作用。
 *
 * 性能：卡图解码是瓶颈 → 按 code|face 缓存解码后的 Image（LRU，跨渲染可复用）。
 */
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import type {
	CardImageResolver,
	CardRef,
	DeckLayout,
	DeckSection,
	FreeImage,
	PathImageLoader,
	TextItem,
} from "./types.ts";
import {
	DEFAULT_BG,
	FONT_BODY,
	SECTION_BORDER_WIDTH,
	SECTION_FILL,
	SECTION_RADIUS,
	resolveFont,
} from "./theme.ts";

// ---- 几何默认值 ----
const DEFAULT_TITLE_HEIGHT = 70;
const DEFAULT_GAP = 12;
/** section 左右边距（section.width 缺省时用它算块宽）。 */
const DEFAULT_MARGIN = 50;
/** section 内卡牌区相对块边的内边距。 */
export const INNER_PADDING = 30;
/** 自动算画布高时的底部留白。 */
const BOTTOM_PADDING = 50;

// ---- 图片缓存 ----
/** 解码后 Image 的 LRU 缓存接口（压测时可跨 renderDeck 复用以热缓存）。 */
export interface ImageCache {
	get(key: string): Image | null | undefined;
	set(key: string, value: Image | null): void;
	readonly size: number;
}

class LRUImageCache implements ImageCache {
	private readonly map = new Map<string, Image | null>();
	constructor(private readonly max: number) {}
	get(key: string): Image | null | undefined {
		const v = this.map.get(key);
		if (v !== undefined) {
			this.map.delete(key);
			this.map.set(key, v);
		}
		return v;
	}
	set(key: string, value: Image | null): void {
		if (this.map.has(key)) this.map.delete(key);
		else if (this.map.size >= this.max) {
			const first = this.map.keys().next().value;
			if (first !== undefined) this.map.delete(first);
		}
		this.map.set(key, value);
	}
	get size(): number {
		return this.map.size;
	}
}

/** 新建一个图片缓存。 @param max 上限条目数，默认 60。 */
export function createImageCache(max = 60): ImageCache {
	return new LRUImageCache(max);
}

export interface RenderOptions {
	resolver: CardImageResolver;
	/** FreeImage.path 类浮层的取图实现；不提供则 path 浮层被忽略。 */
	loadPath?: PathImageLoader;
	/** 跨渲染共享的图片缓存；不传则每次 renderDeck 新建一个。 */
	imageCache?: ImageCache;
	/**
	 * 输出格式。默认 'jpeg'——卡组分享图内容是卡牌照片+文字，jpeg 在 0.9 质量下视觉无损，
	 * 且编码比 png 快约 9 倍（2820 宽大图：jpeg ~30ms vs png ~290ms）、文件小一个数量级。
	 * 需要无损时用 'png'。旧 create_deck.py 同样存 jpeg。
	 */
	format?: "png" | "jpeg";
	/** jpeg 质量 0-1，默认 0.9。仅 format='jpeg' 时生效。 */
	quality?: number;
}

/** section 的算好的几何参数。 */
interface SectionGeometry {
	x: number;
	y: number;
	w: number;
	cols: number;
	rows: number;
	height: number;
	titleH: number;
	gap: number;
}

/** 一个 section 的渲染高度（供 auto-layout 纵向堆叠算坐标）。 */
export function sectionHeight(s: DeckSection, canvasWidth: number): number {
	return sectionGeometry(s, canvasWidth).height;
}

/** 算一个 section 的几何（不画）。 */
function sectionGeometry(s: DeckSection, canvasWidth: number): SectionGeometry {
	const x = s.pos[0];
	const y = s.pos[1];
	const w = s.width ?? canvasWidth - DEFAULT_MARGIN * 2;
	const gap = s.gap ?? DEFAULT_GAP;
	const titleH = s.titleHeight ?? DEFAULT_TITLE_HEIGHT;
	const cardW = s.cardSize[0];
	const cardH = s.cardSize[1];
	const usable = Math.max(0, w - INNER_PADDING * 2);
	const cols = Math.max(
		1,
		s.cols ?? Math.max(1, Math.floor(usable / (cardW + gap))),
	);
	const rows = s.cards.length === 0 ? 0 : Math.ceil(s.cards.length / cols);
	// 顶部内边距 + 标题栏 + gap + 卡牌行 + 底部内边距
	const cardBlock = rows > 0 ? gap + rows * (cardH + gap) : 0;
	const height = INNER_PADDING + titleH + cardBlock + INNER_PADDING;
	return { x, y, w, cols, rows, height, titleH, gap };
}

/** 画布高度自动计算：取所有 section/header/extras 的最大 y 延伸 + 底部留白。 */
export function computeHeight(layout: DeckLayout): number {
	let maxBottom = 0;
	for (const s of layout.sections) {
		const g = sectionGeometry(s, layout.canvas.width);
		maxBottom = Math.max(maxBottom, g.y + g.height);
	}
	const h = layout.header;
	if (h) {
		if (h.investigator) maxBottom = Math.max(maxBottom, h.investigator.pos[1] + h.investigator.size[1]);
		for (const c of h.signature ?? []) maxBottom = Math.max(maxBottom, c.pos[1] + c.size[1]);
		for (const t of [...(h.title ? [h.title] : []), ...(h.subtitle ?? [])]) {
			maxBottom = Math.max(maxBottom, t.pos[1] + (t.fontSize ?? 36) + 8);
		}
	}
	for (const e of layout.extras ?? []) {
		if (e.kind === "image" && e.size) maxBottom = Math.max(maxBottom, e.pos[1] + e.size[1]);
		else if (e.kind === "text") maxBottom = Math.max(maxBottom, e.pos[1] + (e.fontSize ?? 36) + 8);
	}
	return Math.ceil(maxBottom + BOTTOM_PADDING);
}

/** 解码 buffer → Image。必须异步等解码完成（loadImage），不能用 new Image()+.src=buf：
 *  @napi-rs/canvas 的 .src=buffer 是异步解码，立即 drawImage 会画不出任何东西。 */
async function decodeImage(buf: Buffer | Uint8Array): Promise<Image> {
	return loadImage(buf as Buffer);
}

/** 取卡图（带缓存）。resolver 返回 null 时缓存 null 避免重复试探。 */
async function getImage(
	card: { code: string; face?: string },
	resolver: CardImageResolver,
	cache: ImageCache,
): Promise<Image | null> {
	const key = `${card.code}|${card.face ?? "a"}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	let img: Image | null = null;
	try {
		const buf = await resolver.resolve(card);
		if (buf && (buf as Uint8Array).byteLength > 0) img = await decodeImage(buf);
	} catch {
		img = null;
	}
	cache.set(key, img);
	return img;
}

/** cover-fit：等比放大填满目标框，居中裁剪（等同旧 PIL paste 'cover'）。 */
function coverFitDraw(
	ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
	img: Image,
	dx: number,
	dy: number,
	dw: number,
	dh: number,
): void {
	const sw = img.width;
	const sh = img.height;
	if (sw === 0 || sh === 0) return;
	const scale = Math.max(dw / sw, dh / sh);
	const sW = dw / scale;
	const sH = dh / scale;
	const sx = (sw - sW) / 2;
	const sy = (sh - sH) / 2;
	ctx.drawImage(img, sx, sy, sW, sH, dx, dy, dw, dh);
}

/** 居中换行绘制文本（按字符断行，中文友好；用于缺图卡名）。 */
function drawWrappedCenter(
	ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
	text: string,
	cx: number,
	cy: number,
	maxW: number,
	font: string,
	lineHeight: number,
): void {
	ctx.font = font;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	const lines: string[] = [];
	let line = "";
	for (const ch of text) {
		const test = line + ch;
		if (ctx.measureText(test).width > maxW && line) {
			lines.push(line);
			line = ch;
		} else {
			line = test;
		}
	}
	if (line) lines.push(line);
	const totalH = lines.length * lineHeight;
	let y = cy - totalH / 2 + lineHeight / 2;
	for (const ln of lines) {
		ctx.fillText(ln, cx, y);
		y += lineHeight;
	}
}

/** 画一张卡：有图 cover-fit，无图走可读文字卡占位。 */
async function drawCard(
	ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
	card: CardRef,
	cx: number,
	cy: number,
	cw: number,
	ch: number,
	resolver: CardImageResolver,
	cache: ImageCache,
): Promise<void> {
	const img = await getImage(card, resolver, cache);
	if (img) {
		coverFitDraw(ctx, img, cx, cy, cw, ch);
		return;
	}
	// 缺图：浅灰文字卡（卡名换行居中 + 底部 code），可读且不突兀
	ctx.fillStyle = "#d9dde3";
	ctx.fillRect(cx, cy, cw, ch);
	ctx.strokeStyle = "#b8bdc6";
	ctx.lineWidth = 2;
	ctx.strokeRect(cx + 4, cy + 4, cw - 8, ch - 8);
	ctx.fillStyle = "#2b2d30";
	const name = card.label ?? card.code;
	const nameSize = Math.max(18, Math.floor(cw / 9));
	drawWrappedCenter(ctx, name, cx + cw / 2, cy + ch / 2 - 4, cw - 24, `${nameSize}px ${FONT_BODY}`, Math.floor(nameSize * 1.25));
	// 底部 code 小字（便于定位/排查）
	ctx.fillStyle = "#8a8f99";
	ctx.font = `${Math.max(11, Math.floor(cw / 24))}px ${FONT_BODY}`;
	ctx.textAlign = "center";
	ctx.textBaseline = "bottom";
	ctx.fillText(card.code, cx + cw / 2, cy + ch - 8);
}

/** 画圆角分块背板 + 顶部色条标题（移植旧 draw_rounded_card）。 */
function drawRoundedSection(
	ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
	g: SectionGeometry,
	title: string,
	headerColor: string,
	font: string,
): void {
	const { x, y, w, height: h, titleH } = g;
	// 1. 白底圆角 + 裁剪（让顶部色条服从圆角）
	ctx.save();
	ctx.beginPath();
	ctx.roundRect(x, y, w, h, SECTION_RADIUS);
	ctx.closePath();
	ctx.clip();
	// 白底
	ctx.fillStyle = SECTION_FILL;
	ctx.fillRect(x, y, w, h);
	// 顶部色条
	ctx.fillStyle = headerColor;
	ctx.fillRect(x, y, w, titleH);
	ctx.restore();
	// 2. 边框
	ctx.strokeStyle = headerColor;
	ctx.lineWidth = SECTION_BORDER_WIDTH;
	ctx.beginPath();
	ctx.roundRect(x, y, w, h, SECTION_RADIUS);
	ctx.stroke();
	// 3. 标题（色条内居中）
	ctx.fillStyle = "#ffffff";
	const titleSize = Math.max(20, Math.floor(titleH * 0.46));
	ctx.font = `${titleSize}px ${font}`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(title, x + w / 2, y + titleH / 2);
}

/** 画一个 section（背板 + 卡牌网格）。 */
async function drawSection(
	ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
	s: DeckSection,
	canvasWidth: number,
	defaultHeaderColor: string,
	resolver: CardImageResolver,
	cache: ImageCache,
): Promise<void> {
	const g = sectionGeometry(s, canvasWidth);
	const headerColor = s.headerColor ?? defaultHeaderColor;
	const font = FONT_BODY;
	if (s.background !== "none") {
		const titleText = `${s.title} ${s.cards.length}张`.trim();
		drawRoundedSection(ctx, g, titleText, headerColor, font);
	} else if (s.title) {
		// 无背板：只画标题文字
		ctx.fillStyle = headerColor;
		const ts = Math.max(20, Math.floor(g.titleH * 0.5));
		ctx.font = `${ts}px ${font}`;
		ctx.textAlign = "left";
		ctx.textBaseline = "top";
		ctx.fillText(`${s.title} ${s.cards.length}张`.trim(), g.x + INNER_PADDING, g.y + 4);
	}
	// 卡牌网格（按行绘制；残行按 align 对齐，默认居中，避免不满一行时右侧大片留白）
	const cardW = s.cardSize[0];
	const cardH = s.cardSize[1];
	const gap = g.gap;
	const innerX = g.x + INNER_PADDING;
	const cardsY = g.y + INNER_PADDING + g.titleH + gap;
	const usable = Math.max(0, g.w - INNER_PADDING * 2);
	const align = s.align ?? "left";
	for (let start = 0; start < s.cards.length; start += g.cols) {
		const count = Math.min(g.cols, s.cards.length - start);
		const r = Math.floor(start / g.cols);
		const cy = cardsY + r * (cardH + gap);
		const isFull = count >= g.cols;
		let cxStart: number;
		let step: number;
		if (isFull || align === "left") {
			cxStart = innerX;
			step = cardW + gap;
		} else if (align === "justify" && count > 1) {
			// 残行两端撑满：拉开间距填满整行
			cxStart = innerX;
			step = (usable - cardW) / (count - 1);
		} else {
			// center：残行居中
			const rowW = count * cardW + (count - 1) * gap;
			cxStart = innerX + (usable - rowW) / 2;
			step = cardW + gap;
		}
		for (let c = 0; c < count; c++) {
			const cx = cxStart + c * step;
			await drawCard(ctx, s.cards[start + c], cx, cy, cardW, cardH, resolver, cache);
		}
	}
}

/** 画文本元素。 */
function drawTextItem(
	ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
	item: TextItem,
): void {
	const font = resolveFont(item.font);
	const size = item.fontSize ?? 36;
	ctx.fillStyle = item.color ?? "#000000";
	ctx.font = `${size}px ${font}`;
	ctx.textAlign = item.align ?? "center";
	ctx.textBaseline = item.baseline ?? "top";
	ctx.fillText(item.text, item.pos[0], item.pos[1]);
}

/** 画自由图片元素。 */
async function drawFreeImage(
	ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
	item: FreeImage,
	resolver: CardImageResolver,
	cache: ImageCache,
	loadPath?: PathImageLoader,
): Promise<void> {
	let buf: Buffer | Uint8Array | null = null;
	if (item.code) {
		const img = await getImage({ code: item.code, face: item.face }, resolver, cache);
		if (img) {
			if (item.size) coverFitDraw(ctx, img, item.pos[0], item.pos[1], item.size[0], item.size[1]);
			else ctx.drawImage(img, item.pos[0], item.pos[1]);
		}
		return;
	}
	if (item.path && loadPath) {
		try {
			buf = await loadPath(item.path);
		} catch {
			buf = null;
		}
	}
	if (!buf || buf.byteLength === 0) return;
	const img = await decodeImage(buf);
	if (item.size) coverFitDraw(ctx, img, item.pos[0], item.pos[1], item.size[0], item.size[1]);
	else ctx.drawImage(img, item.pos[0], item.pos[1]);
}

/**
 * 渲染排班表 → PNG Buffer。
 *
 * @param layout 排班表
 * @param opts   resolver 必填；loadPath/imageCache 可选
 * @returns PNG Buffer
 */
export async function renderDeck(layout: DeckLayout, opts: RenderOptions): Promise<Buffer> {
	const cache = opts.imageCache ?? createImageCache();
	const width = layout.canvas.width;
	const height = layout.canvas.height ?? computeHeight(layout);
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");

	// 背景
	ctx.fillStyle = layout.canvas.background ?? DEFAULT_BG;
	ctx.fillRect(0, 0, width, height);

	// 默认标题色：取 header.investigator 的阵营色由调用方在 spec 里给；
	// spec 没给 section.headerColor 时用一个中性兜底（auto_layout 会注入阵营色）。
	const defaultHeaderColor = "#515f66";

	// sections（先画，浮层在其上）
	for (const s of layout.sections) {
		await drawSection(ctx, s, width, defaultHeaderColor, opts.resolver, cache);
	}

	// header
	const h = layout.header;
	if (h) {
		if (h.investigator) {
			const img = await getImage({ code: h.investigator.code, face: h.investigator.face }, opts.resolver, cache);
			if (img) coverFitDraw(ctx, img, h.investigator.pos[0], h.investigator.pos[1], h.investigator.size[0], h.investigator.size[1]);
		}
		for (const c of h.signature ?? []) {
			const img = await getImage({ code: c.code, face: c.face }, opts.resolver, cache);
			if (img) coverFitDraw(ctx, img, c.pos[0], c.pos[1], c.size[0], c.size[1]);
		}
		if (h.title) drawTextItem(ctx, h.title);
		for (const t of h.subtitle ?? []) drawTextItem(ctx, t);
	}

	// extras 浮层
	for (const e of layout.extras ?? []) {
		if (e.kind === "text") drawTextItem(ctx, e);
		else await drawFreeImage(ctx, e, opts.resolver, cache, opts.loadPath);
	}

	const format = opts.format ?? "jpeg";
	if (format === "png") return canvas.toBuffer("image/png");
	return canvas.toBuffer("image/jpeg", opts.quality ?? 0.9);
}
