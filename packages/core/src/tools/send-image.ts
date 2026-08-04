import { type Static, Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * 发图片能力：由上层（server）注入具体实现，避免 core 依赖具体 IM。
 * 实现把本地图片路径通过 IM 适配器发到当前 scope。
 * replyToMsgId 为当前被动消息 id（群消息发图必须带，否则被判主动消息无权限）。
 */
export type ImageSender = (scopeId: string, filePath: string, replyToMsgId?: string) => Promise<void>;

const sendImageSchema = Type.Object({
	filePath: Type.String({ description: "宿主机本地图片文件绝对路径（png/jpg）" }),
	caption: Type.Optional(Type.String({ description: "可选的图片说明文字" })),
});

export type SendImageInput = Static<typeof sendImageSchema>;

export interface CreateSendImageToolOptions {
	/** 当前 scope 的稳定 id（群/用户 openid）。 */
	readonly scopeId: string;
	/** 发图片的实现（由 server 注入 adapter.sendImage）。 */
	readonly send: ImageSender;
	/**
	 * 取当前正在处理的被动消息 id。群消息发图必须作为被动回复（带 msg_id），
	 * 否则 QQ 判定为主动消息而拒绝（40034105）。运行时由 ChatBotSession 注入。
	 */
	readonly getReplyToMsgId?: () => string | undefined;
	/**
	 * 沙箱工作目录绝对路径。send_image 只允许发送此目录内的图片，
	 * 防止 agent 越界访问沙箱外文件。未提供则不限制（仅开发/调试用）。
	 */
	readonly workspaceDir?: string;
}

/**
 * 创建 send_image 工具：让 agent 能主动向当前会话发送本地图片。
 * agent 在需要展示截图、图表、生成图等场景调用。
 */
export function createSendImageTool(opts: CreateSendImageToolOptions): AgentTool<typeof sendImageSchema, undefined> {
	return {
		name: "send_image",
		label: "send_image",
		description:
			"把当前工作目录（沙箱）里的一张图片（png/jpg/jpeg）发送给本会话用户。filePath 必须是沙箱工作目录内的路径（相对路径或绝对路径均可），工具会自动读取并发送，无需先用 read/bash 读取。当用户想看某张图片（把图片发来、看看图片）且该图片在工作目录内时，调用此工具。图片只会发给当前会话的用户，无法发送给其它群或个人。",
		parameters: sendImageSchema,
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const { filePath, caption } = params;
			// 解析为工作目录内的绝对路径。
			// agent 传入的可能是相对路径（如 "cards/out/000.png"），必须相对于 workspaceDir 解析，
			// 而非进程 cwd（进程 cwd 是项目根，不是沙箱工作目录）。
			const resolvedPath = opts.workspaceDir
				? resolve(opts.workspaceDir, filePath)
				: resolve(filePath);
			// 硬边界：只允许发送沙箱工作目录内的图片。
			// 用 realpath 解析符号链接（防 link 逃逸到沙箱外），再做严格的目录包含判断
			// （防字符串前缀误判：/data/x 不是 /data/xyz 的子目录）。
			if (opts.workspaceDir) {
				const wsReal = await realpath(opts.workspaceDir).catch(() => null);
				const fileReal = await realpath(resolvedPath).catch(() => null);
				const wsPrefix = wsReal?.endsWith(sep) ? wsReal : `${wsReal}${sep}`;
				const inside = wsReal != null && fileReal != null && (fileReal === wsReal || fileReal.startsWith(wsPrefix));
				if (!inside) {
					return {
						content: [{ type: "text", text: `错误：${filePath} 不在工作目录内，无法发送。只能发送工作目录内的图片。` }],
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
			const msg = caption ? `已发送图片：${filePath}（${caption}）` : `已发送图片：${filePath}`;
			return { content: [{ type: "text", text: msg }], details: undefined };
		},
	};
}
