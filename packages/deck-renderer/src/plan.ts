/**
 * 槽位排班模型（agent 主要交互层）。
 *
 * 设计（按需求）：
 * - 智能体只管「逻辑排版」：把卡分进若干【槽位】、给槽位命名、决定槽位内卡牌顺序、增减槽位。
 * - 程序管「几何排版」：卡牌紧凑、左对齐、顶部对齐地铺排；槽位纵向堆叠（每个占满画布宽）。
 * - 画布宽固定（手机端调好，可改）。
 * - 渲染后返回每张卡的位置，让智能体通过文字感知布局。
 *
 * 分层：DeckPlan(槽位) ──planDeck──▶ DeckLayout(带坐标) + CardPosition[] ──renderDeck──▶ 图片
 *       describePositions(PlanResult) ──▶ 位置文字报告
 */
import type { CardRef, DeckLayout, DeckSection, Size } from "./types.ts";
import { sectionHeight, INNER_PADDING } from "./engine.ts";
import {
	DEFAULT_BG,
	DEFAULT_PROMO,
	DEFAULT_WIDTH,
	FONT_TITLE,
	factionColor,
} from "./theme.ts";

/** 一个槽位：agent 命名的卡牌分组。cards 顺序 = 排列顺序。 */
export interface PlanSlot {
	/** 槽位名（agent 命名，如「核心过牌」「输出」）。渲染成块标题。 */
	name: string;
	/** 卡牌列表，顺序即从左到右、从上到下的排列顺序。 */
	cards: CardRef[];
	/** 该槽位列数（覆盖全局）；不填用全局 columns。 */
	columns?: number;
}

/** agent 排班输入：只含逻辑结构，不含任何坐标。 */
export interface DeckPlan {
	/** 画布宽 px（手机端调好的固定值，可改）。默认 DEFAULT_WIDTH。 */
	width?: number;
	/** 卡组标题。 */
	title?: string;
	/** 调查员 code（画在顶部）。 */
	investigator?: string;
	/** 调查员专属卡 code 列表（顶部横排）。 */
	signature?: readonly string[];
	/** 阵营 code（决定边框/标题色）；不传用中性色。 */
	faction?: string;
	/** 右上宣传语；不传用默认，传 [] 关闭。 */
	promo?: readonly string[];
	/** 全局每行列数，默认 7。 */
	columns?: number;
	/** 卡牌高度 px；不传按宽度/竖版比例自动算。 */
	cardHeight?: number;
	/** 卡牌间隙 px，默认 8。 */
	gap?: number;
	/** 槽位列表，顺序 = 从上到下。 */
	slots: PlanSlot[];
}

/** 一张卡在画布上的最终位置（planDeck 回传给 agent）。 */
export interface CardPosition {
	/** 所在槽位名。 */
	slot: string;
	/** 卡 code。 */
	code: string;
	/** 卡名（透传 label）。 */
	label?: string;
	/** 第几行（0 起）。 */
	row: number;
	/** 第几列（0 起）。 */
	col: number;
	/** 像素坐标与尺寸。 */
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface PlanResult {
	/** 编译出的带坐标布局（交给 renderDeck）。 */
	layout: DeckLayout;
	/** 每张槽位内卡牌的位置（不含调查员/专属卡）。 */
	positions: CardPosition[];
	width: number;
	height: number;
	/** 槽位摘要：name → {y, rows, cols, count}。 */
	slots: ReadonlyArray<{ name: string; y: number; rows: number; cols: number; count: number }>;
}

/** 排版默认参数。 */
export const DEFAULT_PLAN = {
	marginX: 50,
	columns: 7,
	gap: 8,
	titleHeight: 70,
	sectionGap: 30,
	headerTop: 110,
	titleY: 35,
	/** 竖版卡 高/宽 比（625×875 → 1.4）。 */
	cardRatio: 1.4,
};

/**
 * 把 DeckPlan 编译成带坐标的 DeckLayout，并回传每张卡的位置。
 *
 * 几何规则：槽位纵向堆叠，每个占满画布宽；槽位内卡牌宽度 = (行宽-间隙)/列数 精确填满，
 * 左对齐、顶部对齐，按列数换行；残行左对齐留白。
 */
export function planDeck(plan: DeckPlan): PlanResult {
	const width = plan.width ?? DEFAULT_WIDTH;
	const p = DEFAULT_PLAN;
	const sectionWidth = width - p.marginX * 2;
	const baseCols = plan.columns ?? p.columns;
	const gap = plan.gap ?? p.gap;
	const titleH = p.titleHeight;
	const usable = Math.max(0, sectionWidth - INNER_PADDING * 2);
	const cardW = Math.floor((usable - (baseCols - 1) * gap) / baseCols);
	const cardH = plan.cardHeight ?? Math.round(cardW * p.cardRatio);
	const borderColor = plan.faction ? factionColor(plan.faction) : "#515f66";

	const positions: CardPosition[] = [];
	const slotSummary: PlanResult["slots"][number][] = [];
	const sections: DeckSection[] = [];

	// ---- 顶部调查员区 ----
	const headerTop = p.headerTop;
	let headerBottom = headerTop;
	const header: DeckLayout["header"] = {};

	if (plan.investigator) {
		// 调查员卡（横版）：高度对齐签名卡，宽度按 1.4 比例
		const invH = Math.round(cardH * 0.66);
		const invW = Math.round(invH * 1.4);
		header.investigator = {
			code: plan.investigator,
			pos: [p.marginX + 20, headerTop],
			size: [invW, invH],
		};
		headerBottom = Math.max(headerBottom, headerTop + invH);
		// 专属卡横排
		const sigs = plan.signature ?? [];
		if (sigs.length > 0) {
			const startX = p.marginX + 20 + invW + 30;
			header.signature = sigs.map((code, i) => ({
				code,
				pos: [startX + i * (cardW + gap), headerTop],
				size: [cardW, cardH],
			}));
			headerBottom = Math.max(headerBottom, headerTop + cardH);
		}
	}

	// 标题（居中顶部）
	if (plan.title) {
		header.title = {
			kind: "text",
			text: plan.title,
			pos: [width / 2, p.titleY],
			fontSize: 52,
			color: borderColor,
			font: FONT_TITLE,
			align: "center",
			baseline: "top",
		};
	}
	// 宣传语
	const promo = plan.promo === undefined ? DEFAULT_PROMO : plan.promo;
	if (promo.length > 0) {
		header.subtitle = promo.map((line, i) => ({
			kind: "text",
			text: line,
			pos: [width - 40, p.titleY + i * 50],
			fontSize: 36,
			color: "#000000",
			font: FONT_TITLE,
			align: "right",
			baseline: "top",
		}));
	}

	const hasHeader = !!plan.investigator || !!plan.title || promo.length > 0;
	let cursorY = (hasHeader ? headerBottom : p.titleY + 60) + p.sectionGap;

	// ---- 槽位纵向堆叠 ----
	for (const slot of plan.slots) {
		if (slot.cards.length === 0) continue;
		const cols = slot.columns ?? baseCols;
		// 该槽位卡宽（列数不同时重新算，保证精确填满行宽）
		const slotCardW = Math.floor((usable - (cols - 1) * gap) / cols);
		const rows = Math.ceil(slot.cards.length / cols);
		const section: DeckSection = {
			title: slot.name,
			pos: [p.marginX, cursorY],
			width: sectionWidth,
			cols,
			cardSize: [slotCardW, cardH],
			gap,
			titleHeight: titleH,
			headerColor: borderColor,
			background: "rounded",
			align: "left",
			cards: slot.cards,
		};
		sections.push(section);

		// 记录每张卡位置（左对齐、顶部对齐）
		const innerX = p.marginX + INNER_PADDING;
		const cardsY = cursorY + INNER_PADDING + titleH + gap;
		for (let i = 0; i < slot.cards.length; i++) {
			const row = Math.floor(i / cols);
			const col = i % cols;
			positions.push({
				slot: slot.name,
				code: slot.cards[i].code,
				label: slot.cards[i].label,
				row,
				col,
				x: innerX + col * (slotCardW + gap),
				y: cardsY + row * (cardH + gap),
				w: slotCardW,
				h: cardH,
			});
		}
		slotSummary.push({ name: slot.name, y: cursorY, rows, cols, count: slot.cards.length });
		cursorY += sectionHeight(section, width) + p.sectionGap;
	}

	// ---- 合成布局 ----
	const height = Math.ceil(cursorY - p.sectionGap + 40);
	const layout: DeckLayout = {
		canvas: { width, height, background: DEFAULT_BG },
		header: hasHeader ? header : undefined,
		sections,
	};

	return { layout, positions, width, height, slots: slotSummary };
}

/**
 * 把排班结果格式化成文字报告，让 agent 通过文字感知每张卡的位置。
 *
 * 格式：
 *   画布 2820×4320，3 个槽位
 *   【支援卡】y=672 · 10张 · 2行×7列
 *     行1: .45自动手枪(01047) .45自动手枪(01047) 放大镜(01053) ...
 *     行2: ...
 */
export function describePositions(result: PlanResult): string {
	const lines: string[] = [];
	lines.push(`画布 ${result.width}×${result.height}px，${result.slots.length} 个槽位`);
	for (const s of result.slots) {
		lines.push("");
		lines.push(`【${s.name}】y=${s.y} · ${s.count}张 · ${s.rows}行×${s.cols}列`);
		// 按行分组
		const slotPositions = result.positions.filter((p) => p.slot === s.name);
		const byRow = new Map<number, CardPosition[]>();
		for (const pos of slotPositions) {
			const arr = byRow.get(pos.row) ?? [];
			arr.push(pos);
			byRow.set(pos.row, arr);
		}
		for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
			const arr = byRow.get(row)!.sort((a, b) => a.col - b.col);
			const cards = arr.map((c) => `${c.label ?? c.code}(${c.code})`).join(" ");
			lines.push(`  行${row + 1}: ${cards}`);
		}
	}
	return lines.join("\n");
}

/** 工具：构造调查员区尺寸（诊断/单测用）。 */
export function investigatorSize(cardH: number): Size {
	const h = Math.round(cardH * 0.66);
	return [Math.round(h * 1.4), h];
}
