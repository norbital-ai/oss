import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const execFileAsync = promisify(execFile);

/** Same pin as Colony compose (`supporting-services.compose.yml`). */
export const OBSCURA_IMAGE = 'h4ckf0r0day/obscura:0.2.1';

const CDP_PATH = '/devtools/browser';
const uniqueContainerName = (): string =>
	`bolt-server-obscura-${process.pid}-${randomUUID().slice(0, 8)}`;

export type ObscuraSkip = Readonly<{
	readonly skip: 'missing_obscura';
	readonly reason: string;
}>;

export type ObscuraVersion = Readonly<{
	readonly product: string;
	readonly userAgent: string;
	readonly protocolVersion: string;
}>;

export type ObscuraDriver = Readonly<{
	readonly endpoint: string;
	readonly image: string;
	readonly startedContainer: boolean;
	readonly version: () => Promise<ObscuraVersion>;
	readonly readText: (url: string) => Promise<string>;
	readonly rssBytes: () => Promise<number | undefined>;
	readonly stop: () => Promise<void>;
}>;

type CdpResult = {
	readonly result?: unknown;
	readonly error?: { readonly message?: string };
};

const isSkip = (value: ObscuraDriver | ObscuraSkip): value is ObscuraSkip => 'skip' in value;

const docker = async (
	args: ReadonlyArray<string>
): Promise<{ readonly stdout: string; readonly stderr: string }> =>
	execFileAsync('docker', [...args], { timeout: 60_000, encoding: 'utf8' });

const parseMemUsage = (value: string): number | undefined => {
	const match = value.trim().match(/^([\d.]+)\s*(B|KiB|MiB|GiB)/i);
	if (match === null) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount)) return undefined;
	const unit = match[2]!.toLowerCase();
	switch (unit) {
		case 'b':
			return amount;
		case 'kib':
			return amount * 1024;
		case 'mib':
			return amount * 1024 * 1024;
		case 'gib':
			return amount * 1024 * 1024 * 1024;
		default: {
			const unhandled: never = unit as never;
			throw new Error(`Unhandled memory unit: ${String(unhandled)}`);
		}
	}
};

const configuredEndpoint = (): string | undefined => {
	const fromObscura = process.env['OBSCURA_CDP_URL']?.trim();
	if (fromObscura !== undefined && fromObscura.length > 0) return fromObscura;
	const fromColony = process.env['COLONY_BROWSER_CDP_URL']?.trim();
	if (fromColony !== undefined && fromColony.length > 0) return fromColony;
	return undefined;
};

class CdpSocket {
	readonly #socket: WebSocket;
	#nextId = 1;
	readonly #pending = new Map<
		number,
		{ readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
	>();

	private constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.on('message', (data) => {
			const message = JSON.parse(String(data)) as { readonly id?: number } & CdpResult;
			if (message.id === undefined) return;
			const waiter = this.#pending.get(message.id);
			if (waiter === undefined) return;
			this.#pending.delete(message.id);
			if (message.error !== undefined)
				waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
			else waiter.resolve(message.result);
		});
	}

	static connect(endpoint: string, timeoutMs = 8_000): Promise<CdpSocket> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(endpoint);
			const timer = setTimeout(() => {
				socket.close();
				reject(new Error(`CDP connect timed out: ${endpoint}`));
			}, timeoutMs);
			socket.once('open', () => {
				clearTimeout(timer);
				resolve(new CdpSocket(socket));
			});
			socket.once('error', (error) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	call(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = this.#nextId++;
			this.#pending.set(id, { resolve, reject });
			this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
			setTimeout(() => {
				if (!this.#pending.has(id)) return;
				this.#pending.delete(id);
				reject(new Error(`CDP timed out: ${method}`));
			}, 12_000);
		});
	}

	close(): void {
		this.#socket.close();
	}
}

const probeVersion = async (endpoint: string): Promise<ObscuraVersion> => {
	const cdp = await CdpSocket.connect(endpoint);
	try {
		const raw = (await cdp.call('Browser.getVersion')) as {
			readonly product?: string;
			readonly userAgent?: string;
			readonly protocolVersion?: string;
		};
		return {
			product: raw.product ?? '',
			userAgent: raw.userAgent ?? '',
			protocolVersion: raw.protocolVersion ?? ''
		};
	} finally {
		cdp.close();
	}
};

const hostPortOf = async (container: string): Promise<number> => {
	const { stdout } = await docker(['port', container, '9222/tcp']);
	const match = stdout.match(/:(\d+)\s*$/m);
	if (match === null) throw new Error(`docker port did not map 9222: ${stdout}`);
	return Number(match[1]);
};

const startContainer = async (): Promise<{ readonly id: string; readonly endpoint: string }> => {
	const containerName = uniqueContainerName();
	await docker(['rm', '-f', containerName]).catch(() => undefined);
	const { stdout } = await docker([
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
	const id = stdout.trim();
	const port = await hostPortOf(containerName);
	const endpoint = `ws://127.0.0.1:${port}${CDP_PATH}`;
	const deadline = Date.now() + 15_000;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			await probeVersion(endpoint);
			return { id, endpoint };
		} catch (error) {
			last = error;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	await docker(['rm', '-f', containerName]).catch(() => undefined);
	throw new Error(`Obscura CDP never answered: ${String(last)}`);
};

const dockerAvailable = async (): Promise<boolean> => {
	try {
		await docker(['info']);
		return true;
	} catch {
		return false;
	}
};

/**
 * Test driver: CDP against a live Obscura process. Not Colony `Browser.layerObscura`.
 * Skips when Docker cannot start the pinned image and no CDP URL is configured.
 */
export const openObscuraDriver = async (): Promise<ObscuraDriver | ObscuraSkip> => {
	const configured = configuredEndpoint();
	if (configured !== undefined) {
		try {
			await probeVersion(configured);
			return makeDriver({ endpoint: configured, image: 'configured', startedContainer: false });
		} catch (error) {
			return { skip: 'missing_obscura', reason: `configured CDP refused: ${String(error)}` };
		}
	}
	if (!(await dockerAvailable())) {
		return { skip: 'missing_obscura', reason: 'docker is not available' };
	}
	try {
		const started = await startContainer();
		return makeDriver({
			endpoint: started.endpoint,
			image: OBSCURA_IMAGE,
			startedContainer: true,
			containerId: started.id
		});
	} catch (error) {
		return { skip: 'missing_obscura', reason: String(error) };
	}
};

export const isObscuraSkip = isSkip;

const makeDriver = (input: {
	readonly endpoint: string;
	readonly image: string;
	readonly startedContainer: boolean;
	readonly containerId?: string;
}): ObscuraDriver => ({
	endpoint: input.endpoint,
	image: input.image,
	startedContainer: input.startedContainer,
	version: () => probeVersion(input.endpoint),
	readText: async (url) => {
		const cdp = await CdpSocket.connect(input.endpoint);
		try {
			const created = (await cdp.call('Target.createTarget', { url: 'about:blank' })) as {
				readonly targetId: string;
			};
			const attached = (await cdp.call('Target.attachToTarget', {
				targetId: created.targetId,
				flatten: true
			})) as { readonly sessionId: string };
			const sessionId = attached.sessionId;
			await cdp.call('Page.enable', {}, sessionId);
			await cdp.call('Runtime.enable', {}, sessionId);
			await cdp.call('Page.navigate', { url }, sessionId);
			const deadline = Date.now() + 8_000;
			let text = '';
			while (Date.now() < deadline) {
				const evaluated = (await cdp.call(
					'Runtime.evaluate',
					{
						expression:
							'document.body ? document.body.innerText : document.documentElement.textContent',
						returnByValue: true
					},
					sessionId
				)) as { readonly result?: { readonly value?: unknown } };
				const value = evaluated.result?.value;
				if (typeof value === 'string' && value.length > 0) {
					text = value;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			await cdp.call('Target.closeTarget', { targetId: created.targetId }).catch(() => undefined);
			if (text.length === 0) throw new Error(`Obscura loaded no text from ${url}`);
			return text;
		} finally {
			cdp.close();
		}
	},
	rssBytes: async () => {
		if (input.containerId === undefined && !input.startedContainer) return undefined;
		try {
			const { stdout } = await docker([
				'stats',
				'--no-stream',
				'--format',
				'{{.MemUsage}}',
				input.containerId ?? ''
			]);
			const used = stdout.split('/')[0] ?? stdout;
			return parseMemUsage(used);
		} catch {
			return undefined;
		}
	},
	stop: async () => {
		if (!input.startedContainer) return;
		if (input.containerId !== undefined) {
			await docker(['rm', '-f', input.containerId]).catch(() => undefined);
		}
	}
});
