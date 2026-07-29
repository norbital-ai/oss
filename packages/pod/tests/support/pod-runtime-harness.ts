import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { startPostgres, type PgHarness } from './pg-harness.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const POD_BIN = path.join(REPO_ROOT, 'packages/pod/build/bin/invocation/index.js');

export type TenantRequestInit = {
	readonly method: 'GET' | 'POST';
	readonly path: string; // e.g. "sync/subscribe"
	readonly headers?: Record<string, string>;
	readonly body?: string;
	readonly signal?: AbortSignal;
};

export type Identity = {
	readonly userId: string;
	readonly userName: string;
	readonly email: string;
	readonly role: 'admin' | 'member';
};

export type PodRuntimeHarness = {
	readonly schemaSql: string;
	readonly orgId: string;
	readonly orgName: string;
	readonly pool: Pool;
	request(init: TenantRequestInit, identity: Identity): Promise<Response>;
	/** Serve the runtime over a real HTTP socket (forging `identity` on every request). */
	serveHttp(identity: Identity): Promise<{ url: string; close: () => Promise<void> }>;
	stop(): Promise<void>;
};

type HandleTenantRequest = (request: Request, bindings: { db: HostDbBinding }) => Promise<Response>;

type HostDbBinding = {
	query(
		sql: unknown,
		params?: readonly unknown[]
	): Promise<{ rows: readonly unknown[]; rowCount?: number }>;
	begin(): Promise<string>;
	txQuery(
		txId: string,
		sql: unknown,
		params?: readonly unknown[]
	): Promise<{ rows: readonly unknown[]; rowCount?: number }>;
	commit(txId: string): Promise<void>;
	rollback(txId: string): Promise<void>;
};

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ORG_NAME = 'Sync IT Org';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';

/** Pinned-connection binding (mirrors PostgresHostDbBinding): txQuery/commit share one connection. */
function createPgBinding(pool: Pool): HostDbBinding {
	const txns = new Map<string, PoolClient>();
	let counter = 0;
	const normalize = (sql: unknown): { text: string; values: unknown[]; rowMode?: 'array' } => {
		if (typeof sql === 'string') return { text: sql, values: [] };
		const record = sql as {
			text?: string;
			values?: unknown[];
			params?: unknown[];
			rowMode?: 'array';
		};
		return {
			text: record.text ?? '',
			values: record.values ?? record.params ?? [],
			...(record.rowMode ? { rowMode: record.rowMode } : {})
		};
	};
	// Honor rowMode: drizzle RQB requests array-mode (positional) rows and maps them to columns
	// via its schema — returning objects here would scramble the mapping. The real host bindings
	// (PostgresHostDbBinding / neon adapter) pass rowMode through to pg, so honoring it here makes
	// the harness faithful and lets the sync path use RQB (findMany/findFirst) directly.
	const run = (
		q: { text: string; values: unknown[]; rowMode?: 'array' },
		params?: readonly unknown[],
		client?: PoolClient
	) => {
		const runner = client ?? pool;
		const values = (params as unknown[]) ?? q.values;
		return q.rowMode === 'array'
			? runner.query({ text: q.text, values, rowMode: 'array' })
			: runner.query(q.text, values);
	};
	return {
		async query(sql, params) {
			const q = normalize(sql);
			const result = await run(q, params);
			return { rows: result.rows, rowCount: result.rowCount ?? undefined };
		},
		async begin() {
			const client = await pool.connect();
			await client.query('BEGIN');
			const txId = `tx_${++counter}`;
			txns.set(txId, client);
			return txId;
		},
		async txQuery(txId, sql, params) {
			const client = txns.get(txId);
			if (!client) throw new Error(`Unknown transaction ${txId}`);
			const result = await run(normalize(sql), params, client);
			return { rows: result.rows, rowCount: result.rowCount ?? undefined };
		},
		async commit(txId) {
			const client = txns.get(txId);
			if (!client) return;
			try {
				await client.query('COMMIT');
			} finally {
				client.release();
				txns.delete(txId);
			}
		},
		async rollback(txId) {
			const client = txns.get(txId);
			if (!client) return;
			try {
				await client.query('ROLLBACK');
			} finally {
				client.release();
				txns.delete(txId);
			}
		}
	};
}

function baseScope(identity: Identity): string {
	return JSON.stringify({
		requestor: {
			norbital_id: identity.userId,
			user_name: identity.userName,
			email: identity.email,
			role: identity.role,
			user_status: 'active',
			team_members: [],
			avatar_url: null,
			deactivated_at: null
		},
		organization: { norbital_id: ORG_ID, name: ORG_NAME }
	});
}

/** Concatenate the template's drizzle migrations into client-applicable DDL (tables only). */
async function loadSchemaSql(templateRoot: string): Promise<string> {
	const migrationsDir = path.join(templateRoot, '.norbital', 'migrations');
	const entries = (await readdir(migrationsDir, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const statements: string[] = [];
	for (const dir of entries) {
		const sqlPath = path.join(migrationsDir, dir, 'migration.sql');
		const sql = await readFile(sqlPath, 'utf8').catch(() => '');
		// drizzle separates statements with a `--> statement-breakpoint` marker.
		for (const raw of sql.split('--> statement-breakpoint')) {
			const statement = raw.trim();
			if (!statement) continue;
			// The client replica needs tables only — not server-side search infrastructure that
			// depends on contrib extensions PGlite doesn't bundle (pg_trgm's gin_trgm_ops).
			if (/gin_trgm_ops/i.test(statement)) continue;
			if (/^create\s+extension/i.test(statement)) continue;
			statements.push(statement);
		}
	}
	return statements.join(';\n') + ';';
}

/**
 * Boot a full pod runtime in-process against a throwaway Postgres 18: build + migrate the template,
 * load the built `handleTenantRequest`, and expose an authed `request()` that drives `/_runtime/*`
 * with a forged base scope (no HTTP server, no facility gate — only the `db` facility is bound).
 */
export async function bootPodRuntime(template = 'construction'): Promise<PodRuntimeHarness> {
	const templateRoot = path.join(REPO_ROOT, 'template_workspaces', template);
	const pg: PgHarness = await startPostgres();
	const env = {
		...process.env,
		DATABASE_URL: pg.connectionString,
		POD_HOST: '127.0.0.1',
		POD_PORT: '7799',
		POD_ORG_ID: ORG_ID,
		POD_ORG_NAME: ORG_NAME,
		POD_ADMIN_ID: ADMIN_ID,
		POD_ADMIN_NAME: 'IT Admin',
		POD_ADMIN_EMAIL: 'admin@it.local',
		POD_TEMPLATE_KEY: template,
		POD_TRUSTED_HOST_TOKEN: '0123456789abcdef0123456789abcdef-trusted-host-token'
	};
	// Everything past this point can fail (a bad build, a failed migration). Tear the container
	// down on the way out rather than leaving it — and its data volume — behind.
	let handleTenantRequest: HandleTenantRequest;
	let pool: Pool;
	let binding: ReturnType<typeof createPgBinding>;
	let schemaSql: string;
	try {
		execFileSync('node', [POD_BIN, 'build'], { cwd: templateRoot, env, stdio: 'ignore' });
		execFileSync('node', [POD_BIN, 'migrate'], { cwd: templateRoot, env, stdio: 'ignore' });

		const runtimePath = path.join(
			templateRoot,
			'.norbital',
			'build',
			'output',
			'server',
			'index.js'
		);
		const runtimeModule = (await import(pathToFileURL(runtimePath).href)) as {
			handlePodRequest?: HandleTenantRequest;
		};
		if (!runtimeModule.handlePodRequest) {
			throw new Error('built pod runtime is missing handlePodRequest');
		}
		handleTenantRequest = runtimeModule.handlePodRequest;

		pool = new Pool({ connectionString: pg.connectionString, max: 12 });
		binding = createPgBinding(pool);
		schemaSql = await loadSchemaSql(templateRoot);
	} catch (err) {
		pg.stop();
		throw err;
	}

	return {
		schemaSql,
		orgId: ORG_ID,
		orgName: ORG_NAME,
		pool,
		async request(init, identity) {
			const headers = new Headers(init.headers);
			headers.set('x-norbital-user-id', identity.userId);
			headers.set('x-norbital-org-id', ORG_ID);
			headers.set('x-norbital-org-name', ORG_NAME);
			headers.set('x-norbital-base-scope-json', baseScope(identity));
			headers.set(
				'x-norbital-request-id',
				`req_${Math.abs(hashString(init.path + identity.userId))}`
			);
			const request = new Request(`http://pod.local/_runtime/${init.path}`, {
				method: init.method,
				headers,
				signal: init.signal,
				...(init.body ? { body: init.body } : {})
			});
			return handleTenantRequest(request, { db: binding });
		},
		async serveHttp(identity) {
			const server = createServer((req, res) => {
				void handleNodeRequest(req, res, identity, handleTenantRequest, binding).catch(
					(cause: unknown) => {
						if (!res.headersSent) res.statusCode = 500;
						res.end(String(cause));
					}
				);
			});
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			const port = (server.address() as AddressInfo).port;
			return {
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise<void>((resolve) => server.close(() => resolve()))
			};
		},
		async stop() {
			await pool.end().catch(() => undefined);
			pg.stop();
		}
	};
}

/** Convert a Node request → web Request (forging auth), run the runtime, stream the Response back. */
async function handleNodeRequest(
	req: IncomingMessage,
	res: ServerResponse,
	identity: Identity,
	handle: HandleTenantRequest,
	binding: HostDbBinding
): Promise<void> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (typeof value === 'string') headers.set(name, value);
	}
	headers.set('x-norbital-user-id', identity.userId);
	headers.set('x-norbital-org-id', ORG_ID);
	headers.set('x-norbital-org-name', ORG_NAME);
	headers.set('x-norbital-base-scope-json', baseScope(identity));
	const request = new Request(`http://pod.local${req.url ?? '/'}`, {
		method: req.method,
		headers,
		...(req.method === 'GET' || req.method === 'HEAD' || chunks.length === 0
			? {}
			: { body: Buffer.concat(chunks) })
	});
	const response = await handle(request, { db: binding });
	res.statusCode = response.status;
	response.headers.forEach((value, name) => res.setHeader(name, value));
	if (!response.body) {
		res.end(Buffer.from(await response.arrayBuffer()));
		return;
	}
	// Stream incrementally so SSE reaches the socket as produced (mirrors standalone writeWebResponse).
	const reader = response.body.getReader();
	res.on('close', () => void reader.cancel().catch(() => undefined));
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value && !res.writableEnded) res.write(Buffer.from(value));
		}
	} catch {
		// client disconnect / producer error
	}
	if (!res.writableEnded) res.end();
}

function hashString(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
	return hash;
}
