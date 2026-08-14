/**
 * 诊断：某个 deck 里哪些卡取不到图，以及为什么。
 */
import { readFileSync, readdirSync } from "node:fs";

const CARD_IMG = "/Users/xziying/project/arkham/card-database/card_images";
const deckFile = process.argv[2] ?? "fixtures/deck-4689495.json";
const deck = JSON.parse(readFileSync(deckFile, "utf8")) as {
	investigator_code: string;
	slots: Record<string, number>;
	sideSlots?: Record<string, number>;
};

const allCodes = [deck.investigator_code, ...Object.keys(deck.slots ?? {}), ...Object.keys(deck.sideSlots ?? {})];
console.log(`deck: ${deckFile}`);
console.log(`调查员: ${deck.investigator_code}  总 code: ${allCodes.length}`);

const allFiles = new Set(readdirSync(CARD_IMG));
const missing: string[] = [];
for (const code of allCodes) {
	if (!allFiles.has(`${code}_a.jpg`)) missing.push(code);
}
console.log(`\n缺 _a.jpg 的 code (${missing.length}/${allCodes.length}):`);
for (const code of missing) {
	const hits = [...allFiles].filter((f) => f.startsWith(code));
	console.log(`  ${code} → 相关文件: ${hits.length ? hits.join(", ") : "(无)"}`);
}

// 统计：card_images 里以这些 code 开头的所有面
console.log(`\n各 code 的可用面文件:`);
for (const code of allCodes) {
	const hits = [...allFiles].filter((f) => f.startsWith(code + "_") || f === `${code}.jpg`);
	if (hits.length > 0) console.log(`  ${code}: ${hits.join(", ")}`);
}
