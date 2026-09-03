import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Same pin as Colony compose and bolt-server's Obscura probe. */
export const OBSCURA_IMAGE = 'h4ckf0r0day/obscura:0.2.1';

const CDP_PATH = '/devtools/browser';
const uniqueContainerName = (): string =>
	`test-utilities-obscura-${process.pid}-${randomUUID().slice(0, 8)}`;

export class MissingObscuraError extends Error {
	override readonly name = 'missing_obscura';
	constructor(message = 'Obscura CDP URL is not configured') {
		super(message);
	}
}

export type StartedObscura = {
	readonly endpoint: string;
	readonly source: 'url' | 'binary' | 'docker';
	readonly image?: string;
	readonly stop: () => Promise<void>;
};

type ResolvedObscura =
	| { readonly kind: 'url'; readonly endpoint: string }
	| { readonly kind: 'missing' };

const firstNonEmpty = (value: string | undefined): string | undefined => {
	const trimmed = value?.trim() ?? '';
	return trimmed.length > 0 ? trimmed : undefined;
};

const resolveObscuraUrl = (url?: string): ResolvedObscura => {
	const endpoint =
		firstNonEmpty(url) ??
		firstNonEmpty(process.env['OBSCURA_CDP_URL']) ??
		firstNonEmpty(process.env['COLONY_BROWSER_CDP_URL']);
	if (endpoint === undefined) return { kind: 'missing' };
	return { kind: 'url', endpoint };
};

const docker = async (
	args: ReadonlyArray<string>
): Promise<{ readonly stdout: string; readonly stderr: string }> =>
	execFileAsync('docker', [...args], { timeout: 60_000, encoding: 'utf8' });

const dockerAvailable = async (): Promise<boolean> => {
	try {
		await docker(['info']);
		return true;
	} catch {
		return false;
	}
};

const hostPortOf = async (container: string): Promise<number> => {
	const { stdout } = await docker(['port', container, '9222/tcp']);
	const match = stdout.match(/:(\d+)\s*$/m);
	if (match === null) throw new Error(`docker port did not map 9222: ${stdout}`);
	return Number(match[1]);
};

const freePort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close((error) => {
				if (error !== undefined) {
					reject(error);
					return;
				}
				if (address === null || typeof address === 'string') {
					reject(new Error('could not allocate a port for Obscura'));
					return;
				}
				resolve(address.port);
			});
		});
		server.on('error', reject);
	});

/** Wait until the websocket accepts a connection. Does not speak CDP. */
const waitForEndpoint = async (endpoint: string, timeoutMs: number): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			await new Promise<void>((resolve, reject) => {
				const socket = new WebSocket(endpoint);
				const timer = setTimeout(() => {
					socket.close();
					reject(new Error(`Obscura CDP connect timed out: ${endpoint}`));
				}, 1_500);
				socket.addEventListener(
					'open',
					() => {
						clearTimeout(timer);
						socket.close();
						resolve();
					},
					{ once: true }
				);
				socket.addEventListener(
					'error',
					() => {
						clearTimeout(timer);
						socket.close();
						reject(new Error(`Obscura CDP connection failed: ${endpoint}`));
					},
					{ once: true }
				);
			});
			return;
		} catch (error) {
			last = error;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new MissingObscuraError(`Obscura CDP never answered: ${String(last)}`);
};

/**
 * Rewrite a loopback guest so a Docker Obscura can reach the host listener.
 * A host-side binary does not need this; pass `rewriteLoopback: false`.
 */
export const guestUrlForObscura = (
	host: string,
	port: number,
	path: string,
	options?: { readonly rewriteLoopback?: boolean }
): string => {
	const rewrite = options?.rewriteLoopback !== false;
	const bound = host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0';
	const hostname = rewrite && bound ? 'host.docker.internal' : host === '0.0.0.0' ? '127.0.0.1' : host;
	const normalized = path.startsWith('/') ? path : `/${path}`;
	return `http://${hostname}:${port}${normalized}`;
};

const stopProcess = async (child: ChildProcess): Promise<void> => {
	if (child.killed || child.exitCode !== null) return;
	await new Promise<void>((resolve) => {
		child.once('exit', () => resolve());
		child.kill('SIGTERM');
		setTimeout(() => {
			if (child.killed || child.exitCode !== null) {
				resolve();
				return;
			}
			child.kill('SIGKILL');
			resolve();
		}, 2_000);
	});
};

const tryStartBinary = async (): Promise<StartedObscura | undefined> => {
	let port: number;
	try {
		port = await freePort();
	} catch {
		return undefined;
	}
	const child = spawn(
		'obscura',
		[
			'serve',
			'--port',
			String(port),
			'--host',
			'127.0.0.1',
			'--max-connections',
			'4',
			'--allow-private-network'
		],
		{ stdio: 'ignore' }
	);
	let abandoned = false;
	const abandon = async (): Promise<undefined> => {
		if (abandoned) return undefined;
		abandoned = true;
		await stopProcess(child);
		return undefined;
	};
	const failed = new Promise<undefined>((resolve) => {
		child.once('error', () => {
			void abandon().then(resolve);
		});
		child.once('exit', () => {
			if (!abandoned) void abandon().then(resolve);
		});
	});
	const endpoint = `ws://127.0.0.1:${port}${CDP_PATH}`;
	const ready = waitForEndpoint(endpoint, 8_000).then((): StartedObscura => {
		abandoned = true;
		return {
			endpoint,
			source: 'binary',
			stop: () => stopProcess(child)
		};
	});
	return Promise.race([ready, failed]).catch(async () => abandon());
};

const startContainer = async (): Promise<StartedObscura> => {
	const containerName = uniqueContainerName();
	await docker(['rm', '-f', containerName]).catch(() => undefined);
	await docker([
		'run',
		'-d',
		'--rm',
		'--name',
		containerName,
		'--add-host=host.docker.internal:host-gateway',
		'-p',
		'127.0.0.1::9222',
		OBSCURA_IMAGE,
		'serve',
		'--port',
		'9222',
		'--host',
		'0.0.0.0',
		'--max-connections',
		'4',
		'--allow-private-network'
	]);
	const port = await hostPortOf(containerName);
	const endpoint = `ws://127.0.0.1:${port}${CDP_PATH}`;
	try {
		await waitForEndpoint(endpoint, 15_000);
	} catch (error) {
		await docker(['rm', '-f', containerName]).catch(() => undefined);
		throw error;
	}
	return {
		endpoint,
		source: 'docker',
		image: OBSCURA_IMAGE,
		stop: async () => {
			await docker(['rm', '-f', containerName]).catch(() => undefined);
		}
	};
};

/**
 * Adopt a configured CDP URL, or start the `obscura` binary, or the pinned Docker image.
 * Returns the websocket endpoint only — tests speak CDP. Unset and unstartable is `missing_obscura`.
 */
export const startObscura = async (url?: string): Promise<StartedObscura> => {
	const resolved = resolveObscuraUrl(url);
	switch (resolved.kind) {
		case 'url':
			return {
				endpoint: resolved.endpoint,
				source: 'url',
				stop: async () => undefined
			};
		case 'missing': {
			const binary = await tryStartBinary();
			if (binary !== undefined) return binary;
			if (!(await dockerAvailable())) {
				throw new MissingObscuraError(
					'Obscura CDP URL is not configured, obscura is not on PATH, and docker is not available'
				);
			}
			try {
				return await startContainer();
			} catch (error) {
				if (error instanceof MissingObscuraError) throw error;
				throw new MissingObscuraError(error instanceof Error ? error.message : String(error));
			}
		}
		default: {
			const _exhaustive: never = resolved;
			throw new Error(`unhandled Obscura source: ${JSON.stringify(_exhaustive)}`);
		}
	}
};
