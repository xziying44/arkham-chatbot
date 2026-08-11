import { readdirSync, readFileSync } from "fs";
import { join } from "path";
const root = process.argv[2];
function findJsonl(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) { const r = findJsonl(p); if (r) return r; }
		if (e.name === "session.jsonl") return p;
	}
}
const f = findJsonl(root);
if (!f) { console.log("no session.jsonl"); process.exit(1); }
const lines = readFileSync(f, "utf8").split("\n").filter(l => l.trim());
let round = 0;
for (const line of lines) {
	const m = JSON.parse(line);
	if (m.role === "assistant") {
		round++;
		const tools = m.content.filter(b => b.type === "toolCall").map(b => b.name);
		const text = m.content.filter(b => b.type === "text").map(b => b.text.slice(0, 60));
		console.log(`轮${round}: tools=[${tools.join(",")}] ${text[0] || ""}`);
	} else if (m.role === "toolResult") {
		const c = JSON.stringify(m.content).slice(0, 100);
		console.log(`  -> ${m.toolName}: ${c}`);
	}
}
