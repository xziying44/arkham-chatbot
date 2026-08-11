import { type Static, Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * render_card 工具：传 .card 的 JSON 内容 + 插画路径，工具内部嵌入 base64 + 写文件 + 渲染。
 *
 * 设计目的：
 * - agent 不用手动 write .card 文件（沙箱内写文件受限）
 * - 工具在宿主机进程执行，读插画文件 → 转 base64 → 嵌入 JSON 的 picture_base64 字段
 * - 渲染器（arkham-render pipeline.rs）优先读 picture_base64，无 base64 时 fallback picture_path
 * - 合并了 write + bash render + base64 嵌入三步，省 3 轮 LLM 往返
 */
const renderCardSchema = Type.Object({
	cardJson: Type.String({
		description: ".card 文件的 JSON 内容（完整字符串）。agent 把卡牌数据作为 JSON 字符串传入。",
	}),
	picturePath: Type.Optional(Type.String({
		description: "插画图片路径（工作目录内，如 generated/art-xxx-1.jpg 或 inbox/xxx.jpg）。工具会读取该图片转 base64 嵌入 cardJson 的 picture_base64 字段。升级卡或不需要插画时省略。",
	})),
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
			"把 .card 的 JSON 内容渲染成卡牌图片。传入完整的 .card JSON 字符串（cardJson）和插画路径（picturePath），工具自动读取插画转 base64 嵌入 JSON、写文件、渲染。返回渲染出的图片路径（如 cards/out/000.png），用 send_image 发送。这是制卡的核心步骤——一步完成 JSON+插画+渲染。",
		parameters: renderCardSchema,
		async execute(_toolCallId, params, _signal, _onUpdate) {
			const { cardJson, picturePath, filename } = params;
			const fname = (filename ?? "000").replace(/[^0-9]/g, "").slice(0, 3).padStart(3, "0") || "000";
			const inDir = join(opts.workspaceDir, "cards", "in");
			const outDir = join(opts.workspaceDir, "cards", "out");
			const cardPath = join(inDir, `${fname}.card`);

			try {
				await mkdir(inDir, { recursive: true });
				await mkdir(outDir, { recursive: true });

				// 解析 JSON，嵌入 base64 插画
				let cardData: Record<string, unknown>;
				try {
					cardData = JSON.parse(cardJson);
				} catch {
					return { content: [{ type: "text", text: "错误：cardJson 不是有效的 JSON" }], details: undefined };
				}

				// 如果给了 picturePath，读图片转 base64 嵌入 picture_base64 字段
				if (picturePath) {
					const absPicturePath = picturePath.startsWith("/")
						? picturePath
						: join(opts.workspaceDir, picturePath);
					try {
						const imgBuffer = await readFile(absPicturePath);
						const base64 = imgBuffer.toString("base64");
						// 渲染器支持 data:image/...;base64,... 格式
						const ext = absPicturePath.toLowerCase().endsWith(".png") ? "png" : "jpeg";
						cardData["picture_base64"] = `data:image/${ext};base64,${base64}`;
						// 移除 picture_path（避免渲染器先走 path 路径）
						delete cardData["picture_path"];
					} catch {
						return { content: [{ type: "text", text: `错误：读取插画失败 ${picturePath}（文件不存在或路径不对）` }], details: undefined };
					}
				}

				// 写 .card 文件
				await writeFile(cardPath, JSON.stringify(cardData, null, 2), "utf8");

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
