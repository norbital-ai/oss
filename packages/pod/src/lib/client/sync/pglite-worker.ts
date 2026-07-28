/**
 * SharedWorker-hosted PGlite — one Postgres-per-origin shared by every tab.
 *
 * Each tab sends messages like `{type:"query", id, sql, params}` and receives
 * `{type:"result", id, rows}`. The worker owns the PGlite instance and the
 * IndexedDB persistence, so schema bootstrap and shape catch-up only happen once
 * regardless of how many tabs are open.
 *
 * Usage from the main thread is through `PgliteWorkerBridge` which presents the
 * same `PgliteLike` interface a direct PGlite would.
 */
import { PGlite } from '@electric-sql/pglite';

type Request =
	| { type: 'bootstrap'; id: number; schemaSql: string; dataDir: string }
	| { type: 'query'; id: number; sql: string; params?: unknown[] }
	| { type: 'exec'; id: number; sql: string };

type Response =
	| { type: 'bootstrapped'; id: number }
	| { type: 'result'; id: number; rows: Record<string, unknown>[]; affectedRows?: number }
	| { type: 'error'; id: number; message: string };

/**
 * A tab's end of the connection. The DOM lib types SharedWorker from the *page* side only, so the
 * worker-side globals (`onconnect`) and the port surface are declared here rather than pulled from
 * `webworker` lib types, which would conflict with the DOM types the rest of this package uses.
 */
interface Ports extends EventTarget {
	postMessage(message: Response): void;
	onmessage: ((event: MessageEvent<Request>) => void) | null;
	start(): void;
}

type SharedWorkerScope = {
	onconnect: ((event: MessageEvent) => void) | null;
};

const workerScope = self as unknown as SharedWorkerScope; // stupidity: boundary-cast — DOM types omit the worker-side SharedWorker global.

let db: PGlite | null = null;
let bootPromise: Promise<void> | null = null;
let activeDataDir: string | null = null;

async function ensureBooted(schemaSql: string, dataDir: string): Promise<void> {
	if (activeDataDir != null && activeDataDir !== dataDir) {
		throw new Error('SharedWorker replica identity changed');
	}
	if (!db) {
		db = new PGlite(dataDir);
		activeDataDir = dataDir;
	}
	// The DDL is additive and idempotent (CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS),
	// and concurrent tabs share this promise so the worker initializes the replica exactly once.
	bootPromise ??= db.exec(schemaSql).then(
		() => undefined,
		(error: unknown) => {
			bootPromise = null;
			throw error;
		}
	);
	await bootPromise;
}

async function handleRequest(request: Request, port: Ports): Promise<void> {
	try {
		if (request.type === 'bootstrap') {
			await ensureBooted(request.schemaSql, request.dataDir);
			port.postMessage({ type: 'bootstrapped', id: request.id });
			return;
		}

		if (!db) {
			port.postMessage({ type: 'error', id: request.id, message: 'PGlite not initialised' });
			return;
		}

		if (request.type === 'query') {
			const result = await db.query<Record<string, unknown>>(request.sql, request.params);
			port.postMessage({
				type: 'result',
				id: request.id,
				rows: result.rows,
				affectedRows: result.affectedRows
			});
			return;
		}

		if (request.type === 'exec') {
			await db.exec(request.sql);
			port.postMessage({ type: 'result', id: request.id, rows: [], affectedRows: 0 });
			return;
		}
	} catch (err) {
		port.postMessage({
			type: 'error',
			id: request.id,
			message: err instanceof Error ? err.message : String(err)
		});
	}
}

workerScope.onconnect = (event: MessageEvent) => {
	const port = event.ports[0]! as Ports;

	port.onmessage = (msg: MessageEvent<Request>) => {
		void handleRequest(msg.data, port);
	};

	port.start();
};
