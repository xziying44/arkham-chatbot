import type { DatabaseSync } from "@arkham/chatbot-store";
import {
	BotRepository,
	SettingsRepository,
	SettingsKeys,
	type BotInsert,
} from "@arkham/chatbot-store";
import { hashPassword } from "@arkham/chatbot-admin-api";
import type { AppConfig } from "./config.ts";
import type { BotConfig } from "./bot-config.ts";
import { recordToConfig } from "./bot-manager.ts";

/**
 * 从 DB 读取所有机器人配置（转成驱动用的 BotConfig）。
 */
export function loadBotConfigs(db: DatabaseSync): BotConfig[] {
	const repo = new BotRepository(db);
	return repo.list().map(recordToConfig);
}

/**
 * 首次启动引导：当 DB 为空（无机器人记录）时，用 env 的默认值种一条默认机器人，
 * 并把 env 的 LLM/会话/沙箱/管理员配置写进 settings（作为默认值，后续可在管理端改）。
 *
 * 幂等：若 DB 已有数据则什么都不做。
 */
export function bootstrapIfEmpty(db: DatabaseSync, config: AppConfig): void {
	const botRepo = new BotRepository(db);
	const settings = new SettingsRepository(db);

	// LLM / 会话 / 沙箱默认值：始终写一次（已存在的不覆盖，保留用户在管理端的改动）。
	const defaults = {
		[SettingsKeys.llmModel]: config.model,
		[SettingsKeys.sessionTtlMs]: String(config.session.ttlMs),
		[SettingsKeys.sandboxEnabled]: String(config.sandbox.enabled),
		[SettingsKeys.sandboxNetworkDisabled]: String(config.sandbox.networkDisabled),
		[SettingsKeys.sandboxTimeoutSeconds]: String(config.sandbox.timeoutSeconds),
	};
	for (const [k, v] of Object.entries(defaults)) {
		if (settings.get(k) === undefined) settings.set(k, v);
	}
	if (config.llm.anthropicBaseUrl && settings.get(SettingsKeys.llmAnthropicBaseUrl) === undefined) {
		settings.set(SettingsKeys.llmAnthropicBaseUrl, config.llm.anthropicBaseUrl);
	}

	// 管理员账号：首次种一个。
	if (settings.get(SettingsKeys.adminUsername) === undefined) {
		const username = config.bootstrapAdmin.username;
		const password = config.bootstrapAdmin.password ?? "admin"; // 默认口令 admin，建议首次登录后改
		const { hash, salt } = hashPassword(password);
		settings.set(SettingsKeys.adminUsername, username);
		settings.set(SettingsKeys.adminPasswordHash, hash);
		settings.set(SettingsKeys.adminPasswordSalt, salt);
	}

	// 默认机器人：仅当有 QQ 凭证且 DB 无机器人时种。
	const existing = botRepo.list();
	if (existing.length === 0 && config.qq.appId && config.qq.appSecret) {
		const botId = config.qq.appId;
		const insert: BotInsert = {
			id: botId,
			appId: config.qq.appId,
			appSecret: config.qq.appSecret,
			name: `机器人 ${config.qq.appId}`,
			apiBase: config.qq.apiBase,
			persona: config.persona ?? null,
			enabled: true,
		};
		botRepo.insert(insert);
		console.log(`[bootstrap] 已用 env 凭证种入默认机器人 id=${botId}`);
	}
}
