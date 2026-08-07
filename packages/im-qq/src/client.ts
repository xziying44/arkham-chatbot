import type {
	AccessTokenResponse,
	FileType,
	FileUploadResult,
	KeyboardPayload,
	MessageAuditResult,
	SendMessageResult,
	WsGatewayInfo,
} from "./types.ts";

/** 发消息响应：普通返回 id/timestamp，命中审核返回 message_audit。 */
export type SendOutcome = SendMessageResult | MessageAuditResult;

/**
 * 消息发送目标：封装 scope 类型与 openid，自动映射到 /v2/groups 或 /v2/users 路径。
 * 所有发送/上传方法接收此对象，避免 group/c2c 各写一套。
 */
export interface ScopeTarget {
	readonly kind: "group" | "user";
	readonly openid: string;
	/** 已拼好的路径前缀，如 /v2/groups/xxx 或 /v2/users/xxx。 */
	readonly path: string;
}

/** 构造群 scope 目标。 */
export function groupTarget(groupOpenid: string): ScopeTarget {
	return { kind: "group", openid: groupOpenid, path: `/v2/groups/${groupOpenid}` };
}

/** 构造 C2C scope 目标。 */
export function userTarget(userOpenid: string): ScopeTarget {
	return { kind: "user", openid: userOpenid, path: `/v2/users/${userOpenid}` };
}

/**
 * QQ openapi 客户端：负责 access_token 的获取与自动刷新，以及 HTTPS openapi 调用
 * （获取 gateway 地址、发送群/C2C 消息）。
 *
 * access_token 由 AppID + AppSecret 换取，有效期由 expires_in 决定（秒）。
 * 这里提前 60s 预刷新，避免临界过期。
 */
export interface QQClientOptions {
	readonly appId: string;
	readonly appSecret: string;
	/** 正式: https://api.sgroup.qq.com  沙箱: https://sandbox.api.sgroup.qq.com */
	readonly apiBase: string;
	/** HTTPS 请求超时（毫秒），默认 10s。 */
	readonly timeoutMs?: number;
}

const REFRESH_LEAD_TIME_S = 60;
const ACCESS_TOKEN_EXPIRED_CODE = 11244;

export class QQClient {
	private readonly opts: Required<QQClientOptions>;
	private accessToken: string | undefined;
	private expiresAt: number = 0; // 秒级时间戳
	/**
	 * 被动消息序号：QQ 要求 msg_id + msg_seq 配合，同一 msg_id 下 msg_seq 递增才能发多条
	 * （否则报 40054005 消息被去重）。这里全局递增，保证每次发送的 msg_seq 唯一。
	 */
	private msgSeq = 0;
	private refreshPromise: Promise<string> | undefined;

	constructor(opts: QQClientOptions) {
		this.opts = {
			appId: opts.appId,
			appSecret: opts.appSecret,
			apiBase: opts.apiBase.replace(/\/+$/, ""),
			timeoutMs: opts.timeoutMs ?? 10_000,
		};
	}

	/** AppID（管理端展示用）。 */
	get appId(): string {
		return this.opts.appId;
	}

	/** access_token 过期时间（秒级 Unix 时间戳），未获取过为 0。 */
	get tokenExpiresAt(): number {
		return this.expiresAt;
	}

	/** 当前累计发送序号（msg_seq 计数器）。 */
	get sentCount(): number {
		return this.msgSeq;
	}

	/** 取一个未过期的 access_token，必要时刷新。并发刷新只发一次。 */
	async getAccessToken(): Promise<string> {
		const now = Math.floor(Date.now() / 1000);
		if (this.accessToken && now < this.expiresAt - REFRESH_LEAD_TIME_S) {
			return this.accessToken;
		}
		if (!this.refreshPromise) {
			this.refreshPromise = this.fetchAccessToken().finally(() => {
				this.refreshPromise = undefined;
			});
		}
		return this.refreshPromise;
	}

	private async fetchAccessToken(): Promise<string> {
		// 注意：getAppAccessToken 必须打到 bots.qq.com，而非业务 apiBase（api.sgroup.qq.com）。
		// 域名分层是 QQ API v2 的设计：凭证端点与 openapi 端点分离。
		const url = "https://bots.qq.com/app/getAppAccessToken";
		const body = { appId: this.opts.appId, clientSecret: this.opts.appSecret };
		const res = await this.fetchWithTimeout(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(`getAppAccessToken failed: ${res.status} ${await res.text()}`);
		}
		const data = (await res.json()) as AccessTokenResponse;
		const expiresIn = Number(data.expires_in);
		if (typeof data.access_token !== "string" || data.access_token.length === 0) {
			throw new Error("QQ access_token 响应缺少有效令牌");
		}
		if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
			throw new Error("QQ access_token 响应的有效期无效");
		}
		this.accessToken = data.access_token;
		this.expiresAt = Math.floor(Date.now() / 1000) + Math.floor(expiresIn);
		return data.access_token;
	}

	/** 获取 WebSocket gateway 地址。 */
	async getGateway(): Promise<WsGatewayInfo> {
		const res = await this.authedGet("/gateway");
		if (!res.ok) {
			throw new Error(`getGateway failed: ${res.status} ${await res.text()}`);
		}
		const data = (await res.json()) as WsGatewayInfo;
		return data;
	}

	/**
	 * 向某 scope（群或 C2C）发送自定义 Markdown 消息（msg_type=2）。
	 *
	 * QQ 的自由 markdown 已对群聊/单聊全开放（无需模板）。
	 * 关键：msg_type=2 时 content 必须为空，markdown 源文本放进 markdown.content 对象。
	 * 支持语法子集：标题（仅一级、二级）、加粗/斜体/删除线、链接、列表、引用、分割线。
	 * 不支持代码块、表格（发了会报 40034011）。
	 */
	async sendMarkdown(scope: ScopeTarget, content: string, msgId?: string): Promise<SendOutcome> {
		return this.sendMessage(scope, {
			msg_type: 2,
			msg_id: msgId,
			markdown: { content },
		});
	}

	/**
	 * 向某 scope 发送纯文本消息（msg_type=0）。Markdown 渲染失败或被拒时的兜底。
	 */
	async sendText(scope: ScopeTarget, content: string, msgId?: string): Promise<SendOutcome> {
		return this.sendMessage(scope, { content, msg_type: 0, msg_id: msgId });
	}

	/**
	 * 发送带内嵌按钮的消息（markdown 正文 + keyboard）。
	 * 自定义 keyboard 已对群聊/单聊开放（需机器人在白名单，否则报权限错误）。
	 * 用户点击回调按钮（action.type=1）后触发 INTERACTION_CREATE 事件，
	 * 机器人须 3 秒内 PUT /interactions/{id} 应答。
	 */
	async sendKeyboard(scope: ScopeTarget, content: string, keyboard: KeyboardPayload, msgId?: string): Promise<SendOutcome> {
		return this.sendMessage(scope, {
			msg_type: 2,
			msg_id: msgId,
			markdown: { content },
			keyboard,
		});
	}

	/**
	 * 应答交互事件（PUT /interactions/{interaction_id}）。
	 * 收到 INTERACTION_CREATE 后须在 3 秒内调用，否则用户端一直转圈 loading。
	 * 同一 interaction_id 只能应答一次。
	 * @param interactionId 事件 id（InteractionData.id）
	 * @param code 回调结果：0=成功 1=失败 2=太频繁 3=重复操作 4=无权限 5=仅管理员
	 */
	async replyInteraction(interactionId: string, code: 0 | 1 | 2 | 3 | 4 | 5 = 0): Promise<void> {
		const res = await this.authedPut(`/interactions/${interactionId}`, { code });
		if (!res.ok) {
			throw new Error(`replyInteraction failed: ${res.status} ${await res.text()}`);
		}
	}

	/**
	 * 上传富媒体文件（本地 base64），返回 file_info。
	 * QQ 支持 file_data 字段传 base64 字符串（官方 Python SDK botpy#199 引入）。
	 * @param scope 目标 scope（决定 /groups/ 还是 /users/ 的 files 端点）
	 * @param fileType 1=图片
	 * @param fileData base64 编码的文件内容（不含 data: 前缀）
	 */
	async uploadFile(scope: ScopeTarget, fileType: FileType, fileData: string): Promise<string> {
		const res = await this.authedPost(`${scope.path}/files`, {
			file_type: fileType,
			file_data: fileData,
			srv_send_msg: false,
		});
		if (!res.ok) {
			throw new Error(`uploadFile(${scope.path}) failed: ${res.status} ${await res.text()}`);
		}
		const data = (await res.json()) as FileUploadResult;
		return data.file_info;
	}

	/**
	 * 用已上传的 file_info 发送富媒体消息（msg_type=7）。
	 */
	async sendMedia(scope: ScopeTarget, fileInfo: string, msgId?: string): Promise<SendOutcome> {
		return this.sendMessage(scope, {
			msg_type: 7,
			msg_id: msgId,
			media: { file_info: fileInfo },
		});
	}

	/** 上传本地图片并发送（uploadFile + sendMedia 的便捷组合）。 */
	async sendImageBase64(scope: ScopeTarget, fileData: string, msgId?: string): Promise<SendOutcome> {
		const fileInfo = await this.uploadFile(scope, 1, fileData);
		return this.sendMedia(scope, fileInfo, msgId);
	}

	/**
	 * 下载消息附件（用户发的图片等）为 Buffer。
	 * URL 是 QQ 推送的临时链接（multimedia.nt.qq.com.cn），需尽快下载。
	 * 先尝试不带鉴权直接下载（群消息附件 URL 通常可直接访问），
	 * 失败则带 access_token 重试。
	 */
	async downloadAttachment(url: string): Promise<Buffer> {
		// 先尝试不带鉴权
		const res = await this.fetchWithTimeout(url, { method: "GET" });
		if (res.ok) {
			return Buffer.from(await res.arrayBuffer());
		}
		// 失败则带 access_token 重试
		const token = await this.getAccessToken();
		const res2 = await this.fetchWithTimeout(url, {
			method: "GET",
			headers: { Authorization: `QQBot ${token}` },
		});
		if (!res2.ok) {
			throw new Error(`downloadAttachment failed: ${res2.status} ${await res2.text()}`);
		}
		return Buffer.from(await res2.arrayBuffer());
	}

	private async sendMessage(scope: ScopeTarget, payload: Record<string, unknown>): Promise<SendOutcome> {
		// 被动消息必须带 msg_seq（与 msg_id 配合），否则同 msg_id 重复发送会被去重（40054005）。
		const fullPayload = { ...payload, msg_seq: ++this.msgSeq };
		const res = await this.authedPost(`${scope.path}/messages`, fullPayload);
		if (!res.ok) {
			throw new Error(`sendMessage(${scope.path}) failed: ${res.status} ${await res.text()}`);
		}
		return (await res.json()) as SendOutcome;
	}

	private async authedGet(path: string): Promise<Response> {
		return this.authedRequest(path, {
			method: "GET",
		});
	}

	private async authedPost(path: string, body: unknown): Promise<Response> {
		return this.authedRequest(path, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
	}

	private async authedPut(path: string, body: unknown): Promise<Response> {
		return this.authedRequest(path, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
	}

	/** 鉴权请求遇到服务端判定令牌过期时，强制刷新并重试一次。 */
	private async authedRequest(path: string, init: RequestInit): Promise<Response> {
		let token = await this.getAccessToken();
		let res = await this.fetchAuthenticated(path, init, token);
		if (!(await this.isAccessTokenExpiredResponse(res))) return res;

		// 仅清除本次请求使用的旧令牌，避免覆盖其他并发请求刚刷新的新令牌。
		if (this.accessToken === token) {
			this.accessToken = undefined;
			this.expiresAt = 0;
		}
		console.warn("[qq-client] access_token 已失效，刷新后重试请求");
		token = await this.getAccessToken();
		res = await this.fetchAuthenticated(path, init, token);
		return res;
	}

	private fetchAuthenticated(path: string, init: RequestInit, token: string): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `QQBot ${token}`);
		return this.fetchWithTimeout(`${this.opts.apiBase}${path}`, { ...init, headers });
	}

	private async isAccessTokenExpiredResponse(res: Response): Promise<boolean> {
		if (res.ok) return false;
		try {
			const data = (await res.clone().json()) as { code?: unknown; err_code?: unknown };
			return Number(data.code) === ACCESS_TOKEN_EXPIRED_CODE || Number(data.err_code) === ACCESS_TOKEN_EXPIRED_CODE;
		} catch {
			return false;
		}
	}

	private fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
		return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
	}
}
