/**
 * 制卡链路计时基准（隔离测试）。
 *
 * 用和生产环境相同的 model + tools + skills 驱动一次真实的制卡请求，
 * 记录每轮 LLM 调用、每个工具调用、总耗时。
 *
 * 用法（从 repo 根目录）：
 *   node --import tsx packages/server/test-bench/bench.ts [variant]
 *   variant: "current" (当前) | "fast" (优化后)
 */

import { Agent, type AgentEvent, type AgentTool, type Skill, formatSkillsForSystemPrompt, createReadTool, createWriteTool, createEditTool } from "@earendil-works/pi-agent-core";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import * as builtinProviders from "@earendil-works/pi-ai/providers/all";
import { createRestrictedBashTool } from "../../../packages/core/src/tools/restricted-bash.ts";
import { buildSystemPrompt } from "../../../packages/core/src/agent/system-prompt.ts";
import { loadSkillsFromDir } from "../../../packages/core/src/skills/skill-loader.ts";
import { mkdtemp, rm, mkdir, symlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, relative } from "node:path";
import { readFileSync } from "node:fs";

// ---------- 读 .env ----------
function loadEnv(): Record<string, string> {
  const envText = readFileSync(".env", "utf8");
  const env: Record<string, string> = {};
  for (const line of envText.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
const ENV = loadEnv();
const ANTHROPIC_BASE_URL = ENV.ANTHROPIC_BASE_URL!;
const ANTHROPIC_AUTH_TOKEN = ENV.ANTHROPIC_AUTH_TOKEN!;
const MODEL_SPEC = ENV.CHATBOT_MODEL!;
const ARKHAM_WORKSHOP_DIR = ENV.ARKHAM_WORKSHOP_DIR!;
// 注入环境变量，让 OpenAI provider 能拿到 API key（DeepSeek 用同一个 token）
process.env.OPENAI_API_KEY = ANTHROPIC_AUTH_TOKEN;
process.env.ANTHROPIC_AUTH_TOKEN = ANTHROPIC_AUTH_TOKEN;

// ---------- 模型 ----------
// 用 DeepSeek 的 OpenAI 兼容端点（绕过 Anthropic 端点流式 tool_use 参数为空的 bug）。
// DeepSeek 的 /v1/chat/completions 端点工具调用参数完整返回。
function buildModel() {
  const models = createModels();
  for (const p of builtinProviders.builtinProviders()) (models as any).setProvider(p);
  const customModel = {
    id: "deepseek-chat", name: "deepseek-chat", api: "openai-completions" as const, provider: "openai",
    baseUrl: "https://api.deepseek.com/v1", reasoning: false,
    input: ["text", "image"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000, maxTokens: 8192,
  };
  const customProvider = createProvider({
    id: "openai", name: "DeepSeek (OpenAI)", baseUrl: "https://api.deepseek.com/v1",
    auth: openaiProvider().auth, models: [customModel], api: openAICompletionsApi(),
  });
  (models as any).setProvider(customProvider);
  return { models, model: models.getModel("openai", "deepseek-chat")! };
}

// ---------- 工具 ----------
function wrapHarnessTool(tool: AgentHarnessTool<ExecutionToolContext>, ctx: ExecutionToolContext): AgentTool {
  return {
    name: tool.name, label: tool.label, description: tool.description,
    parameters: tool.parameters, constrainedSampling: tool.constrainedSampling,
    prepareArguments: tool.prepareArguments, executionMode: tool.executionMode,
    execute: (id, params, signal, onUpdate) => tool.execute(id, params, signal, onUpdate, ctx),
  };
}

function createLoadSkillToolLocal(skills: Skill[]): AgentTool {
  return {
    name: "load_skill",
    label: "load_skill",
    description: "加载一个技能的完整说明和文件清单。当任务匹配系统提示词里列出的某个技能时，调用此工具加载该技能的 SKILL.md 全文和目录下的参考文件列表。支持 references 参数一次性附带参考文件全文。加载后按 SKILL.md 的工作流步骤执行。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "要加载的技能名称" },
        references: { type: "array", items: { type: "string" }, description: "可选：同时附带读取的参考文件相对路径（如 references/card-types.md），省得后续再 read" },
      },
      required: ["name"], additionalProperties: false,
    } as any,
    async execute(_id, params) {
      const skill = skills.find((s) => s.name === params.name);
      if (!skill) return { content: [{ type: "text", text: `技能 "${params.name}" 不存在。可用：${skills.map(s => s.name).join(", ")}` }], details: undefined };
      const hostDir = resolve("skills", skill.name);
      const skillDir = dirname(skill.filePath);
      const files: string[] = [];
      async function walk(d: string) {
        let entries;
        try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (files.length >= 20) return;
          const full = join(d, e.name);
          if (e.isDirectory()) {
            if (e.name.startsWith(".") || e.name === "__pycache__") continue;
            await walk(full);
          } else if (e.isFile()) {
            if (e.name === "SKILL.md" || e.name.startsWith(".")) continue;
            files.push(relative(hostDir, full));
          }
        }
      }
      await walk(hostDir);
      const { readFile: rf } = await import("node:fs/promises");
      const lines = [`<skill_content name="${skill.name}">`, "", skill.content.trim(), "",
        `技能目录：${skillDir}/`, "用 read 工具读这些文件，用 bash 工具运行脚本。", ""];
      if (files.length > 0) {
        lines.push("目录下的参考文件（按需读取）：");
        for (const f of files) lines.push(`- ${f}`);
      }
      // 附带参考文件全文
      if (Array.isArray(params.references) && params.references.length > 0) {
        lines.push("", "--- 附带参考文件全文 ---");
        for (const relPath of params.references.slice(0, 5)) {
          const normalized = String(relPath).replace(/^\.?\//, "").replace(/\.\./g, "");
          const hostPath = join(hostDir, normalized);
          try {
            const content = await rf(hostPath, "utf8");
            lines.push("", `=== ${normalized} ===`, content.trim());
          } catch {
            lines.push("", `=== ${normalized} ===`, `（读取失败，用 read 手动读 skills/${skill.name}/${normalized}）`);
          }
        }
      }
      lines.push("</skill_content>");
      return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
    },
  };
}

function createSendMessageToolStub(): AgentTool {
  return {
    name: "send_message",
    label: "send_message",
    description: "发送消息给用户。把完整回复一次性发出去。",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } as any,
    async execute(_id, params) {
      const text = String(params.text);
      console.log(`\n📤 [send_message] ${text.slice(0, 300)}${text.length > 300 ? "..." : ""}\n`);
      return { content: [{ type: "text", text: "消息已发送。" }], details: undefined };
    },
  };
}

// ---------- 主流程 ----------
const VARIANT = process.argv[2] ?? "current";
console.log(`=== 制卡链路计时基准（变体: ${VARIANT}）===\n`);

const tmpWs = await mkdtemp(join(tmpdir(), "arkham-bench-"));
console.log(`工作目录: ${tmpWs}`);

await mkdir(join(tmpWs, "cards", "in"), { recursive: true });
await mkdir(join(tmpWs, "cards", "out"), { recursive: true });
await mkdir(join(tmpWs, ".arkham"), { recursive: true });
// symlink 让 agent 在 cwd 内能读到 skills/assets
try { await symlink(resolve("skills"), join(tmpWs, "skills")); } catch {}
try { await symlink(resolve(ARKHAM_WORKSHOP_DIR, "assets"), join(tmpWs, ".arkham", "assets")); } catch {}
const cliCandidates = [
  resolve(ARKHAM_WORKSHOP_DIR, "target/release/arkham-cli"),
  resolve(ARKHAM_WORKSHOP_DIR, "target/debug/arkham-cli"),
];
for (const c of cliCandidates) {
  if (existsSync(c)) {
    await mkdir(join(tmpWs, ".arkham", "bin"), { recursive: true });
    try { await symlink(c, join(tmpWs, ".arkham", "bin", "arkham-cli")); } catch {}
    console.log(`arkham-cli: ${c}`);
    break;
  }
}

const { skills } = await loadSkillsFromDir(resolve("skills"));
console.log(`加载技能: ${skills.map(s => s.name).join(", ")}`);

const env = new NodeExecutionEnv({ cwd: tmpWs });
const ctx: ExecutionToolContext = { env };
const tools: AgentTool[] = [
  createRestrictedBashTool(env),
  ...[createReadTool(), createWriteTool(), createEditTool()].map(t => wrapHarnessTool(t, ctx)),
  createSendMessageToolStub(),
  createLoadSkillToolLocal(skills),
];

const systemPrompt = buildSystemPrompt({
  scopeName: "benchmark", scopeKind: "user",
  recentMessageCount: 0,
  skillsBlock: formatSkillsForSystemPrompt(skills),
  tools,
});

const { models, model } = buildModel();

// 非流式桥接（OpenAI 端点用非流式，绕过流式 bug）
import { createNonStreamStreamFn } from "../src/non-stream-bridge.ts";
const streamFn = createNonStreamStreamFn((m: any, context: any, options?: any) =>
  models.streamSimple(m, context, { ...options, timeoutMs: 120_000, maxRetries: 3, maxRetryDelayMs: 8_000 })
);

const agent = new Agent({
  initialState: { systemPrompt, model, tools, messages: [] },
  streamFn,
});

// ---------- 计时 ----------
interface RoundInfo { start: number; llmMs: number; tools: { name: string; input: string }[]; text?: string; }
const rounds: RoundInfo[] = [];
let current: RoundInfo | null = null;
let runStart = 0;
let lastRoundEnd = 0;
let assistantRoundCount = 0;

agent.subscribe((event: AgentEvent) => {
  const e = event as any;
  const now = Date.now();
  if (e.type === "agent_start") {
    runStart = now;
    lastRoundEnd = now;
  } else if (e.type === "message_start") {
    const msg = e.message;
    if (msg && msg.role === "assistant") {
      current = { start: lastRoundEnd, llmMs: 0, tools: [] };
    }
  } else if (e.type === "message_end") {
    const msg = e.message;
    if (msg && msg.role === "assistant" && current) {
      current.llmMs = now - current.start;
      lastRoundEnd = now;
      if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (c.type === "toolCall") {
            const argsStr = JSON.stringify(c.arguments ?? c.args ?? c.input ?? {});
            current.tools.push({ name: c.name, input: (argsStr ?? "{}").slice(0, 80) });
          } else if (c.type === "text" && c.text) {
            current.text = c.text;
          }
        }
      }
      rounds.push(current);
      assistantRoundCount++;
      const toolStr = current.tools.length
        ? ` → ${current.tools.map(t => `${t.name}`).join(",")}`
        : " → (最终回复)";
      console.log(`  [T+${now - runStart}ms] 轮 ${assistantRoundCount}: ${current.llmMs}ms${toolStr}`);
      if (current.tools.length > 0) {
        for (const t of current.tools) {
          console.log(`          🔧 ${t.name}(${t.input})`);
        }
      } else if (current.text) {
        console.log(`          💬 ${current.text.slice(0, 120).replace(/\n/g, " ")}`);
      }
      current = null;
    }
  } else if (e.type === "tool_execution_start") {
    console.log(`          ⏳ 开始执行 ${e.toolName}`);
  } else if (e.type === "tool_execution_end") {
    console.log(`          ✅ ${e.toolName} 完成 (T+${now - runStart}ms)`);
  } else if (e.type === "agent_end") {
    console.log(`  [T+${now - runStart}ms] agent 结束 (消息数: ${e.messages?.length ?? 0})\n`);
  } else if (e.type === "message_start") {
    const msg = e.message;
    console.log(`          [message_start] role=${msg?.role} stop=${msg?.stopReason ?? "-"} blocks=${Array.isArray(msg?.content) ? msg.content.length : 0}`);
  } else if (e.type === "message_update") {
    const msg = e.message;
    if (msg && msg.stopReason && msg.stopReason !== "toolCall") {
      console.log(`          ℹ️ stopReason=${msg.stopReason}`);
    }
  }
});

const cardRequest = `做一张牌，名称泽耶尔·戴，职介守卫者，属性4143，血8san6
漂泊者 天选
能力为：
你以溺于夜色之中在弃牌堆开始游戏。
<反应>补给阶段开始时：你可以放弃摸牌和获得资源，改为查找弃牌堆底三张牌，抽取其中一张非弱点牌。
旧印：+1，你可以将弃牌堆中最多三张牌以任意顺序放到弃牌堆底。

牌组数量：25
牌组构筑选项：守卫者卡牌等级0-5，资源花费为0的牌等级0，中立卡牌等级0-5。
牌组构筑需求（不计入牌组数量）：泽耶尔的家传吊坠，无月夜的祝福，溺于夜色之中，随机基础弱点。`;

console.log(`用户请求：\n${cardRequest.slice(0, 100)}...\n`);
console.log(`--- 开始计时 ---`);

const t0 = Date.now();
// Monkey-patch console to capture the real stack
const origErr = console.error;
try {
  await agent.prompt(cardRequest);
} catch (err) {
  console.error("agent.prompt 抛出:", err);
}
const totalMs = Date.now() - t0;

// 检查最终消息状态
const finalMessages = agent.state.messages;
console.log(`\n[debug] 最终消息数: ${finalMessages.length}`);
for (let i = 0; i < finalMessages.length; i++) {
  const m: any = finalMessages[i];
  const contentPreview = Array.isArray(m.content)
    ? m.content.map((c: any) => {
        if (c.type === "text") return `text:${c.text.slice(0,60)}`;
        if (c.type === "toolCall") { const a = JSON.stringify(c.arguments ?? c.args ?? c.input ?? {}); return `toolCall:${c.name}(${(a ?? "").slice(0,60)})`; }
        if (c.type === "thinking") return `thinking:${(c.thinking ?? "").slice(0,30)}sig=${c.thinkingSignature ? "Y" : "N"}`;
        return c.type;
      }).join(" | ")
    : String(m.content).slice(0, 60);
  console.log(`  msg[${i}] role=${m.role} stop=${m.stopReason ?? "-"} content=[${contentPreview}]`);
  if (m.errorMessage) console.log(`        errorMessage: ${m.errorMessage}`);
}

console.log(`\n=== 结果 ===`);
console.log(`总耗时: ${(totalMs / 1000).toFixed(1)}s`);
console.log(`总轮数: ${rounds.length}`);
const llmTotal = rounds.reduce((s, r) => s + r.llmMs, 0);
const toolTotal = totalMs - llmTotal;
console.log(`LLM 累计: ${(llmTotal / 1000).toFixed(1)}s（${rounds.length} 轮 × 平均 ${(llmTotal / rounds.length / 1000).toFixed(1)}s）`);
console.log(`工具+间隙: ${(toolTotal / 1000).toFixed(1)}s`);
console.log(`\n每轮明细：`);
for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i];
  const toolsStr = r.tools.length ? r.tools.map(t => `${t.name}(${t.input})`).join("; ") : (r.text ? `💬 ${r.text.slice(0,60).replace(/\n/g," ")}` : "(空)");
  console.log(`  ${i + 1}. ${r.llmMs}ms  ${toolsStr}`);
}

// 检查输出
const outPng = join(tmpWs, "cards", "out", "000.png");
const cardFile = join(tmpWs, "cards", "in", "000.card");
console.log(`\n产出:`);
console.log(`  .card 存在: ${existsSync(cardFile)} ${existsSync(cardFile) ? `(${readFileSync(cardFile, "utf8").length} bytes)` : ""}`);
console.log(`  .png 存在: ${existsSync(outPng)}`);

await rm(tmpWs, { recursive: true, force: true }).catch(() => {});
process.exit(0);
