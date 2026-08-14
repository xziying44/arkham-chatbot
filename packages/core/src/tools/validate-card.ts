/**
 * 制卡校验器：检查 .card JSON 是否符合文档约定。
 *
 * **原则**：只拦「铁错误」——文档明确禁止、程序可判定的硬规则。
 * 不做语义/启发式判断（body 文案对错、句式规范由 card-text-lint LLM 管；
 * 数值平衡由 arkham-card-numbers/scripts/balance_check.py 管）。
 *
 * 规则依据：
 * - 字段名/枚举：`skills/diy-card/references/card-types.md`
 * - 数据库标准枚举：`skills/card-search/references/enums.md`
 * - body 语法（尖括号 XML 禁令）：`skills/diy-card/references/tag-reference.md` 第 5-11 行
 *
 * 接入点：render_card / send_card 执行前调用，有 error 则拦截并把错误回给 agent。
 */

/** 校验问题。error = 必须修正（拦截渲染/发送）；warning = 提示但不拦。 */
export interface CardIssue {
	readonly severity: "error" | "warning";
	readonly field?: string;
	readonly message: string;
	/** 修正建议（给 agent 看的可操作提示）。 */
	readonly hint?: string;
}

// ---- 合法枚举（硬编码自 card-types.md / enums.md）----

/** 卡牌类型。取 card-types.md 模板（12 种）与 enums.md 数据库标准值（15 种）的并集。 */
const VALID_TYPES = new Set([
	"支援卡", "事件卡", "技能卡", "升级卡", "定制卡",
	"调查员", "调查员卡背", "敌人卡", "地点卡", "诡计卡",
	"场景卡", "密谋卡", "故事卡", "密钥卡", "冒险参考卡",
	"场景卡-大画", "密谋卡-大画",
	"场景卡背", "密谋卡背",
]);

/** 职阶。两份文档统一用「潜修者」（全仓不使用「秘术家」）。 */
const VALID_CLASSES = new Set([
	"守护者", "探求者", "流浪者", "潜修者", "生存者",
	"中立", "多职阶", "遭遇", "弱点",
]);

/**
 * 合法顶级字段名并集（所有卡类型出现过的字段）。
 * 未知字段名（如 agent 误写的 `icons`）→ error。
 */
const VALID_FIELDS = new Set([
	// 通用
	"type", "name", "class", "subclass", "cost", "level", "traits", "body", "flavor", "language",
	// 支援卡
	"slots", "slots2", "health", "horror",
	// 技能卡 / 调查员
	"submit_icon", "subtitle", "attribute", "card_back",
	// 敌人卡
	"enemy_damage", "enemy_damage_horror", "attack", "evade", "enemy_health", "victory",
	// 地点卡
	"location_type", "shroud", "clues", "location_icon", "location_link",
	// 场景/密谋卡
	"serial_number", "threshold",
	// 渲染注入（render_card / send_card 写入，合法）
	"picture_base64", "picture_path",
]);

/** submit_icon 合法元素：中文词（非 emoji、非单字简称）。 */
const VALID_SUBMIT_ICONS = new Set(["意志", "智力", "战力", "敏捷", "狂野"]);

/** submit_icon 常见误写 → 规范词（用于给 agent 精确提示）。 */
const SUBMIT_ICON_ALIASES: Record<string, string> = {
	// 单字简称（card-types.md 第 59 行约定的转换）
	"脑": "意志", "拳": "战力", "脚": "敏捷", "书": "智力", "?": "狂野",
	// emoji 误用（tag-reference.md 属性图标表）
	"🧠": "意志", "📚": "智力", "👊": "战力", "🦶": "敏捷", "❓": "狂野",
};

/** 支援卡槽位合法值（card-types.md 第 26 行）。无槽位用 null。 */
const VALID_SLOTS = new Set(["手部", "双手", "法术", "双法术", "身体", "盟友", "附件", "饰品", "塔罗", "空"]);

/** 地点图标合法值（card-types.md 第 166 行），location_icon 单值与 location_link 元素共用。 */
const VALID_LOCATION_ICONS = new Set([
	"绿菱", "暗红漏斗", "橙心", "浅褐水滴", "深紫星", "深绿斜二", "深蓝T",
	"紫月", "红十", "红方", "蓝三角", "褐扭", "青花", "黄圆",
]);

const VALID_LOCATION_TYPES = new Set(["已揭示", "未揭示"]);

/** 数字型字段（必须 number | null）。 */
const NUMERIC_FIELDS = new Set([
	"cost", "level", "health", "horror", "enemy_damage", "enemy_damage_horror", "victory",
]);
/** 数组型字段（必须数组）。 */
const ARRAY_FIELDS = new Set(["traits", "subclass", "submit_icon", "location_link", "attribute"]);

/**
 * body 尖括号标签检测：匹配所有 `<...>`，再用白名单排除**合法渲染标记**。
 * 合法（白名单，tag-reference.md 定义）：<点>（选择列表）、<i></i>（斜体）。
 * 非法：其它一切尖括号标签——如 <拳> <启动> <反应> <t>武器</t>，渲染引擎用 emoji+【】语法不用这些。
 * 仅作用于 body，不误伤 <调查员> 缩放标记（那在 enemy_health/clues/threshold 等字段值里）。
 */
const ANGLE_BRACKET_RE = /<[^\s<>]+>/g;
const ALLOWED_ANGLE_TAGS = new Set(["<点>", "<i>", "</i>"]);

/**
 * traits 不应含标点（括号 / 句号 / 换行）——特性应是单词（如「违法」「契约」）。
 * 含括号/句号 → 几乎可以肯定是把正文句子误填进了特性数组（如「绑定（做账）」）。
 */
const TRAIT_PUNCT_RE = /[（）()。\n\r]/;

/**
 * 校验一张卡的 JSON。
 * @param card 已 JSON.parse 的卡牌对象
 * @returns 问题列表（空 = 通过）。有 severity:"error" 的必须修正后才能渲染/发送。
 */
export function validateCard(card: unknown): CardIssue[] {
	const issues: CardIssue[] = [];
	if (typeof card !== "object" || card === null || Array.isArray(card)) {
		return [{ severity: "error", message: "卡牌数据必须是 JSON 对象" }];
	}
	const c = card as Record<string, unknown>;

	// 1. 必填字段
	if (!("type" in c)) issues.push({ severity: "error", field: "type", message: "缺少必填字段 type（卡牌类型）" });
	if (!("name" in c)) issues.push({ severity: "error", field: "name", message: "缺少必填字段 name（卡牌标题）" });

	// 2. 未知字段名（抓 icons 这类 agent 自造的字段）
	for (const key of Object.keys(c)) {
		if (!VALID_FIELDS.has(key)) {
			issues.push({
				severity: "error",
				field: key,
				message: `未知字段「${key}」——不在 card-types.md 的合法字段集合里。`,
				hint: key === "icons"
					? "投入图标字段是 submit_icon（不是 icons）。注意 submit_icon 是技能卡特有，事件卡无此字段。"
					: "请核对 card-types.md 的字段名拼写。",
			});
		}
	}

	// 3. type 枚举
	if (typeof c.type === "string" && !VALID_TYPES.has(c.type)) {
		issues.push({
			severity: "error",
			field: "type",
			message: `type「${c.type}」不是合法卡牌类型`,
			hint: "合法值见 card-types.md（支援卡/事件卡/技能卡/敌人卡/诡计卡/地点卡/调查员/场景卡/密谋卡/故事卡…）",
		});
	}

	// 4. class 枚举
	if (typeof c.class === "string" && !VALID_CLASSES.has(c.class)) {
		issues.push({
			severity: "error",
			field: "class",
			message: `class「${c.class}」不是合法职阶`,
			hint: "合法值：守护者/探求者/流浪者/潜修者/生存者/中立/多职阶/遭遇/弱点",
		});
	}

	// 5. submit_icon 元素（必须中文词，拒 emoji / 简称）
	if (Array.isArray(c.submit_icon)) {
		c.submit_icon.forEach((ic, i) => {
			if (typeof ic !== "string" || !VALID_SUBMIT_ICONS.has(ic)) {
				const norm = typeof ic === "string" ? SUBMIT_ICON_ALIASES[ic] : undefined;
				issues.push({
					severity: "error",
					field: `submit_icon[${i}]`,
					message: `submit_icon 元素「${String(ic)}」不合法——必须是中文词，不是 emoji/单字简称。`,
					hint: norm ? `应为「${norm}」` : "合法值：意志/智力/战力/敏捷/狂野",
				});
			}
		});
	}

	// 6. traits 不应含标点（抓「绑定（做账）」这类误填）
	if (Array.isArray(c.traits)) {
		c.traits.forEach((tr, i) => {
			if (typeof tr === "string" && TRAIT_PUNCT_RE.test(tr)) {
				issues.push({
					severity: "error",
					field: `traits[${i}]`,
					message: `特性「${tr}」含标点（括号/句号）——特性应是单词（如 违法/契约），疑似把正文句子误填进了特性。`,
					hint: "把这句正文移到 body 字段。",
				});
			}
		});
	}

	// 7. slots 枚举（支援卡）
	for (const sf of ["slots", "slots2"] as const) {
		const v = c[sf];
		if (typeof v === "string" && !VALID_SLOTS.has(v)) {
			issues.push({
				severity: "error",
				field: sf,
				message: `${sf}「${v}」不是合法槽位`,
				hint: "合法值：手部/双手/法术/双法术/身体/盟友/附件/饰品/塔罗/空；无槽位填 null",
			});
		}
	}

	// 8. location_type / location_icon / location_link 枚举（地点卡）
	if (typeof c.location_type === "string" && !VALID_LOCATION_TYPES.has(c.location_type)) {
		issues.push({ severity: "error", field: "location_type", message: "location_type 必须是「已揭示」或「未揭示」" });
	}
	if (typeof c.location_icon === "string" && !VALID_LOCATION_ICONS.has(c.location_icon)) {
		issues.push({
			severity: "error",
			field: "location_icon",
			message: `location_icon「${c.location_icon}」不合法`,
			hint: "合法值见 card-types.md（绿菱/暗红漏斗/橙心… 共 14 种）",
		});
	}
	if (Array.isArray(c.location_link)) {
		c.location_link.forEach((lc, i) => {
			if (typeof lc === "string" && !VALID_LOCATION_ICONS.has(lc)) {
				issues.push({ severity: "error", field: `location_link[${i}]`, message: `location_link 元素「${lc}」不合法` });
			}
		});
	}

	// 9. body 尖括号标签禁令（tag-reference.md 铁律）：<点>/<i> 是合法渲染标记，其余 <...> 非法
	if (typeof c.body === "string") {
		const illegal = (c.body.match(ANGLE_BRACKET_RE) ?? []).filter((m) => !ALLOWED_ANGLE_TAGS.has(m));
		if (illegal.length > 0) {
			issues.push({
				severity: "error",
				field: "body",
				message: `body 含非法尖括号标签 ${illegal.join("、")}——属性图标/行动前缀用 emoji（🧠📚👊🦶 / ➡️⚡⭕），特性引用用花括号 {武器}。注：<点>（选择列表）、<i>（斜体）是合法渲染标记，不报错。`,
				hint: "见 tag-reference.md。",
			});
		}
	}

	// 10. 字段类型（数字型 / 数组型）
	for (const f of NUMERIC_FIELDS) {
		if (f in c) {
			const v = c[f];
			if (v !== null && typeof v !== "number") {
				issues.push({ severity: "error", field: f, message: `${f} 应为数字（或 null），实际 ${typeof v}` });
			}
		}
	}
	for (const f of ARRAY_FIELDS) {
		if (f in c && !Array.isArray(c[f])) {
			issues.push({ severity: "error", field: f, message: `${f} 应为数组，实际 ${typeof c[f]}` });
		}
	}

	return issues;
}

/** 是否存在阻断性错误（render_card / send_card 据此决定是否拦截）。 */
export function hasCardErrors(issues: readonly CardIssue[]): boolean {
	return issues.some((i) => i.severity === "error");
}

/** 把 error 列表格式化成给 agent 看的文本（校验失败时作为工具返回内容）。warning 不展示。 */
export function formatCardErrors(issues: readonly CardIssue[]): string {
	const errors = issues.filter((i) => i.severity === "error");
	if (errors.length === 0) return "";
	const lines = errors.map((i) => {
		const f = i.field ? `[${i.field}] ` : "";
		const h = i.hint ? `（${i.hint}）` : "";
		return `- ${f}${i.message}${h}`;
	});
	return `卡牌校验未通过（${errors.length} 处错误），请修正后重试：\n${lines.join("\n")}`;
}
