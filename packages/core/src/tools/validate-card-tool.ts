import { type Static, Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { validateCard, hasCardErrors, formatCardErrors } from "./validate-card.ts";

const validateCardSchema = Type.Object({
	cardJson: Type.String({ description: "要校验的 .card JSON 字符串（完整内容）。" }),
});

export type ValidateCardInput = Static<typeof validateCardSchema>;

/**
 * validate_card 工具：让 agent 在渲染/发送前主动校验 .card JSON。
 *
 * render_card / send_card 执行前会自动校验并拦截 error，本工具供 agent 提前自查：
 * 写完 cardJson 后先 validate_card，按提示修正字段名/枚举/语法错误，再 render_card，
 * 省掉一次"渲染被拦 → 改 → 再渲染"的往返。
 */
export function createValidateCardTool(): AgentTool<typeof validateCardSchema, undefined> {
	return {
		name: "validate_card",
		label: "validate_card",
		description:
			"校验 .card JSON 是否符合制卡规范（字段名白名单、type/class/slots/location_icon 枚举、submit_icon 元素、特性不含标点、body 不用尖括号 XML、字段类型）。render_card 和 send_card 在执行前也会自动校验并拦截——本工具供你在渲染前主动自查，提前修正常见错误（如误用 icons 字段应为 submit_icon、submit_icon 写成 emoji 📚 应为中文 智力、特性误填正文句子、body 误用 <拳> 应为 👊）。",
		parameters: validateCardSchema,
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const { cardJson } = params;
			let parsed: unknown;
			try {
				parsed = JSON.parse(cardJson);
			} catch {
				return { content: [{ type: "text", text: "错误：cardJson 不是有效的 JSON" }], details: undefined };
			}
			const issues = validateCard(parsed);
			if (!hasCardErrors(issues)) {
				const w = issues.length;
				return {
					content: [{ type: "text", text: `✅ 校验通过${w > 0 ? `（${w} 条 warning 可忽略）` : ""}，可以 render_card / send_card。` }],
					details: undefined,
				};
			}
			return { content: [{ type: "text", text: formatCardErrors(issues) }], details: undefined };
		},
	};
}
