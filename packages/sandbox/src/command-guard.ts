/**
 * 命令安全审查：在命令执行前做模式匹配拦截。
 *
 * 设计原则（纵深防御的一层，非唯一屏障）：
 * - 与 bwrap 的 `--unshare-net`（断网）+ `--ro-bind / /`（系统只读）+ send_image 的
 *   realpath 边界 + scopeId 绑定配合，共同构成多层防御。
 * - 这里拦的是**泄露性/逃逸性**命令：把数据外发、读本机敏感文件/环境变量、
 *   探测主机身份信息（IP/主机名/用户）、读取凭证、提权/反序列化逃逸等。
 * - 放行正常的"干活"命令：在工作目录内 ls/cat/edit、运行编程语言、文本处理等。
 *
 * 局限：shell 是图灵完备的，任何基于模式匹配的审查都可能被构造性绕过
 * （变量拼接、base64、eval、here-doc 等）。因此**不能只靠它**——
 * 沙箱断网才是封死"数据外发"的硬墙，这里负责抬高成本 + 拦住最常见的低门槛尝试。
 */

export interface GuardDecision {
	readonly allowed: boolean;
	/** 拒绝时的原因（展示给 agent）。 */
	readonly reason?: string;
}

/** 禁止的网络外发/下载命令（即使沙箱断网，也提前拦掉，避免 DNS/连接信息泄露）。 */
const NETWORK_PATTERNS: readonly RegExp[] = [
	/\bcurl\b/,
	/\bwget\b/,
	/\bnc\b/,
	/\bnetcat\b/,
	/\bsocat\b/,
	/\bssh\b/,
	/\bscp\b/,
	/\bsftp\b/,
	/\brsync\b/,
	/\btelnet\b/,
	/\bftp\b/,
	/\bngrok\b/,
	/\bpython\d?\s+-m\s+(http|web|socketserver|smtpd|xmlrpc)/i,
	/\bruby\s+-run\s+-e\s+http/i,
	/\bnode\s+-e\s+.*require\s*\(\s*['"]net['"]/, // node 直起网络
	/\bphp\s+-S\b/, // php 内建 server
	/\/dev\/tcp/, // bash 内建 tcp
	/\/dev\/udp/,
];

/** 禁止的主机信息探测命令（防泄露 IP/主机名/系统信息）。 */
const RECON_PATTERNS: readonly RegExp[] = [
	/\bifconfig\b/,
	/\bip\s+(addr|route|link)\b/,
	/\bhostname\b/,
	/\buname\b/,
	/\bwhoami\b/,
	/\bid\b/,
	/\benv\b/,
	/\bprintenv\b/,
	/\bps\s+aux\b/,
	/\btop\b/,
	/\bnetstat\b/,
	/\bss\s+-/,
	/\blsof\s+-i\b/,
	/\bcrontab\b/,
	/\bsystemctl\b/,
	/\bservice\s+\w+\s+(start|stop|restart)/i,
	/\bdmidecode\b/,
	/\blspci\b/,
	/\blsusb\b/,
];

/** 禁止触碰的敏感路径（绝对路径或从家目录/系统目录开始的引用）。 */
const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
	/\/etc\/(passwd|shadow|hosts|ssh|gshadow|sudoers)/i,
	/\/\.ssh\//, // ~/.ssh、任意 .ssh 目录
	/\/\.aws\//, // AWS 凭证
	/\/\.env\b/, // 环境变量文件
	/\/\.npmrc\b/,
	/\/\.gitconfig\b/,
	/\/\.docker\//,
	/\/\.kube\//,
	/\/var\/log\//,
	/\/proc\/self\/(environ|maps|cmdline)/i,
	/root\/\./, // root 家目录的隐藏文件
];

/** 禁止的危险命令模式（提权/逃逸/破坏）。 */
const DANGER_PATTERNS: readonly RegExp[] = [
	/\bsudo\b/,
	/\bsu\s+/,
	/\bchmod\s+([0-7]{3,4}|[+-]?[rwxs])/,
	/\bchown\b/,
	/\bmount\b/,
	/\bumount\b/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/\bshred\b/,
	/\b:()\s*\{\s*:|:&\s*\}\s*;/, // fork bomb
	/\bpkill\b/,
	/\bkillall\b/,
	/\bshutdown\b/,
	/\breboot\b/,
];

/** 禁止读取的环境变量名（防泄露 token/key）。 */
const SENSITIVE_ENV_PATTERNS: readonly RegExp[] = [
	/\$\{?(ANTHROPIC|OPENAI|DEEPSEEK|GLM|ZHIPU|ARK|VOLC)_(API_KEY|AUTH_TOKEN|SECRET|TOKEN)/i,
	/\$\{?(QQ_APP_SECRET|ADMIN_PASSWORD|DATABASE_URL)/i,
	/\bprocess\.env\b/, // node 读环境变量
];

const ALL_PATTERNS: ReadonlyArray<{ name: string; patterns: readonly RegExp[]; reason: string }> = [
	{ name: "network", patterns: NETWORK_PATTERNS, reason: "禁止网络外发命令（沙箱已断网，且禁止探测网络环境）" },
	{ name: "recon", patterns: RECON_PATTERNS, reason: "禁止探测主机信息命令（防泄露 IP/主机名/系统信息）" },
	{ name: "sensitive_path", patterns: SENSITIVE_PATH_PATTERNS, reason: "禁止访问敏感系统文件/凭证目录" },
	{ name: "danger", patterns: DANGER_PATTERNS, reason: "禁止提权/破坏类命令" },
	{ name: "sensitive_env", patterns: SENSITIVE_ENV_PATTERNS, reason: "禁止读取 API key/凭证类环境变量" },
];

/**
 * 审查一条待执行的 shell 命令。
 *
 * @param command 完整的 shell 命令字符串
 * @returns allowed=true 放行；allowed=false 附带拒绝原因
 *
 * 注意：审查基于正则模式匹配，存在被构造性绕过的可能（如 `cu""rl`）。
 * 这是纵深防御的一层——沙箱断网才是封死外发的硬墙，这里负责拦常见尝试 + 抬高成本。
 */
export function reviewCommand(command: string): GuardDecision {
	// 归一化：去除首尾空白；不做更激进的反混淆（会误伤 + 仍可绕过，价值不大）。
	const normalized = command.trim();
	if (normalized.length === 0) return { allowed: true };

	for (const group of ALL_PATTERNS) {
		for (const pattern of group.patterns) {
			if (pattern.test(normalized)) {
				return {
					allowed: false,
					reason: `命令被安全策略拦截（${group.name}）：${group.reason}。匹配规则: ${pattern.source}`,
				};
			}
		}
	}
	return { allowed: true };
}
