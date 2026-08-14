/**
 * 卡图读取（Layer 2）：code + face → JPG buffer，从 card-database/card_images 读。
 *
 * 命名规则：`{code}_{face}.jpg`（如 01006_a.jpg）。
 * taboo 版卡 code 带 -t 后缀（organize 产物），card-database 一般没有 -t 专属图，
 * 故 resolver 在找不到时回退到去 -t 的原图。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CardImageResolver } from "../types.ts";

export interface CreateResolverOptions {
	/** card-database 根目录（含 card_images/）。 */
	cardDatabaseDir: string;
	/** 卡图子目录名，默认 "card_images"。 */
	imagesSubdir?: string;
}

export function createCardImageResolver(opts: CreateResolverOptions): CardImageResolver {
	const dir = join(opts.cardDatabaseDir, opts.imagesSubdir ?? "card_images");
	const bufferCache = new Map<string, Buffer | null>();

	async function tryRead(rel: string): Promise<Buffer | null> {
		const cached = bufferCache.get(rel);
		if (cached !== undefined) return cached;
		let buf: Buffer | null;
		try {
			buf = await readFile(join(dir, rel));
		} catch {
			buf = null;
		}
		// 限制 buffer 缓存规模（engine 侧另有解码缓存）
		if (bufferCache.size > 200) bufferCache.clear();
		bufferCache.set(rel, buf);
		return buf;
	}

	return {
		async resolve({ code, face }) {
			const f = face ?? "a";
			// 1. 直接按 code_face 找
			let buf = await tryRead(`${code}_${f}.jpg`);
			if (buf) return buf;
			// 2. taboo -t 后缀回退：去 -t 再找
			if (code.endsWith("-t")) {
				buf = await tryRead(`${code.slice(0, -2)}_${f}.jpg`);
				if (buf) return buf;
			}
			// 3. 双面卡可能只有 a 面：要 b 面时回退 a
			if (f !== "a") {
				buf = await tryRead(`${code}_a.jpg`);
				if (buf) return buf;
			}
			return null;
		},
	};
}
