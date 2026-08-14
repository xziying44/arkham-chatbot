/**
 * 默认主题：复刻旧 create_deck.py 的视觉风格（阵营色边框、蓝白底、宣传语）。
 *
 * 字体用 ASCII family 别名注册（见 fonts.ts），避免 @napi-rs/canvas 对非 ASCII
 * family 名匹配不稳的问题。逻辑名 → 别名的映射集中在这里。
 */

/** ArkhamDB 阵营 code → 边框/标题色 hex（移植旧 border_color RGB）。 */
export const FACTION_COLORS: Readonly<Record<string, string>> = {
	guardian: "#0076c8", // (0,118,200)
	seeker: "#eb7600", // (235,118,0)
	rogue: "#00a028", // (0,160,40)
	survivor: "#de1631", // (222,18,49)
	mystic: "#7d53b0", // (125,83,176)
	neutral: "#515f66", // (81,95,102)
};

/** 未知阵营的兜底色（中性灰）。 */
export const DEFAULT_BORDER_COLOR = "#515f66";

/** 默认画布背景色（旧 (246,250,255)）。 */
export const DEFAULT_BG = "#f6faff";

/** 默认画布宽（旧 width=2820）。 */
export const DEFAULT_WIDTH = 2820;

/** 占位卡底色（缺图时灰底，旧 (43,45,48)）。 */
export const PLACEHOLDER_BG = "#2b2d30";
export const PLACEHOLDER_FG = "#ffffff";

/** 圆角背板：白底 + 阵营色边框。 */
export const SECTION_FILL = "#ffffff";
export const SECTION_RADIUS = 12;
export const SECTION_BORDER_WIDTH = 5;

/**
 * 字体 family 别名（fonts.ts 按这些名注册）。
 * - FONT_TITLE：标题/宣传语（汉仪小隶书简）
 * - FONT_BODY：正文（思源黑体）
 */
export const FONT_TITLE = "HanyiLiShu";
export const FONT_BODY = "SourceHanSans";

/** 逻辑字体名 → 别名。TextItem.font 既可以传别名也可以传逻辑名。 */
export const FONT_ALIAS: Readonly<Record<string, string>> = {
	汉仪小隶书简: FONT_TITLE,
	"汉仪小隶": FONT_TITLE,
	思源黑体: FONT_BODY,
	"思源黑": FONT_BODY,
};

/** 旧版右上角宣传语。 */
export const DEFAULT_PROMO: ReadonlyArray<string> = ["群机器人中搜索", "阿卡姆DIY姬", "分享你的卡组"];

/** 把阵营 code 解析成颜色 hex，未知 → 中性灰。 */
export function factionColor(faction?: string): string {
	if (!faction) return DEFAULT_BORDER_COLOR;
	return FACTION_COLORS[faction] ?? DEFAULT_BORDER_COLOR;
}

/** 把任意字体名解析成已注册的别名（命中逻辑名映射 / 直接是别名 / 兜底正文）。 */
export function resolveFont(font?: string): string {
	if (!font) return FONT_BODY;
	return FONT_ALIAS[font] ?? font;
}
