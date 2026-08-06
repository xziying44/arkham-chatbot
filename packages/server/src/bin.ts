import { startApp } from "./app.ts";

async function main(): Promise<void> {
	const { shutdown } = await startApp();

	let shuttingDown = false;
	const handle = (sig: NodeJS.Signals) => {
		console.info(`[bin] received ${sig}`);
		if (shuttingDown) {
			console.info("[bin] force exit");
			process.exit(1);
		}
		shuttingDown = true;
		void shutdown().finally(() => process.exit(0));
	};
	process.on("SIGINT", handle);
	process.on("SIGTERM", handle);
}

// 全局兜底：未捕获的异常和 unhandled rejection 不让进程崩溃。
// QQ WS 重连、LLM 调用等都可能产生意外的 rejection，记日志而非崩溃。
process.on("unhandledRejection", (reason) => {
	console.error("[bin] unhandledRejection（已捕获，不崩溃）:", reason);
});
process.on("uncaughtException", (error) => {
	console.error("[bin] uncaughtException（已捕获，不崩溃）:", error.message);
});

main().catch((error) => {
	console.error("[bin] fatal:", error);
	process.exit(1);
});
