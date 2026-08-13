# QQ 官方机器人 C2C 私聊流式输出方案

> 目标：让机器人在 **单聊（C2C）** 场景下，把智能体的流式生成（含思考过程）以「同一条消息逐字更新」的形式输出，即 ChatGPT 式打字机效果。
>
> 适用范围：`@arkham/chatbot-im-qq`。结论是 QQ 官方**有原生流式接口**，仅 C2C 支持，群聊/频道不支持。

## 1. 结论速览

| 能力 | C2C 单聊 | 群聊 | 频道 |
|------|---------|------|------|
| 原生流式（`stream_messages`） | ✅ | ❌ | ❌ |
| 编辑已发送的普通消息 | ❌（仅可撤回，2 分钟内） | ❌ | ⚠️ 仅频道消息可 PATCH |
| Markdown 自定义消息 | ✅ 全开放 | ✅ 全开放 | 需内邀 |
| 被动消息有效期 | 60 分钟 | 5 分钟 | — |
| 单条消息被动回复次数 | 4 次 | 4 次 | — |

**核心：** QQ 官方提供了 `POST /v2/users/{user_openid}/stream_messages`，专为 LLM 流式回复设计。它不是「编辑普通消息」，而是一条**独立的流式消息**，通过 `stream_msg_id` 串联多个分片，在 `input_state=1` 时不断覆盖更新正文，`input_state=10` 时定稿。

## 2. 接口规范

### 2.1 基本信息

- **HTTP**：`POST /v2/users/{user_openid}/stream_messages`
- **鉴权**：与现有 openapi 一致，`Authorization: QQBot {access_token}`（复用 `QQClient.authedPost`）
- **域名**：`apiBase`（正式 `https://api.sgroup.qq.com` / 沙箱 `https://sandbox.api.sgroup.qq.com`）
- **频率限制**：**50 QPS**，超限返回错误码 `50002`
- **场景**：仅 C2C，群/频道调用会失败

### 2.2 请求参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `content_type` | string | 否 | `text` 或 `markdown`（默认 `text`）。智能体输出建议 `markdown` |
| `content_raw` | string | 否 | 本片正文内容 |
| `input_state` | integer | 否 | **1** = 生成中，**10** = 生成结束。末片必须为 10 |
| `input_mode` | string | 否 | `append`（默认，拼接到已下发内容）/ `replace`（全量正文） |
| `index` | integer | 否 | 分片序号，从 0 递增 |
| `stream_msg_id` | string | 否 | 流式消息 ID。**首片不传**（服务端生成并返回），续片/末片必须携带 |
| `msg_id` | string | 否 | 被动回复关联的用户消息 ID（与 `event_id` 二选一） |
| `event_id` | string | 否 | 被动回复事件 ID（与 `msg_id` 二选一） |
| `msg_seq` | integer | 否 | 消息序号，用于去重 |
| `is_wakeup` | boolean | 否 | `true` 时为召回消息，**不校验 `msg_id`/`event_id` 有效期**（用于越过被动窗口主动发起流式） |

> **`replace` 的前缀锁定**：`input_mode=replace` 时，传入正文必须以「上游已下发给用户的前缀」开头，否则返回 `40007 已下发内容前缀不可修改`。这是流式设计的关键约束——一旦下发了某段开头，后续只能在其后追加或整体替换（替换时仍要保留前缀）。

### 2.3 响应

```jsonc
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890", // stream_msg_id，首片后用于串联
  "timestamp": "2026-07-21T10:00:00+08:00",
  "ext_info": { "ref_idx": "REFIDX_xxxxxxxxxxxxxxx==" },
  "remain_msg_len": 3800 // 流式消息剩余可用长度（字符数）
}
```

### 2.4 生命周期：三段式

```
首片  index=0,  input_state=1                → 服务端生成并返回 stream_msg_id
续片  index=1..N, input_state=1              → 携带 stream_msg_id，正文逐步增长
末片  index=N+1, input_state=10              → 定稿正文，流式完结（必须发，否则不收尾）
```

请求体示例（`replace` + `markdown`）：

```jsonc
// 首片（不带 stream_msg_id）
{ "input_mode":"replace", "input_state":1, "index":0,
  "content_type":"markdown", "content_raw":"💭 正在思考...",
  "msg_id":"ROBOT1.0_xxx", "msg_seq":1 }

// 续片（携带首片返回的 stream_msg_id；replace 模式前缀 "💭 正在思考..." 保持不变）
{ "input_mode":"replace", "input_state":1, "index":1,
  "content_type":"markdown", "content_raw":"💭 正在思考...\n\n答案是：",
  "stream_msg_id":"a1b2c3d4-...", "msg_id":"ROBOT1.0_xxx" }

// 末片（input_state=10 定稿）
{ "input_mode":"replace", "input_state":10, "index":2,
  "content_type":"markdown", "content_raw":"💭 正在思考...\n\n答案是：42。",
  "stream_msg_id":"a1b2c3d4-...", "msg_id":"ROBOT1.0_xxx" }
```

### 2.5 错误码

| code | 含义 | 排查 |
|------|------|------|
| `40007` | 已下发内容前缀不可修改 | `replace` 模式下正文未以已下发前缀开头 |
| `50001` | 服务内部错误 | 稍后重试 |
| `50002` | 频率限制 | 降低调用频率（>50 QPS） |
| `11244` | access_token 过期 | 复用 `QQClient` 的自动刷新逻辑 |

## 3. 智能体「思考内容」的呈现

QQ 自定义 Markdown 支持子集：标题（仅一/二级）、加粗/斜体/删除线、链接、列表、引用、分割线。**不支持代码块、表格**（发了报 `40034011`，这是现有 `sendMarkdown` 已踩过的坑）。

推荐两种呈现策略，视产品形态二选一：

### 策略 A：思考与正文同框（推荐，适合短回复）

流式期间思考用 markdown 引用块呈现，正文跟在后面；生成结束后整体 `replace` 为最终版（思考可保留为引用折叠样式）。

```markdown
> 💭 思考：用户在问 X，我需要先确认 Y……

**回答**
正文内容……
```

- 流式期 `content_raw` 逐步变长：`> 💭 思考：...` → `> 💭 思考：...\n\n**回答**\n正...` → ... → 末片定稿
- 因为前缀 `> 💭 ` 不变，`replace` 不会触发 `40007`

### 策略 B：思考阶段流式，定稿时替换为纯答案（适合长回复 / 不想暴露思考）

- `input_state=1` 阶段：只输出 `正在生成回答，请稍候……`（或带思考的占位）
- `input_state=10` 末片：用 `replace` 把整条替换为最终答案。**前缀必须对齐**——所以首片下发的占位文本要是最终答案也会以它开头的串，或用一个固定引导语（如 `回答：`）做前缀，定稿时 `回答：xxxx` 完整替换。

> 思考内容来源：OpenAI 兼容接口的流式响应里，推理模型（DeepSeek-R1、Qwen-Reasoning 等）会先返回 `delta.reasoning_content`，再返回 `delta.content`。在 adapter 层把两者分别累积，reasoning 映射到思考块，content 映射到正文。

## 4. 限制与配额（C2C 单聊）

| 项目 | 规则 |
|------|------|
| 被动消息有效期 | **60 分钟**（用户发消息后 60 分钟内可凭 `msg_id` 被动回复） |
| 单条用户消息被动回复次数 | **4 次**（含流式首片及普通回复，超额失败） |
| 主动消息配额（每用户/天） | **2 条** |
| 主动消息配额（全机器人/天） | **200 条** |
| 撤回时限 | 2 分钟内 |
| 流式接口 QPS | 50 |

**对智能体流式的影响**：
- 流式分片共享同一个 `msg_id`，**只算作对该 `msg_id` 的一次被动回复**（首片携带 `msg_id`，续片/末片不再消耗回复次数——以官方为准，建议压测确认）。
- 想在用户没发消息时主动推送流式结果：用 `is_wakeup=true`，但会消耗主动消息配额。
- 群聊做不了原生流式——群场景的智能体输出仍走现有「分段发送」或「撤回重发」折中方案。

## 5. 在本项目的落地方案

### 5.1 代码草案：`StreamSession`（对齐现有 `QQClient` 风格）

建议在 `packages/im-qq/src/client.ts` 新增流式方法，封装成 `StreamSession` 状态机，隐藏 `stream_msg_id`/`index`/`input_state` 的管理：

```ts
/** 流式消息分片请求体（stream_messages 接口）。 */
interface StreamMessagePayload {
	content_type?: "text" | "markdown";
	content_raw?: string;
	input_state?: 1 | 10;
	input_mode?: "append" | "replace";
	index?: number;
	stream_msg_id?: string;
	msg_id?: string;
	event_id?: string;
	msg_seq?: number;
	is_wakeup?: boolean;
}

/** stream_messages 响应。 */
interface StreamMessageResult {
	id: string; // stream_msg_id
	timestamp: string;
	ext_info?: { ref_idx?: string };
	remain_msg_len?: number;
}

/**
 * C2C 流式消息会话：封装首片/续片/末片的状态流转。
 *
 * 用法：
 *   const session = await client.startStream(userTarget(openid), {
 *     msgId, content: "💭 正在思考...", contentType: "markdown"
 *   });
 *   for await (const chunk of llmStream) {
 *     await session.replace(session.prefix + accumulated); // replace 模式：保留前缀
 *   }
 *   await session.finish(finalText); // input_state=10
 *
 * 注意：
 * - 仅 C2C（user scope）。group scope 调用会失败，需在调用前拦截降级。
 * - replace 模式下 content_raw 必须以已下发前缀开头，否则 40007。
 * - 末片必须发（finish），否则流式消息无法收尾，用户端会一直停留在最后一片。
 */
export class StreamSession {
	private index = 0;
	private streamMsgId: string | undefined;
	/** 已下发给用户的内容前缀（replace 模式必须以此为开头）。 */
	readonly prefix: string;

	constructor(
		private readonly post: (body: StreamMessagePayload) => Promise<StreamMessageResult>,
		private readonly userOpenid: string,
		opts: { msgId?: string; eventId?: string; content: string; contentType?: "text" | "markdown"; isWakeup?: boolean; msgSeq?: number },
		firstResult: StreamMessageResult,
	) {
		this.prefix = opts.content;
		this.streamMsgId = firstResult.id;
		void userOpenid; // 仅用于语义标注，实际请求由 post 闭包绑定 scope
	}

	/** 续片：input_state=1，index 递增，必须以 prefix 开头。 */
	async replace(content: string): Promise<StreamMessageResult> {
		if (!content.startsWith(this.prefix)) {
			throw new Error(
				`stream replace 前缀不一致（期望以 ${JSON.stringify(this.prefix.slice(0, 20))}… 开头），将触发 40007`,
			);
		}
		return this.send({ content_raw: content, input_state: 1, input_mode: "replace" });
	}

	/** 续片：append 模式，仅传增量（无需关心前缀）。 */
	async append(delta: string): Promise<StreamMessageResult> {
		return this.send({ content_raw: delta, input_state: 1, input_mode: "append" });
	}

	/** 末片：input_state=10，定稿。content 为最终全量正文（仍需以 prefix 开头）。 */
	async finish(content: string): Promise<StreamMessageResult> {
		if (!content.startsWith(this.prefix)) {
			// 末片前缀不一致时，安全兜底：改用 append 追加差异，再发空 content 的 state=10。
			console.warn("[qq-stream] 末片前缀不一致，降级为 append+空收尾");
			await this.send({ content_raw: "", input_state: 10, input_mode: "append" });
			return { id: this.streamMsgId!, timestamp: new Date().toISOString() };
		}
		return this.send({ content_raw: content, input_state: 10, input_mode: "replace" });
	}

	private async send(partial: Omit<StreamMessagePayload, "index" | "stream_msg_id">): Promise<StreamMessageResult> {
		const res = await this.post({
			...partial,
			index: ++this.index,
			stream_msg_id: this.streamMsgId,
		});
		// 续片/末片理论上不再变更 stream_msg_id，但若服务端返回新 id 则更新。
		if (res?.id) this.streamMsgId = res.id;
		return res;
	}
}
```

在 `QQClient` 上增加入口（复用 `authedPost`、`userTarget`、`msgSeq`）：

```ts
export interface QQClient {
	/** 开启一条 C2C 流式消息（首片）。仅 user scope 有效。 */
	startStream(
		scope: ScopeTarget,
		opts: { msgId?: string; eventId?: string; content: string; contentType?: "text" | "markdown"; isWakeup?: boolean },
	): Promise<StreamSession>;
}

// 实现
async startStream(scope: ScopeTarget, opts: { msgId?: string; eventId?: string; content: string; contentType?: "text" | "markdown"; isWakeup?: boolean }): Promise<StreamSession> {
	if (scope.kind !== "user") {
		throw new Error("stream_messages 仅支持 C2C（user scope），群聊请走分段发送降级");
	}
	const post = (body: StreamMessagePayload) =>
		this.authedPost(`${scope.path}/stream_messages`, { ...body, msg_seq: ++this.msgSeq })
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`stream_messages failed: ${res.status}`)))) as Promise<StreamMessageResult>;
	const first = await post({
		input_mode: "replace",
		input_state: 1,
		index: 0,
		content_type: opts.contentType ?? "markdown",
		content_raw: opts.content,
		msg_id: opts.msgId,
		event_id: opts.eventId,
		is_wakeup: opts.isWakeup,
	});
	return new StreamSession(post, scope.openid, { ...opts, msgSeq: this.msgSeq }, first);
}
```

### 5.2 节流与降级

- **节流**：LLM token 流往往远快于 50 QPS。建议在 adapter 层做合并刷新（如每 80~120ms 或每累积 1~2 句刷新一次），避免触发 `50002`，也降低用户端闪烁感。
- **降级到普通 markdown**：流式接口不可用（`50001`/网络错误）或 scope 是群聊时，退回现有 `sendMarkdown`，把最终正文整条发出。
- **超长内容**：关注响应里的 `remain_msg_len`，接近 0 时提前 `finish`，剩余内容新开一条流式或普通消息。
- **异常断流**：若中途异常未发末片，用户端会停留在最后一帧。务必在 `finally` 里发一次 `finish`（即便内容不变）保证收尾。

### 5.3 接入智能体流

在 adapter 层把上游（`@arkham/chatbot-core` 的智能体）的输出接到 `StreamSession`：

```ts
const session = await client.startStream(userTarget(userOpenid), {
	msgId,
	content: "💭 正在思考…",
	contentType: "markdown",
});

let reasoning = "";
let answer = "";
const prefix = "💭 正在思考…";

for await (const delta of agent.run(userMessage)) {
	if (delta.reasoning_content) reasoning += delta.reasoning_content;
	if (delta.content) answer += delta.content;
	// 同框策略：思考 + 已生成的正文，replace 保留 prefix
	const snapshot = prefix + (reasoning ? `\n\n> 💭 ${reasoning.slice(-200)}` : "") + (answer ? `\n\n${answer}` : "");
	await throttledReplace(session, snapshot); // 节流后的 replace
}

await session.finish(prefix + (answer ? `\n\n${answer}` : "（无内容）"));
```

## 6. 待确认项（建议压测）

以下点官方文档示例未明确，落地时建议用沙箱压测确认，再固化到代码：

1. **流式分片与被动回复次数**：多片流式是否只占 1 次被动回复配额（推测是，但需确认）。
2. **`msg_seq` 在分片间的取值**：官方示例始终为 `1`。现有 `sendMessage` 是每次 `++msgSeq` 去重——流式分片是否需要递增 `msg_seq`，还是靠 `index` 去重，需压测。
3. **`remain_msg_len` 阈值**：超长回复的精确截断行为。
4. **审核态**：流式首片命中审核（`message_audit`）时的响应结构是否与普通消息一致。

## 7. 参考

- [流式发送单聊消息 | QQ 机器人官方文档](https://bot.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)
- [发送单聊消息（被动/主动规则）](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)
- [撤回单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages_message_id.delete.html)
- [Markdown 消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html)
- [消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)
- 开源参考实现：
  - [chnak/qq-bot](https://github.com/chnak/qq-bot)（声明「私聊流式消息（打字机效果）- 仅 C2C 私聊有效」）
  - [OpenClaw QQ 接入](https://openclaw.zhcndoc.com/channels/qqbot)（`streaming.nativeTransport` 配置项）
  - [OpenClaw QQ 配置文档](https://github.com/BytePioneer-AI/openclaw-china/blob/main/doc/guides/qqbot/configuration.md)
