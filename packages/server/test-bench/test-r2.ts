import { createNonStreamStreamFn } from "../src/non-stream-bridge.ts";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import * as builtinProviders from "@earendil-works/pi-ai/providers/all";
import { readFileSync } from "node:fs";

const envToken = readFileSync(".env", "utf8").match(/ANTHROPIC_AUTH_TOKEN=(.+)/)![1];
process.env.ANTHROPIC_AUTH_TOKEN = envToken;

const models = createModels();
for (const p of builtinProviders.builtinProviders()) (models as any).setProvider(p);
const base = anthropicProvider();
const cm = { id: "deepseek-v4-flash", name: "x", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.deepseek.com/anthropic", reasoning: false, input: ["text"] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 8192 };
(models as any).setProvider(createProvider({ id: "anthropic", name: "x", baseUrl: "https://api.deepseek.com/anthropic", auth: base.auth, models: [cm], api: anthropicMessagesApi() }));

const fn = createNonStreamStreamFn((m: any, c: any, o?: any) => models.streamSimple(m, c, o));

// Round 2 scenario: assistant did a tool call, now we send tool_result and expect next response
const ctx = {
  systemPrompt: "你是助手。",
  messages: [
    { role: "user", content: [{ type: "text", text: "加载 diy-card 技能" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "loading" }, { type: "toolCall", id: "call_1", name: "load_skill", arguments: { name: "diy-card" } }] },
    { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "技能内容：制卡技能" }] },
  ],
  tools: [{ name: "load_skill", description: "load skill", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }],
};

const stream = fn(cm, ctx as any, { maxTokens: 1024 });
const events: string[] = [];
for await (const ev of stream as any) { events.push((ev as any).type); }
const result = await (stream as any).result();
console.log("events:", events.join(", "));
console.log("final stopReason:", (result as any).stopReason);
console.log("final content types:", (result as any).content.map((c: any) => c.type).join(", "));
if ((result as any).stopReason === "error") {
  console.log("ERROR content:", JSON.stringify((result as any).content));
}
