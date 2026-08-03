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

main().catch((error) => {
	console.error("[bin] fatal:", error);
	process.exit(1);
});
