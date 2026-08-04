import { type Static, Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * ask_user 工具：agent 向用户发起带按钮的提问，等待用户选择。
 *
 * 机制（参考 opencode question 工具）：
 * - 工具 execute 内部 await 一个 pending Promise（阻塞 agent，runInFlight 保持非空）
 * - 用户点按钮 → INTERACTION_CREATE → session-manager.dispatchInteraction → resolve Promise
 * - 用户发文字消息 → bot-session.prompt 拦截 steer → reject Promise（文字内容作为响应）
 * - 超时（默认 5 分钟）→ 自动 reject
 *
 * resolve/reject 后工具 execute 返回，agent 继续。
 */

/** 超时时间（毫秒）。QQ 被动消息 5 分钟有效期，到时按钮消息也无法继续交互。 */
const ASK_TIMEOUT_MS = 5 * 60 * 1000;

/** 一个挂起的提问。由工具创建，由 dispatchInteraction（点按钮）或 prompt（发文字）消费。 */
export interface PendingAsk {
	/** resolve：用户点了按钮，answer 为所选选项的 label。 */
	resolve: (answer: string) => void;
	/**
	 * reject：用户没点按钮，reason 为文字消息内容（取消选择）或"超时"。
	 * 工具据此返回不同内容给 agent。
	 */
	reject: (reason: string) => void;
	/** 提问文本。 */
	question: string;
	/** 选项列表（label 即按钮 data，点按钮后原样返回）。 */
	options: { label: string }[];
	/** 创建时间戳。 */
	createdAt: number;
	/** 超时定时器。resolve/reject 时须 clearTimeout。 */
	timer: ReturnType<typeof setTimeout>;
}

/** 挂起提问的共享容器（类似 replyToHolder，工具与 session 共享同一引用）。 */
export type PendingAskHolder = { current?: PendingAsk };

const askUserSchema = Type.Object({
	question: Type.String({
		description: "要问用户的问题。简短明确，如「这张卡的职业选哪个？」",
	}),
	options: Type.Array(
		Type.Object({
			label: Type.String({
				description: "选项显示文字（1-6 字，简洁）。点击后此 label 作为用户的选择返回给你。",
			}),
		}),
		{ minItems: 2, maxItems: 5, description: "2-5 个选项。每个选项变成一个按钮。" },
	),
});

export type AskUserInput = Static<typeof askUserSchema>;

export interface CreateAskUserToolOptions {
	/** 取当前被动消息 id（群消息发按钮必须带 msg_id）。 */
	readonly getReplyToMsgId?: () => string | undefined;
	/**
	 * 发送带按钮的消息。由上层注入 adapter.sendKeyboard。
	 * content 为消息正文，keyboard 为按钮结构（QQ KeyboardPayload）。
	 */
	readonly sendKeyboard: (content: string, keyboard: unknown, replyToMsgId?: string) => Promise<void>;
	/** 挂起提问容器：工具创建 PendingAsk 写入，prompt/dispatchInteraction 读取消费。 */
	readonly pendingAskHolder: PendingAskHolder;
	/** 超时时间（毫秒），默认 5 分钟。 */
	readonly timeoutMs?: number;
}

/**
 * 创建 ask_user 工具。
 *
 * agent 调用后：发送带按钮的消息 → 阻塞等待用户响应 → 返回用户的选择或文字。
 * 工具执行期间 agent 挂起（runInFlight 保持非空），用户的新消息走 steer 拦截。
 */
export function createAskUserTool(opts: CreateAskUserToolOptions): AgentTool<typeof askUserSchema, undefined> {
	const timeoutMs = opts.timeoutMs ?? ASK_TIMEOUT_MS;
	return {
		name: "ask_user",
		label: "ask_user",
		description:
			"向用户发起一个带按钮的选择题。用户点击按钮选择，或直接打字回复（文字会作为响应返回给你）。" +
			"适用于 2-5 个明确选项的场景（如选职业、确认方案、选 A 还是 B）。" +
			"不要用于开放式问题（那种用 send_message 直接问）。" +
			"调用后工具会阻塞等待，直到用户响应或超时（5 分钟）。",
		parameters: askUserSchema,
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const { question, options } = params;

			// 若上一个提问还在挂起（理论上不会，因为 agent 串行），先超时取消它。
			if (opts.pendingAskHolder.current) {
				const prev = opts.pendingAskHolder.current;
				clearTimeout(prev.timer);
				prev.reject("超时（被新的提问取代）");
				opts.pendingAskHolder.current = undefined;
			}

			// 构造 keyboard：每个 option 一个指令按钮（type=2），每个按钮单独占一行。
			// 指令按钮点击后自动发送 @机器人 + data 作为用户消息（enter=true 自动发送）。
			// 这样用户的选择会出现在聊天记录里（历史可见），且走正常消息入站流程，
			// 由 prompt 的 steer 拦截 resolve pending ask（不需要 INTERACTION_CREATE 事件）。
			// 每行一个按钮（而非一行多列），保证按钮文字完整显示不被挤压。
			const keyboard = {
				content: {
					rows: options.map((opt, i) => ({
						buttons: [
							{
								id: `ask_${i}`,
								render_data: {
									label: opt.label,
									visited_label: opt.label,
									style: (i === 0 ? 1 : 0) as 0 | 1,
								},
								action: {
									type: 2 as const, // 指令按钮：点击自动发送 @bot + data
									permission: { type: 2 as const },
									data: opt.label,
									enter: true, // 点击后自动发送（不需用户手动点发送键）
								},
							},
						],
					})),
				},
			};

			// 发送带按钮的消息。
			const replyToMsgId = opts.getReplyToMsgId?.();
			try {
				await opts.sendKeyboard(question, keyboard, replyToMsgId);
			} catch (error) {
				return {
					content: [{ type: "text", text: `提问发送失败：${(error as Error).message}` }],
					details: undefined,
				};
			}

			// 创建 pending Promise，存入 holder。
			let resolveFn!: (answer: string) => void;
			let rejectFn!: (reason: string) => void;
			const promise = new Promise<string>((resolve, reject) => {
				resolveFn = resolve;
				rejectFn = reject;
			});

			const timer = setTimeout(() => {
				if (opts.pendingAskHolder.current === pending) {
					opts.pendingAskHolder.current = undefined;
					rejectFn("__TIMEOUT__");
				}
			}, timeoutMs);

			const pending: PendingAsk = {
				resolve: (answer: string) => {
					clearTimeout(timer);
					opts.pendingAskHolder.current = undefined;
					resolveFn(answer);
				},
				reject: (reason: string) => {
					clearTimeout(timer);
					opts.pendingAskHolder.current = undefined;
					rejectFn(reason);
				},
				question,
				options,
				createdAt: Date.now(),
				timer,
			};
			opts.pendingAskHolder.current = pending;

			// 等待用户响应。
			let result: string;
			try {
				result = await promise;
			} catch (reason) {
				// reject 的两种情况：文字消息（reason=用户文字）或超时（__TIMEOUT__）
				if (reason === "__TIMEOUT__") {
					return {
						content: [{ type: "text", text: "用户未响应（超时），请直接根据你的判断继续，或用 send_message 再问一次。" }],
						details: undefined,
					};
				}
				// 用户发了文字消息（没点按钮），reason 是消息内容
				return {
					content: [{ type: "text", text: `用户没有点按钮，而是直接回复了：「${reason}」。请据此继续。` }],
					details: undefined,
				};
			}

			return {
				content: [{ type: "text", text: `用户选择了：${result}` }],
				details: undefined,
			};
		},
	};
}
