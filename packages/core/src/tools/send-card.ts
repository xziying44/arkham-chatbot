import { type Static, Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { realpath, stat } from "node:fs/promises";
import { resolve, join, sep } from "node:path";

/**
 * 发 .card 卡牌源文件能力：由上层（server）注入具体实现，避免 core 依赖具体 IM。
 * 实现把本地 .card 文件路径通过 IM 适配器发到当前 scope，让用户拿到源文件用编辑器编辑。
 * replyToMsgId 为当前被动消息 id（群消息发文件必须带，否则被判主动消息无权限）。
 */
export type CardSender = (scopeId: string, filePath: string, replyToMsgId?: string) => Promise<void>;

const sendCardSchema = Type.Object({
	filePath: Type.Optional(Type.String({ description: "已有的 .card 文件路径（工作目录内，如 cards/in/000.card）。与 cardJson 二选一。" })),
	cardJson: Type.Optional(Type.String({ description: ".card 的 JSON 内容字符串。传入后工具自动写文件到 cards/in/ 再发送（不用先 write）。与 filePath 二选一。" })),
});

export type SendCardInput = Static<typeof sendCardSchema>;

export interface CreateSendCardToolOptions {
	/** 当前 scope 的稳定 id（群/用户 openid）。 */
	readonly scopeId: string;
	/** 发文件的实现（由 server 注入 adapter.sendFile）。 */
	readonly send: CardSender;
	/** 取当前正在处理的被动消息 id。群消息发文件必须作为被动回复（带 msg_id）。 */
	readonly getReplyToMsgId?: () => string | undefined;
	/** 沙箱工作目录绝对路径。send_card 只允许发送此目录内的文件，防止 agent 越界。 */
	readonly workspaceDir?: string;
	/** 路径映射：沙箱内可见前缀 → 宿主机真实目录（同 send_image）。 */
	readonly pathMappings?: ReadonlyArray<{ readonly prefix: string; readonly hostDir: string }>;
}

/**
 * 创建 send_card 工具：让 agent 把制卡产出的 .card 源文件发给用户。
 *
 * 用户拿到 .card 后可在卡牌编辑器里直接编辑（改数值/正文/字段），比让 agent 反复改更高效。
 * 仅限 .card 扩展名（防止发任意文件）。
 */
export function createSendCardTool(opts: CreateSendCardToolOptions): AgentTool<typeof sendCardSchema, undefined> {
	return {
		name: "send_card",
		label: "send_card",
		description:
			"把 .card 卡牌源文件发送给用户编辑。两种方式：① 传 cardJson（JSON 内容字符串），工具自动写文件再发；② 传 filePath（已有文件路径）。用户拿到后可在编辑器里改。当用户想要 .card 源文件时调用。",
		parameters: sendCardSchema,
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const { filePath, cardJson } = params;

			// cardJson 模式：工具内部写文件再发（agent 不用先 write）。
			if (cardJson !== undefined) {
				if (opts.workspaceDir) {
					const inDir = join(opts.workspaceDir, "cards", "in");
					const writePath = join(inDir, "000.card");
					try {
						const { mkdir: mkd, writeFile: wf } = await import("node:fs/promises");
						await mkd(inDir, { recursive: true });
						// 校验是合法 JSON
						let parsed: unknown;
						try { parsed = JSON.parse(cardJson); } catch { return { content: [{ type: "text", text: "错误：cardJson 不是有效的 JSON" }], details: undefined }; }
						await wf(writePath, JSON.stringify(parsed, null, 2), "utf8");
						await opts.send(opts.scopeId, writePath, opts.getReplyToMsgId?.());
						return { content: [{ type: "text", text: `已写入并发送 .card 源文件：${writePath}` }], details: undefined };
					} catch (error) {
						return { content: [{ type: "text", text: `发送失败：${(error as Error).message}` }], details: undefined };
					}
				}
				return { content: [{ type: "text", text: "错误：cardJson 模式需要 workspaceDir" }], details: undefined };
			}

			// filePath 模式：发已有文件（原逻辑）。
			if (!filePath) {
				return { content: [{ type: "text", text: "错误：必须提供 filePath 或 cardJson" }], details: undefined };
			}
			// 扩展名校验：只允许 .card（防止发任意文件）。
			if (!filePath.endsWith(".card")) {
				return {
					content: [{ type: "text", text: `错误：send_card 只支持 .card 文件，${filePath} 不是 .card` }],
					details: undefined,
				};
			}
			// 路径解析（同 send_image）：先 pathMappings，再 workspaceDir。
			let resolvedPath: string;
			let mappedFromPrefix = false;
			const mapping = matchPathMapping(filePath, opts.pathMappings);
			if (mapping) {
				const normalized = filePath.replace(/^\.?\//, "");
				const p = mapping.prefix.replace(/^\.?\//, "").replace(/\/+$/, "");
				const rel = normalized.slice(p.length).replace(/^\/+/, "");
				resolvedPath = resolve(mapping.hostDir, rel);
				mappedFromPrefix = true;
			} else {
				resolvedPath = opts.workspaceDir
					? resolve(opts.workspaceDir, filePath)
					: resolve(filePath);
			}
			// 硬边界：只允许发送沙箱工作目录内的文件（同 send_image 的 realpath 检查）。
			if (opts.workspaceDir) {
				const fileReal = await realpath(resolvedPath).catch(() => null);
				let allowed: boolean;
				if (mappedFromPrefix && mapping) {
					const rootReal = await realpath(mapping.hostDir).catch(() => null);
					const rootPrefix = rootReal?.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
					allowed = rootReal != null && fileReal != null && (fileReal === rootReal || fileReal.startsWith(rootPrefix));
				} else {
					const wsReal = await realpath(opts.workspaceDir).catch(() => null);
					const wsPrefix = wsReal?.endsWith(sep) ? wsReal : `${wsReal}${sep}`;
					allowed = wsReal != null && fileReal != null && (fileReal === wsReal || fileReal.startsWith(wsPrefix));
				}
				if (!allowed) {
					return {
						content: [{ type: "text", text: `错误：${filePath} 不在可发送的目录范围内，无法发送。只能发送工作目录内的文件。` }],
						details: undefined,
					};
				}
			}
			try {
				const info = await stat(resolvedPath);
				if (!info.isFile()) {
					return { content: [{ type: "text", text: `错误：${filePath} 不是文件` }], details: undefined };
				}
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				const hint = code === "ENOENT" ? "（文件不存在，请确认路径和大小写拼写）" : `（${code ?? "读取失败"}）`;
				return { content: [{ type: "text", text: `错误：无法访问 ${filePath}${hint}` }], details: undefined };
			}
			try {
				await opts.send(opts.scopeId, resolvedPath, opts.getReplyToMsgId?.());
			} catch (error) {
				return {
					content: [{ type: "text", text: `发送失败：${(error as Error).message}` }],
					details: undefined,
				};
			}
			return { content: [{ type: "text", text: `已发送卡牌源文件：${filePath}` }], details: undefined };
		},
	};
}

/** 匹配路径映射（同 send_image，最长前缀优先）。 */
function matchPathMapping(
	filePath: string,
	mappings?: ReadonlyArray<{ readonly prefix: string; readonly hostDir: string }>,
): { prefix: string; hostDir: string } | undefined {
	if (!mappings || mappings.length === 0) return undefined;
	const sorted = [...mappings].sort((a, b) => b.prefix.length - a.prefix.length);
	const normalized = filePath.replace(/^\.?\//, "");
	for (const m of sorted) {
		const p = m.prefix.replace(/^\.?\//, "").replace(/\/+$/, "");
		if (normalized === p || normalized.startsWith(`${p}/`)) return m;
	}
	return undefined;
}
