/**
 * 静态图名校验：渲染前检查 DeckPlan 里每个卡 code 在卡图目录是否有对应图片，
 * 缺图的返回结构化警告 + 候选 ID，让智能体知道"这几张没渲染出来 / 可能 ID 写错了"。
 *
 * 常见 ID 错误：code 带了多余后缀（如 "11068a"，实际图是 "11068_a.jpg"）；
 * 或粉丝/扩展卡本地未收录（60xxx/11xxx）；或随机弱点占位（01000）本就无图。
 */
import { readdir } from "node:fs/promises";
import type { DeckPlan } from "./plan.ts";

/** 一张缺图的卡（按 code 去重，slots 列出它出现在哪些槽位）。 */
export interface MissingCard {
	code: string;
	label?: string;
	/** 出现在哪些槽位。 */
	slots: string[];
	/** 卡图目录里与该 code 相关的候选文件名，供 agent 判断正确 ID。 */
	candidates: string[];
	/** 建议改用的 code（如去掉尾字母后能命中图片）。 */
	suggestedCode?: string;
	/** 缺图原因分类。 */
	reason: "no_image" | "wrong_id";
}

export interface ValidationReport {
	/** 去重后校验的 code 总数。 */
	checked: number;
	/** 命中图片的 code 数。 */
	found: number;
	/** 缺图的卡（按 code 去重）。 */
	missing: MissingCard[];
	/** 调查员是否缺图。 */
	investigator?: MissingCard;
	/** 全部卡都能渲染（无缺图）。 */
	ok: boolean;
}

/** 复刻 card-image-resolver 的命中逻辑：{code}_a.jpg，-t 后缀回退。 */
function hasImage(code: string, files: Set<string>): boolean {
	if (files.has(`${code}_a.jpg`)) return true;
	if (code.endsWith("-t") && files.has(`${code.slice(0, -2)}_a.jpg`)) return true;
	return false;
}

/** code 的前导数字部分（"11068a" → "11068"）。 */
function leadingDigits(code: string): string {
	return code.match(/^\d+/)?.[0] ?? code;
}

/** 找目录里与前导数字相关的候选文件（去掉它自己那个不存在的）。 */
function candidatesFor(code: string, files: string[]): string[] {
	const prefix = leadingDigits(code);
	return files.filter((f) => f.startsWith(prefix) && f !== `${code}_a.jpg`).slice(0, 8);
}

/**
 * 校验一份 DeckPlan 的所有卡 code 是否有图。
 */
export async function validateDeckPlan(plan: DeckPlan, cardImagesDir: string): Promise<ValidationReport> {
	const all = await readdir(cardImagesDir);
	const set = new Set(all);
	const missingMap = new Map<string, MissingCard>();
	const checked = new Set<string>();
	let found = 0;

	const checkOne = (code: string, label: string | undefined, slot: string): void => {
		if (checked.has(code)) {
			missingMap.get(code)?.slots.push(slot);
			return;
		}
		checked.add(code);
		if (hasImage(code, set)) {
			found++;
			return;
		}
		const digits = leadingDigits(code);
		const suggested = digits !== code && hasImage(digits, set) ? digits : undefined;
		missingMap.set(code, {
			code,
			label,
			slots: [slot],
			candidates: candidatesFor(code, all),
			suggestedCode: suggested,
			reason: suggested || candidatesFor(code, all).length ? "wrong_id" : "no_image",
		});
	};

	for (const slot of plan.slots) {
		for (const card of slot.cards) checkOne(card.code, card.label, slot.name);
	}

	let investigator: MissingCard | undefined;
	if (plan.investigator && !hasImage(plan.investigator, set)) {
		investigator = {
			code: plan.investigator,
			slots: ["调查员"],
			candidates: candidatesFor(plan.investigator, all),
			reason: "no_image",
		};
	}

	const missing = [...missingMap.values()];
	return { checked: checked.size, found, missing, investigator, ok: missing.length === 0 && !investigator };
}

/** 把校验结果格式化成文字，供智能体阅读。 */
export function formatValidation(report: ValidationReport): string {
	const lines: string[] = [];
	lines.push(`图名校验：${report.found}/${report.checked} 个卡 code 有图${report.ok ? " ✓" : ""}`);
	if (report.investigator) {
		lines.push(`⚠ 调查员 ${report.investigator.code} 无图（候选: ${report.investigator.candidates.join(", ") || "无"}）`);
	}
	if (report.missing.length === 0 && !report.investigator) {
		lines.push("✓ 全部卡牌都有图，可正常渲染");
		return lines.join("\n");
	}
	if (report.missing.length > 0) {
		lines.push(`⚠ ${report.missing.length} 种卡缺图（agent 可改 ID 或替换卡）：`);
		for (const m of report.missing) {
			let line = `  · ${m.label ?? ""}(${m.code}) @ [${m.slots.join(", ")}]`;
			if (m.suggestedCode) line += `  → 建议改用 "${m.suggestedCode}"（目录有 ${m.suggestedCode}_a.jpg）`;
			else if (m.candidates.length) line += `  → 目录近似文件: ${m.candidates.join(", ")}`;
			else line += `  → 无近似文件（未收录的粉丝/扩展卡，或随机弱点 01000 这类本就无图）`;
			lines.push(line);
		}
	}
	return lines.join("\n");
}
