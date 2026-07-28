import type { PgliteLike } from './pod-sync-client.js';

/**
 * Main-thread bridge to a SharedWorker-hosted PGlite.
 *
 * Implements `PgliteLike` so PodSyncClient and the rest of the sync layer see the same interface
 * whether backed by a direct in-tab PGlite (Node tests) or a cross-tab SharedWorker (browser).
 * Messages are serialised through postMessage; the bridge tracks in-flight requests by id.
 */
export class PgliteWorkerBridge implements PgliteLike {
	private readonly port: MessagePort;
	private failure: Error | null = null;
	private nextId = 0;
	private readonly pending = new Map<
		number,
		{
			resolve: (value: { rows: Record<string, unknown>[]; affectedRows?: number }) => void;
			reject: (error: Error) => void;
		}
	>();

	constructor(worker: Pick<SharedWorker, 'port' | 'onerror'>) {
		this.port = worker.port;
		this.port.onmessage = this.handleMessage;
		this.port.start();
		worker.onerror = (event) => {
			this.fail(new Error(event.message || 'SharedWorker PGlite error'));
		};
	}

	private fail(error: Error): void {
		this.failure = error;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	private handleMessage = (
		event: MessageEvent<{
			type: string;
			id: number;
			rows?: unknown;
			affectedRows?: number;
			message?: string;
		}>
	): void => {
		const msg = event.data;
		const pending = this.pending.get(msg.id);
		if (!pending) return;
		this.pending.delete(msg.id);

		if (msg.type === 'result') {
			pending.resolve({
				rows: (msg.rows as Record<string, unknown>[]) ?? [],
				affectedRows: msg.affectedRows
			});
		} else if (msg.type === 'bootstrapped') {
			pending.resolve({ rows: [], affectedRows: 0 });
		} else if (msg.type === 'error') {
			pending.reject(new Error(msg.message ?? 'PGlite worker error'));
		} else {
			pending.reject(new Error(`Unknown PGlite worker response: ${msg.type}`));
		}
	};

	private async send(
		type: string,
		payload: Record<string, unknown>
	): Promise<{ rows: Record<string, unknown>[]; affectedRows?: number }> {
		if (this.failure) throw this.failure;
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.port.postMessage({ type, id, ...payload });
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async bootstrap(schemaSql: string, dataDir: string): Promise<void> {
		await this.send('bootstrap', { schemaSql, dataDir });
	}

	async query<T = Record<string, unknown>>(
		sql: string,
		params?: unknown[]
	): Promise<{ rows: T[]; affectedRows?: number }> {
		const result = await this.send('query', { sql, params });
		return { rows: result.rows as T[], affectedRows: result.affectedRows };
	}

	async exec(sql: string): Promise<unknown> {
		return this.send('exec', { sql });
	}

	async close(): Promise<void> {
		this.port.close();
		this.fail(new Error('SharedWorker PGlite port closed'));
	}
}
