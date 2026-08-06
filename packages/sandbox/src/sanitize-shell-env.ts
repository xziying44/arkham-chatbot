/**
 * 沙箱 shell 环境变量净化。
 *
 * 背景：BwrapExecutionEnv / NodeExecutionEnv 默认把宿主机 process.env 全量
 * 传给沙箱子进程。命令护栏（command-guard）只是正则拦截，可被绕过
 * （如 `awk 'BEGIN{print ENVIRON["MINIMAX_API_KEY"]}'`、`cat /proc/self/environ`），
 * 而 agent 拿到 key 后无需网络即可经 send_message 发到 QQ 群——群聊场景下
 * 提示注入来自不可信群员，这是真实泄露路径。
 *
 * 所以这里从物理上把敏感变量从子进程环境中剔除（纵深防御的根治层），
 * 护栏正则继续作为第二层。
 */

/** 敏感环境变量名模式：命中即从沙箱子进程环境中剔除。 */
const SENSITIVE_ENV_KEY = /(_API_KEY|_AUTH_TOKEN|_SECRET|_TOKEN|_PASSWORD|APP_SECRET)$/i;

/**
 * 返回剔除敏感变量后的环境副本。保留 PATH/HOME/LANG 等运行必需项
 * （arkham-cli 等沙箱内程序需要）。
 */
export function sanitizeShellEnv(
	base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (SENSITIVE_ENV_KEY.test(key) || value === undefined) continue;
		out[key] = value;
	}
	return out;
}
