import { type Static, Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * render_card 工具：传 .card 的 JSON 内容，工具内部写文件 + 调 arkham-cli 渲染 + 返回图片路径。
 *
 * 合并了原来的 write .card + bash render 两步，省掉 2 轮 LLM 往返。
 * agent 只需在 send_image 时引用返回的图片路径。
 */
const renderCardSchema = Type.Object({
	cardJson: Type.String({
		description: ".card 文件的 JSON 内容（完整字符串）。agent 把卡牌数据作为 JSON 字符串传入，工具内部写文件。",
	}),
	filename: Type.Optional(Type.String({
		description: "文件名（不带扩展名），默认 '000'。文件名前3位必须是数字。",
	})),
});

export type RenderCardInput = Static<typeof renderCardSchema>;

export interface CreateRenderCardToolOptions {
	/** 沙箱工作目录绝对路径。 */
	readonly workspaceDir: string;
	/** arkham-cli 二进制路径（宿主机）。 */
	readonly arkhamBinPath?: string;
	/** arkham-cli 资产目录（宿主机）。 */
	readonly arkhamAssetsDir?: string;
}

export function createRenderCardTool(opts: CreateRenderCardToolOptions): AgentTool<typeof renderCardSchema, { imagePath: string; cardPath: string } | undefined> {
	return {
		name: "render_card",
		label: "render_card",
		description:
			"把 .card 的 JSON 内容渲染成卡牌图片。传入完整的 .card JSON 字符串（cardJson），工具自动写文件到 cards/in/ 并渲染到 cards/out/。返回渲染出的图片路径（如 cards/out/000.png），用 send_image 发送。合并了写文件+渲染两步，省得分别调 write 和 bash。",
		parameters: renderCardSchema,
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const { cardJson, filename } = params;
			const fname = (filename ?? "000").replace(/[^0-9]/g, "").slice(0, 3).padStart(3, "0") || "000";
			const inDir = join(opts.workspaceDir, "cards", "in");
			const outDir = join(opts.workspaceDir, "cards", "out");
			const cardPath = join(inDir, `${fname}.card`);

			try {
				// 写 .card 文件
				await mkdir(inDir, { recursive: true });
				await mkdir(outDir, { recursive: true });
				await writeFile(cardPath, cardJson, "utf8");

				// 渲染：调 arkham-cli
				const arkhamBin = opts.arkhamBinPath ?? join(opts.workspaceDir, ".arkham", "bin", "arkham-cli");
				const arkhamAssets = opts.arkhamAssetsDir ?? join(opts.workspaceDir, ".arkham", "assets");
				const { stdout, stderr } = await execFileAsync(arkhamBin, [
					"render",
					"--corpus", inDir,
					"--assets", arkhamAssets,
					"--workspace", opts.workspaceDir,
					"--out", outDir,
				], { timeout: 30_000, cwd: opts.workspaceDir });

				const output = (stdout + (stderr ? "\n" + stderr : "")).trim();
				const success = output.includes("[OK");
				const imagePath = join(outDir, `${fname}.png`);

				if (success) {
					return {
						content: [{ type: "text", text: `渲染成功：${imagePath}\n${output}` }],
						details: { imagePath, cardPath },
					};
				} else {
					return {
						content: [{ type: "text", text: `渲染失败：\n${output}\n\n请检查 .card 格式（type/class/字段名）后重试。` }],
						details: undefined,
					};
				}
			} catch (error) {
				return {
					content: [{ type: "text", text: `渲染出错：${(error as Error).message}` }],
					details: undefined,
				};
			}
		},
	};
}
