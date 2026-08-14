/**
 * 卡组分享排班表（DeckLayout）类型契约。
 *
 * 这是整个引擎的核心数据结构：一份「排班表」完整描述一张卡组分享图怎么画。
 * 引擎只负责忠实渲染这份 spec；auto_layout 负责从卡组数据生成一份默认 spec；
 * 智能体拿到 spec 后可任意编辑（调块顺序、合并/拆分块、改列数、挪位置、加浮层）再重渲。
 *
 * 设计取舍：
 * - 位置用绝对坐标 [x, y]，单位 px。auto_layout 负责算好坐标，引擎不算「下一块放哪」，
 *   这样引擎保持「无状态、纯渲染」，spec 改完结果可预测。
 * - 块（section）内卡牌按 cols 自动换行——agent 只管卡牌顺序和列数，不用逐张算坐标。
 *   需要「每张卡独立坐标」时用 extras 里的 FreeImage。
 */

/** 坐标 [x, y]，px。 */
export type XY = readonly [number, number];
/** 尺寸 [width, height]，px。 */
export type Size = readonly [number, number];
/** 卡面：a=正面，b=反面，或自定义（如 "a-c"）。默认 a。 */
export type CardFace = string;

/** 卡牌引用：一张要贴进排班表的卡。 */
export interface CardRef {
	/** ArkhamDB 卡牌 code，如 "01006"。taboo 版可带 -t 后缀（resolver 会回退到原图）。 */
	code: string;
	/** 卡面，默认 "a"。 */
	face?: CardFace;
	/**
	 * 缺图时的占位标签（一般填卡名）。resolver 取不到图时画灰底 + label 居中；
	 * 不填则用 code。引擎不查卡牌库，名字靠这里透传。
	 */
	label?: string;
}

/** 文本元素。 */
export interface TextItem {
	kind: "text";
	text: string;
	pos: XY;
	/** 字号 px，默认 36。 */
	fontSize?: number;
	/** 颜色 hex，默认 #000000。 */
	color?: string;
	/** 注册过的字体 family 名，默认 theme.FONT_BODY。 */
	font?: string;
	/** 对齐方式相对 pos.x，默认 center。 */
	align?: "left" | "center" | "right";
	/** 文字基线相对 pos.y，默认 top（pos.y 是文字顶部）。 */
	baseline?: "top" | "middle" | "bottom";
}

/** 自由放置的图片元素（水印、logo、任意图）。 */
export interface FreeImage {
	kind: "image";
	/** 卡牌 code：走 CardImageResolver 取卡图。 */
	code?: string;
	face?: CardFace;
	/** 任意图片路径（宿主机绝对路径）：走 loadPath 取图。与 code 二选一。 */
	path?: string;
	pos: XY;
	/** 绘制尺寸；不填则按原图大小。 */
	size?: Size;
}

/** 顶部调查员区。 */
export interface HeaderBlock {
	/** 调查员卡（一般是横版大图）。 */
	investigator?: { code: string; face?: CardFace; pos: XY; size: Size };
	/** 调查员专属卡（签名卡），横排铺开。 */
	signature?: ReadonlyArray<{ code: string; face?: CardFace; pos: XY; size: Size }>;
	/** 卡组标题（如卡组名）。 */
	title?: TextItem;
	/** 宣传语 / 副标题（多行）。 */
	subtitle?: ReadonlyArray<TextItem>;
}

/**
 * 卡组分块——自由排班的核心单位。
 * 引擎按 cols 把 cards 自动换行铺进块内；块的标题色、位置、宽度、列数、卡牌顺序全可调。
 */
export interface DeckSection {
	/** 块标题，如 "永久支援卡"。渲染成 "—— 永久支援卡 N张 ——"（N=cards长度）。 */
	title: string;
	/** 块左上角坐标。 */
	pos: XY;
	/** 块宽 px。不填用 canvas.width - 左右边距。 */
	width?: number;
	/** 每行列数。不填按 width / cardSize[0] 自动算。 */
	cols?: number;
	/** 单卡槽尺寸 [w, h]，必填。 */
	cardSize: Size;
	/** 卡间距 px，默认 12。 */
	gap?: number;
	/** 标题栏高度 px，默认 70。 */
	titleHeight?: number;
	/** 标题色 hex，默认继承调查员阵营色（theme）。 */
	headerColor?: string;
	/** 背板样式：rounded=圆角白底带色边框 + 顶部色条标题（默认）；none=不画背板。 */
	background?: "rounded" | "none";
	/**
	 * 残行（不满 cols 的最后一行）对齐方式：
	 * - center 居中（默认，避免不满一行时右侧大片留白）
	 * - left 左对齐
	 * - justify 两端撑满（残行卡牌拉开间距填满整行宽度）
	 * 满行不受影响。
	 */
	align?: "left" | "center" | "justify";
	/** 卡牌列表——顺序即排班顺序（左→右、上→下）。多张同名卡重复出现。 */
	cards: ReadonlyArray<CardRef>;
}

/** 排班表根结构。 */
export interface DeckLayout {
	canvas: {
		/** 画布宽 px，必填。 */
		width: number;
		/**
		 * 画布高 px。不填时引擎按所有 section/header/extras 的最大 y 延伸自动计算
		 * （加一段底部 padding）。
		 */
		height?: number;
		/** 背景色 hex，默认 theme.DEFAULT_BG。 */
		background?: string;
	};
	/** 顶部调查员区，可省略。 */
	header?: HeaderBlock;
	/** 卡组分块。 */
	sections: ReadonlyArray<DeckSection>;
	/** 自由浮层（水印 / logo / 任意文本），画在 section 之上。 */
	extras?: ReadonlyArray<TextItem | FreeImage>;
}

/** 取卡图的能力：引擎不读文件，图片经此注入（解耦 I/O，便于单测 mock）。 */
export interface CardImageResolver {
	resolve(card: { code: string; face?: CardFace }): Promise<Buffer | Uint8Array | null>;
}

/** 取任意路径图片的能力（FreeImage.path 用）。不提供则 path 类浮层被忽略。 */
export type PathImageLoader = (path: string) => Promise<Buffer | Uint8Array | null>;
