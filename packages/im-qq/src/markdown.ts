/**
 * 把 Markdown 源文本剥离成纯文本。
 *
 * 用途：QQ markdown（msg_type=2）发送失败、降级为纯文本（msg_type=0）时，
 * 避免把 ** 加粗、> 引用、# 标题、` 代码等语法符号原样裸露给用户。
 *
 * 设计原则：
 * - 保守。只剥离明确的语法符号，不尝试还原渲染效果（标题不会变加粗，只是去掉 `#`）。
 * - 不破坏正常文本。行内标记要求成对、中间不含同类符号；块级标记要求行首。
 * - 保留 emoji、中文标点、特殊字符（—— · 等）。
 *
 * 覆盖 QQ 自定义 markdown 支持的子集（标题/加粗/斜体/删除线/链接/列表/引用/分割线）
 * 以及它**不支持但 agent 偶尔会产出**的代码块、表格（正是触发 40034011 降级的元凶）。
 */
export function stripMarkdownSyntax(input: string): string {
	let s = input;

	// 1. 围栏代码块 ```lang \n ... ``` → 保留正文，去掉围栏。先于其它规则，避免代码内容被二次处理。
	s = s.replace(/```[^\n`]*\n([\s\S]*?)```/g, "$1");
	// 残留的孤立 ```（未闭合）清掉。
	s = s.replace(/```/g, "");

	// 2. 表格：先删对齐分隔行（连同换行一起吃，避免留空行），再把表格数据行的 | 换成空格并压多空格。
	//    分隔行判定：整行仅由 空白/:/|/- 组成且至少 3 个连续 -；字符类显式排除换行，避免跨行吞掉相邻空行。
	s = s.replace(/^[ \t:|-]*-{3,}[ \t:|-]*[ \t]*\n?/gm, "");
	s = s.replace(/^\|(.*)\|[ \t]*$/gm, (_m, inner: string) => inner.replace(/\|/g, " ").replace(/[ \t]{2,}/g, " ").trim());

	// 3. 行首块级标记：标题 / 引用 / 无序列表 / 有序列表。
	s = s.replace(/^#{1,6}[ \t]+/gm, "");
	s = s.replace(/^>[ \t]?/gm, "");
	s = s.replace(/^[-*+][ \t]+/gm, "");
	s = s.replace(/^\d+\.[ \t]+/gm, "");

	// 4. 分割线（整行仅 -/*/_ 与空白组成，至少 3 个相同字符）。表格分隔行已被步骤 2 清掉，这里兜底 *** / ___。
	s = s.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "");

	// 5. 图片 ![alt](url) → alt；链接 [text](url) → text。
	s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

	// 6. 行内代码 `code` → code。
	s = s.replace(/`([^`]+)`/g, "$1");

	// 7. 删除线 ~~text~~ / 加粗 **text** / __text__ → text。先于斜体，避免 ** 被 * 误吃。
	s = s.replace(/~~([^~]+)~~/g, "$1");
	s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
	s = s.replace(/__([^_]+)__/g, "$1");

	// 8. 斜体 *text* / _text_（成对、中间不含同类符号或换行）。lookbehind/ahead 排除残留的 ** / __。
	s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
	s = s.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1");

	// 9. 收敛：去每行尾随空白，连续多空格压成单空格，3+ 连续空行压成 1 个空行。
	s = s.replace(/[ \t]+$/gm, "");
	s = s.replace(/[ \t]{2,}/g, " ");
	s = s.replace(/\n{3,}/g, "\n\n");

	return s.trim();
}

/**
 * 检测 QQ 自定义 markdown 不支持的语法。
 *
 * QQ markdown（msg_type=2）不支持代码块和表格，发了会被服务端拒（40034011），
 * 触发 adapter 降级。本函数在发送前预判这些语法，让 adapter 主动走纯文本路径，
 * 避免一次注定失败的网络请求和错误日志噪音。
 *
 * @returns 命中则返回原因（如 "代码块"）；否则 null
 */
export function detectUnsupportedMarkdown(text: string): string | null {
	// 围栏代码块 ```（闭合或未闭合都算）。
	if (/```/.test(text)) return "代码块";

	// 表格：连续 2 行以上以 | 开头（典型 GFM 表格），或存在对齐分隔行 |---|。
	const lines = text.split("\n");
	let pipeStreak = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^[ \t]*\|/.test(line)) {
			pipeStreak++;
			if (pipeStreak >= 2) return "表格";
		} else {
			pipeStreak = 0;
		}
		// 对齐分隔行（|:---|---:|），且上一行含 | → 视作表格。
		if (/^[ \t:|-]*-{3,}[ \t:|-]*$/.test(line) && i > 0 && lines[i - 1].includes("|")) {
			return "表格";
		}
	}

	return null;
}
