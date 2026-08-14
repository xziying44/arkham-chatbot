/**
 * 字体注册：把 arkham-homebrew/fonts 下的中文字体按 ASCII family 别名注册进 @napi-rs/canvas。
 *
 * 必须在 renderDeck 之前调用一次（GlobalFonts 是进程级全局状态）。
 * 找不到字体文件不报错——对应 family 渲染时会 fallback 到默认字体，出图不中断。
 */
import { GlobalFonts } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FONT_BODY, FONT_TITLE } from "./theme.ts";

/** 字体文件 → 注册别名。 */
const FONT_FILES: ReadonlyArray<{ file: string; family: string }> = [
	{ file: "source-han-sans.ttf", family: FONT_BODY }, // 思源黑体
	{ file: "hanyi-small-clerical-simple.ttf", family: FONT_TITLE }, // 汉仪小隶书简
	// 副本/备用名（部分环境文件名不同）
	{ file: "SourceHanSansSC-Regular.otf", family: FONT_BODY },
];

let registered = false;

/**
 * 注册字体。
 * @param fontsDir 字体目录（如 .../arkham-homebrew/fonts）
 * @returns 实际注册成功的 family 列表
 */
export function registerFonts(fontsDir: string): string[] {
	const ok: string[] = [];
	for (const { file, family } of FONT_FILES) {
		const p = join(fontsDir, file);
		if (!existsSync(p)) continue;
		// 同一 family 只注册一次（后面的文件是备用来源）
		try {
			GlobalFonts.registerFromPath(p, family);
			if (!ok.includes(family)) ok.push(family);
		} catch {
			// 注册失败忽略，渲染时 fallback
		}
	}
	registered = true;
	return ok;
}

/** 是否已注册过（仅供测试/诊断）。 */
export function isFontsRegistered(): boolean {
	return registered;
}
