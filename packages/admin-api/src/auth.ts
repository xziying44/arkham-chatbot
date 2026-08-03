import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** scrypt 哈希密码。返回 hex 的 hash 与 salt。 */
export function hashPassword(password: string): { hash: string; salt: string } {
	const salt = randomBytes(16);
	const hash = scryptSync(password, salt, 64);
	return { hash: hash.toString("hex"), salt: salt.toString("hex") };
}

/** 校验密码：用存储的 salt 重算 hash，与存储的 hash 常量时间比较。 */
export function verifyPassword(password: string, storedHash: string, storedSalt: string): boolean {
	try {
		const salt = Buffer.from(storedSalt, "hex");
		const expected = Buffer.from(storedHash, "hex");
		const actual = scryptSync(password, salt, 64);
		if (actual.length !== expected.length) return false;
		return timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}

/** 生成随机会话 token（hex）。 */
export function generateSessionToken(): string {
	return randomBytes(32).toString("hex");
}

/** 会话 cookie 名。 */
export const SESSION_COOKIE = "arkham_admin";

/** 会话有效期（7 天）。 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
