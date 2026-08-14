/**
 * 冒烟测试：模拟 bot 装配环境，直接调用 import_deck / render_deck 工具全链路。
 * 验证宿主机路径（卡图/字体/元数据）+ arkham.build 在线拉取 + 渲染落盘。
 */
import { createDeckTools } from "@arkham/chatbot-core";
import { mkdir, stat } from "node:fs/promises";

const workspaceDir = "/tmp/deck-smoke-ws";
await mkdir(workspaceDir, { recursive: true });

const tools = createDeckTools({
	workspaceDir,
	deck: {
		cardDatabaseDir: "/Users/xziying/project/arkham/card-database",
		arkhamdbDataDir: "/Users/xziying/project/arkham/社区数据库/arkhamdb-json-data",
		fontsDir: "/Users/xziying/project/arkham/arkham-homebrew/fonts",
	},
});

const importDeck = tools.find((t) => t.name === "import_deck")!;
const renderDeck = tools.find((t) => t.name === "render_deck")!;
console.log("装配的工具:", tools.map((t) => t.name).join(", "));

// 1. import_deck：arkham.build 分享链接
console.log("\n===== import_deck（arkham.build 分享）=====");
const r1 = await importDeck.execute("t1", { deck: "https://arkham.build/deck/view/EaXFKGBAR7i9hob" }, undefined as never, undefined as never);
console.log((r1.content[0] as { text: string }).text.slice(0, 800));

// 2. import_deck：ArkhamDB 数字 id
console.log("\n===== import_deck（ArkhamDB id 4689495）=====");
const r2 = await importDeck.execute("t2", { deck: "4689495" }, undefined as never, undefined as never);
const text2 = (r2.content[0] as { text: string }).text;
console.log(text2.split("\n").slice(0, 10).join("\n"));

// 3. render_deck：用保存的 planPath
console.log("\n===== render_deck（planPath）=====");
const planRel = "decks/plan-4689495.json";
const r3 = await renderDeck.execute("t3", { planPath: planRel }, undefined as never, undefined as never);
const text3 = (r3.content[0] as { text: string }).text;
console.log(text3.split("\n").slice(0, 6).join("\n"));
console.log("  ...(位置报告略)...");
const info = await stat((r3.details as { imagePath: string }).imagePath);
console.log(`\n渲染产物: ${(r3.details as { imagePath: string }).imagePath} (${(info.size / 1024).toFixed(0)}KB)`);
console.log("\n✓ 冒烟测试通过");
