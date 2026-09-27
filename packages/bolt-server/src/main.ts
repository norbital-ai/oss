// `bolt start` as a process (§5.11.6): decode, activate, serve until SIGTERM or SIGINT, then drain (rule 71). The
// promise settles only when serving ends: 0 after a clean stop, 1 for a configuration or activation refusal, 2 for a
// failure of the tool itself. `bolt start` in the bolt CLI calls this.
import { ConfigError, decodeConfig } from './config.ts';
import { ActivationError, start } from './server.ts';

export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
	try {
		const config = decodeConfig(env, argv);
		const server = await start(config, { dev: config.dev });
		return await new Promise<number>((done) => {
			const stop = () => void server.close().then(() => done(0), () => done(2));
			process.once('SIGTERM', stop);
			process.once('SIGINT', stop);
		});
	} catch (e) {
		console.error(`bolt start: ${e instanceof Error ? e.message : String(e)}`);
		return e instanceof ConfigError || e instanceof ActivationError ? 1 : 2;
	}
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) process.exit(await main());
