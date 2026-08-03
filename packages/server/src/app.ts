import { type Model, type Models, type Provider, createModels, createProvider } from "@earendil-works/pi-ai";
import * as builtinProviders from "@earendil-works/pi-ai/providers/all";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { SessionManager, createSendImageTool } from "@arkham/chatbot-core";
import { createExecutionEnv } from "@arkham/chatbot-sandbox";
import { QQAdapter } from "@arkham/chatbot-im-qq";
import type { ImAdapter } from "@arkham/chatbot-im-core";
import { createMessageRouter } from "./message-router.ts";
import { loadConfig, type AppConfig } from "./config.ts";

/**
 * 应用启动入口：把所有部件装配成一个可运行的服务。
 *
 *   读配置 → 建 Models（注册内置 provider）→ 解析模型
 *   → 建 SessionManager（注入 envFactory + streamFn）
 *   → 建 QQAdapter → 订阅 router → 连接 → 等待信号
 */
export async function startApp(): Promise<{ shutdown: () => Promise<void> }> {
	const config = loadConfig();
	const { models, model } = buildModels(config);

	// 先建 adapter，再建 sessions：sessions 的 send_image 工具需要引用 adapter 发图。
	const adapter: ImAdapter = new QQAdapter({
		appId: config.qq.appId,
		appSecret: config.qq.appSecret,
		apiBase: config.qq.apiBase,
	});

	const sessions = new SessionManager({
		dataDir: config.dataDir,
		model,
		models,
		streamFn: models.streamSimple.bind(models),
		envFactory: (_scope, workspaceDir) =>
			createExecutionEnv({
				enabled: config.sandbox.enabled,
				cwd: workspaceDir,
				networkDisabled: config.sandbox.networkDisabled,
				timeoutSeconds: config.sandbox.timeoutSeconds,
			}),
		ttlMs: config.session.ttlMs,
		reaperIntervalMs: config.session.reaperIntervalMs,
		persona: config.persona,
		// 给每个 scope 注入 send_image 工具：通过当前 adapter 把本地图片发到该 scope。
		extraToolsFactory: (scope) => [
			createSendImageTool({
				scopeId: scope.id,
				send: async (scopeId, filePath) => {
					const scopeKey = { kind: scope.kind, id: scopeId };
					await adapter.sendImage(scopeKey, filePath);
				},
			}),
		],
	});
	sessions.start();

	const router = createMessageRouter({ adapter, sessions });
	adapter.subscribe(router);

	await adapter.connect();
	console.info(`[app] connected; model=${model.provider}/${model.id}; data=${config.dataDir}`);

	const shutdown = async () => {
		console.info("[app] shutting down...");
		await adapter.disconnect().catch(() => {});
		await sessions.shutdown().catch(() => {});
	};
	return { shutdown };
}

/**
 * 创建 Models 实例并注册 provider：
 * - 注册全部内置 provider（Anthropic 官方/OpenAI/DeepSeek/...）。
 * - 当配置了自定义 Anthropic 兼容端点（ANTHROPIC_BASE_URL，如智谱）时，
 *   用该端点重建 anthropic provider，并把 CHATBOT_MODEL 指定的模型注册进去。
 * 返回解析好的 Model 对象。
 */
export function buildModels(config: AppConfig): { models: Models; model: Model<any> } {
	const models = createModels();
	for (const provider of builtinProviders.builtinProviders()) {
		(models as ReturnType<typeof createModels>).setProvider(provider);
	}

	// 自定义 Anthropic 兼容端点：重建 anthropic provider，注册指定模型。
	if (config.llm.anthropicBaseUrl) {
		const { provider: providerId, modelId } = parseModelSpec(config.model);
		if (providerId === "anthropic") {
			const base = anthropicProvider();
			const customModel: Model<"anthropic-messages"> = {
				id: modelId,
				name: modelId,
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: config.llm.anthropicBaseUrl,
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 4096,
			};
			const customProvider: Provider<"anthropic-messages"> = createProvider({
				id: "anthropic",
				name: "Anthropic (custom endpoint)",
				baseUrl: config.llm.anthropicBaseUrl,
				auth: base.auth,
				models: [customModel],
				api: anthropicMessagesApi(),
			});
			(models as ReturnType<typeof createModels>).setProvider(customProvider);
		}
	}

	const model = resolveModel(models, config.model);
	return { models, model };
}

/** 解析 `provider/model` 形式的模型字符串为 { provider, modelId }。 */
function parseModelSpec(spec: string): { provider: string; modelId: string } {
	const slash = spec.indexOf("/");
	if (slash <= 0) {
		throw new Error(`Invalid CHATBOT_MODEL "${spec}", expected "<provider>/<model-id>"`);
	}
	return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/** 解析 `provider/model` 形式的模型字符串为 Model 对象。 */
function resolveModel(models: Models, spec: string): Model<any> {
	const { provider, modelId } = parseModelSpec(spec);
	const model = models.getModel(provider, modelId);
	if (!model) {
		const available = models.getModels(provider).map((m) => m.id).slice(0, 20).join(", ");
		throw new Error(`Model not found: ${spec}. Available in ${provider}: ${available || "(none)"}`);
	}
	return model;
}
