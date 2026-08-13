/**
 * 一次性迁移脚本：把现有 data 目录下所有 session.jsonl 与 history 目录下的 jsonl
 * 导入 conversations 表。
 *
 * 路径推导 scope：
 *   data/<botId>/group/<scopeId>/session.jsonl                    → group 会话
 *   data/<botId>/group/<scopeId>/members/<memberId>/session.jsonl → group 成员会话
 *   data/<botId>/user/<scopeId>/session.jsonl                     → 私聊
 * history/ 下的 jsonl 同理（按天归档）。
 *
 * 去重靠 conversations 表的 content_hash 唯一索引（INSERT OR IGNORE），重复跑也安全。
 *
 * 运行：pnpm --filter @arkham/chatbot-server exec node --import tsx scripts/migrate-conversations.ts
 */
import { openDb, ConversationRepository } from "@arkham/chatbot-store";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DB_PATH = resolve(REPO_ROOT, "data/chatbot.db");
const DATA_ROOT = resolve(REPO_ROOT, "data");

const db = await openDb(DB_PATH);
const conversations = new ConversationRepository(db);

interface ParsedScope {
	botId: string;
	scopeKind: "group" | "user";
	scopeId: string;
	memberId: string | null;
}

/** 从 jsonl 文件路径推导 scope 信息。推导失败返回 null（跳过）。 */
function parseScope(filePath: string): ParsedScope | null {
	const rel = filePath.slice(DATA_ROOT.length + 1).split("/");
	// rel: [<botId>, "group"|"user", <scopeId>, ("members", <memberId>)?, ("history")?, <file>]
	if (rel.length < 4) return null;
	const botId = rel[0];
	const scopeKind = rel[1] as "group" | "user";
	if (scopeKind !== "group" && scopeKind !== "user") return null;
	const scopeId = rel[2];
	let memberId: string | null = null;
	let idx = 3;
	if (rel[idx] === "members" && rel[idx + 1]) {
		memberId = rel[idx + 1];
		idx += 2;
	}
	// rel[idx] 现在应是 "history"（归档）或文件名 session.jsonl
	return { botId, scopeKind, scopeId, memberId };
}

let totalFiles = 0;
let totalInserted = 0;
let totalSkipped = 0;

function migrateFile(filePath: string, scope: ParsedScope): void {
	const content = readFileSync(filePath, "utf8");
	const lines = content.split("\n").filter((l) => l.trim());
	const inserts: import("@arkham/chatbot-store").ConversationInsert[] = [];
	for (const line of lines) {
		try {
			const msg = JSON.parse(line) as {
				role?: string;
				content?: unknown;
				timestamp?: number;
				stopReason?: string;
				model?: string;
			};
			const role = msg.role ?? "unknown";
			const ts = typeof msg.timestamp === "number" && msg.timestamp > 0 ? msg.timestamp : Date.now();
			inserts.push({
				botId: scope.botId,
				scopeKind: scope.scopeKind,
				scopeId: scope.scopeId,
				memberId: scope.memberId,
				runId: null, // 历史数据无 runId
				ts,
				role,
				contentJson: JSON.stringify(msg.content ?? null),
				stopReason: msg.stopReason ?? null,
				model: msg.model ?? null,
			});
		} catch {
			totalSkipped++;
		}
	}
	if (inserts.length > 0) {
		conversations.insertMany(inserts);
		totalInserted += inserts.length;
	}
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) out.push(...walk(full));
		else if (full.endsWith(".jsonl")) out.push(full);
	}
	return out;
}

console.log("=== 迁移 history/session.jsonl → conversations 表 ===");
const allFiles = walk(DATA_ROOT).filter((f) => f.includes("/session.jsonl") || f.includes("/history/"));
console.log(`找到 ${allFiles.length} 个 jsonl 文件`);

for (const file of allFiles) {
	const scope = parseScope(file);
	if (!scope) {
		console.warn(`  跳过（路径推导失败）: ${file.slice(DATA_ROOT.length + 1)}`);
		continue;
	}
	const before = totalInserted;
	migrateFile(file, scope);
	const delta = totalInserted - before;
	console.log(`  ${file.slice(DATA_ROOT.length + 1)}: ${delta} 条`);
	totalFiles++;
}

console.log(`\n=== 迁移完成 ===`);
console.log(`文件: ${totalFiles}，导入: ${totalInserted} 条，跳过(损坏行): ${totalSkipped} 条`);
console.log(`（重复运行安全：content_hash 唯一索引去重）`);
db.close();
