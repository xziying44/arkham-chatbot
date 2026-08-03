import { type Static, Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { stat } from "node:fs/promises";

/**
 * 发图片能力：由上层（server）注入具体实现，避免 core 依赖具体 IM。
 * 实现把本地图片路径通过 IM 适配器发到当前 scope。
 */
export type ImageSender = (scopeId: string, filePath: string) => Promise<void>;

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
			"向当前会话发送一张本地图片（png/jpg）。参数 filePath 为宿主机上的图片绝对路径。可选用 caption 附带说明。",
		parameters: sendImageSchema,
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const { filePath, caption } = params;
			try {
				const info = await stat(filePath);
				if (!info.isFile()) {
					return { content: [{ type: "text", text: `错误：${filePath} 不是文件` }], details: undefined };
				}
			} catch {
				return { content: [{ type: "text", text: `错误：文件不存在 ${filePath}` }], details: undefined };
			}
			await opts.send(opts.scopeId, filePath);
			const msg = caption ? `已发送图片：${filePath}（${caption}）` : `已发送图片：${filePath}`;
			return { content: [{ type: "text", text: msg }], details: undefined };
		},
	};
}
