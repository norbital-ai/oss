import { execFileSync } from 'node:child_process';
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	rmdir,
	stat,
	writeFile
} from 'node:fs/promises';
import { symlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { decodeWireValue, encodeWireValue } from '@norbital-ai/platform-utils/runtime/wire';
import type {
	HostAiBinding,
	HostFileStorageBinding,
	HostMapsBinding,
	HostMessagingBinding,
	RuntimeFacilityBindings
} from '@norbital-ai/platform-utils/runtime/binding';
import type { TUserRole } from '@norbital-ai/platform-utils/system/types';
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
	readonly role: TUserRole;
	/** Teams the trusted host resolved for this requestor. */
	readonly teamMembers?: readonly {
		readonly id: string;
		readonly name: string;
	}[];
};

/**
 * One binding call as it left the guest, exactly as the host received it.
 *
 * Recorded rather than summarized: the assertion that matters most about this wire is a *negative*
 * one — the guest must not name its organization, its database or its tenant, because the host
 * resolves all three from the secret it minted. That can only be checked against the real body.
 */
export type RecordedBindingCall = {
	readonly facility: string;
	readonly method: string;
	readonly rawBody: string;
};

/**
 * A guest runtime served the way a real host serves one: the built bundle's own
 * `startPodHttpServer`, listening on a port, with a stand-in host answering its binding calls and its
 * boot configuration request.
 *
 * Nothing here forges identity. A caller sends the host token and the identity headers itself, so a
 * test can leave either out and see what the guest does about it.
 */
export type GuestRuntimeServer = {
	readonly url: string;
	readonly hostToken: string;
	/** The bearer secret the stand-in host expects; a guest that used another would be refused. */
	readonly bindingSecret: string;
	/** Headers a host would send with tenant traffic. */
	headers(identity: Identity): Record<string, string>;
	readonly bindingCalls: readonly RecordedBindingCall[];
	/** How many times the guest asked the host for its deployment configuration. */
	configurationRequests(): number;
	close(): Promise<void>;
};

export type PodRuntimeHarness = {
	readonly schemaSql: string;
	readonly orgId: string;
	readonly orgName: string;
	readonly pool: Pool;
	request(init: TenantRequestInit, identity: Identity): Promise<Response>;
	/**
	 * The trusted host's private control plane — the same entry point `pod start` and Core call.
	 *
	 * Jobs reach the workspace only through here (`workspaceJobs` is handed a `dispatch` that is
	 * exactly this), so a test that drives a drain by calling its runner directly would be testing
	 * the runner rather than the job. Deliberately separate from `request`: nothing a tenant
	 * identity can reach may claim outbox rows.
	 */
	hostCommand(command: unknown): Promise<unknown>;
	/** Serve the runtime over a real HTTP socket (forging `identity` on every request). */
	serveHttp(identity: Identity): Promise<{ url: string; close: () => Promise<void> }>;
	/** Serve the runtime as a hosted guest, behind a stand-in host. */
	serveGuest(options?: GuestRuntimeOptions): Promise<GuestRuntimeServer>;
	stop(): Promise<void>;
};

export type GuestRuntimeOptions = {
	/** Host surfaces the stand-in host advertises at boot. */
	readonly hostPlugins?: readonly unknown[];
};

type HandleTenantRequest = (
	request: Request,
	bindings: RuntimeFacilityBindings
) => Promise<Response>;

type HandleHostCommand = (
	command: unknown,
	bindings: RuntimeFacilityBindings,
	identity: { userId: string; organizationId: string; organizationName: string }
) => Promise<unknown>;

type StartGuestRuntime = () => Promise<{ port: number; close(): Promise<void> }>;

/**
 * Credentials the stand-in host mints for a guest.
 *
 * The token is over 32 bytes because `trustedHeaderIdentity` refuses a shorter one — a guest handed a
 * guessable token would refuse to boot, which is the behaviour, not an inconvenience to work around.
 */
const GUEST_HOST_TOKEN = 'guest-host-token-0123456789abcdef0123456789abcdef';
const GUEST_BINDING_SECRET = 'guest-binding-secret-0123456789abcdef';

type TestHostDbBinding = {
	query(
		sql: unknown,
		params?: readonly unknown[]
	): Promise<{ rows: readonly unknown[]; rowCount: number }>;
	begin(): Promise<string>;
	txQuery(
		txId: string,
		sql: unknown,
		params?: readonly unknown[]
	): Promise<{ rows: readonly unknown[]; rowCount: number }>;
	commit(txId: string): Promise<void>;
	rollback(txId: string): Promise<void>;
};

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ORG_NAME = 'Sync IT Org';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';

async function withTemplateBuildLock<T>(templateRoot: string, run: () => Promise<T>): Promise<T> {
	const lockDirectory = path.join(templateRoot, '.norbital', '.test-build-lock');
	const deadline = Date.now() + 120_000;
	for (;;) {
		try {
			await mkdir(lockDirectory);
			break;
		} catch (cause) {
			if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'EEXIST') throw cause;
			const lock = await stat(lockDirectory).catch(() => null);
			if (lock && Date.now() - lock.mtimeMs > 5 * 60_000) {
				await rmdir(lockDirectory).catch(() => undefined);
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${lockDirectory}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	try {
		return await run();
	} finally {
		await rmdir(lockDirectory).catch(() => undefined);
	}
}

/** Pinned-connection binding (mirrors PostgresHostDbBinding): txQuery/commit share one connection. */
function createPgBinding(pool: Pool): TestHostDbBinding {
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
			return { rows: result.rows, rowCount: result.rowCount ?? 0 };
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
			return { rows: result.rows, rowCount: result.rowCount ?? 0 };
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
			team_members: (identity.teamMembers ?? []).map((team) => ({
				norbital_id: team.id,
				name: team.name,
				description: null,
				parent_id: null,
				is_active: true
			})),
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
			// The replica has no temporal history at all, so skip every statement that touches one —
			// not just the create. A column default or type change on a record table also emits an
			// ALTER against its `<table>_history` twin, which would fail here for a table that was
			// never created.
			if (/_norbital_create_history_table/i.test(statement)) continue;
			if (/"[a-z0-9_]+_history"/i.test(statement)) continue;
			statements.push(statement);
		}
	}
	return statements.join(';\n') + ';';
}

/**
 * Copy a template into `.test-workspaces/` and write the caller's extra sources over it.
 *
 * Inside the repo, because pnpm resolves the injected `@norbital-ai/*` copies through relative
 * symlinks that do not survive a move outside it. The copy is taken under the shared build lock:
 * without it the snapshot can catch another suite's `.norbital` mid-write, which fails the copy's
 * build for a reason that has nothing to do with the test.
 */
async function materializeOverlay(
	templateRoot: string,
	sources: Readonly<Record<string, string>>
): Promise<string> {
	const parent = path.join(REPO_ROOT, '.test-workspaces');
	await mkdir(parent, { recursive: true });
	const root = await mkdtemp(path.join(parent, 'overlay-'));
	const skipped = [
		'node_modules',
		path.join('.norbital', 'build'),
		path.join('.norbital', 'dist'),
		// Held by us for the duration of this very copy, and a copied lock is a lock nobody releases.
		path.join('.norbital', '.test-build-lock')
	];
	await withTemplateBuildLock(templateRoot, async () => {
		await cp(templateRoot, root, {
			recursive: true,
			filter: (source) => {
				const relative = path.relative(templateRoot, source);
				return !skipped.some(
					(entry) => relative === entry || relative.startsWith(`${entry}${path.sep}`)
				);
			}
		});
	});
	await symlink(path.join(templateRoot, 'node_modules'), path.join(root, 'node_modules'));
	for (const [relative, contents] of Object.entries(sources)) {
		const file = path.join(root, relative);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, contents);
	}
	return root;
}

/**
 * Boot a full pod runtime in-process against a throwaway Postgres 18: build + migrate the template,
 * load the built `handleTenantRequest`, and expose an authed `request()` that drives `/_runtime/*`
 * with a forged base scope (no HTTP server, no facility gate — only the `db` facility is bound).
 */
export type PodRuntimeTestFacilities = {
	readonly ai?: HostAiBinding;
	readonly fileStorage?: HostFileStorageBinding;
	readonly maps?: HostMapsBinding;
	readonly messaging?: HostMessagingBinding;
};

export type PodRuntimeBootOptions = {
	/**
	 * Extra workspace source files, keyed by path relative to the workspace root.
	 *
	 * Supplying any of these boots from a private copy of the template rather than the template
	 * itself, because the shared templates are what every other suite builds and a test that edits
	 * one changes their subject. The copy borrows the template's `node_modules` by symlink (pnpm's
	 * links inside it are relative, so they still resolve) and keeps its existing migrations, so a
	 * file that adds no columns costs a rebuild and no migration.
	 */
	readonly sources?: Readonly<Record<string, string>>;
};

export async function bootPodRuntime(
	template = 'construction',
	facilities: PodRuntimeTestFacilities = {},
	options: PodRuntimeBootOptions = {}
): Promise<PodRuntimeHarness> {
	const sharedTemplateRoot = path.join(REPO_ROOT, 'template_workspaces', template);
	const sources = options.sources ?? {};
	const usesOverlay = Object.keys(sources).length > 0;
	const templateRoot = usesOverlay
		? await materializeOverlay(sharedTemplateRoot, sources)
		: sharedTemplateRoot;
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
	let handleHostCommand: HandleHostCommand;
	let startGuestRuntime: StartGuestRuntime;
	let pool: Pool;
	let binding: ReturnType<typeof createPgBinding>;
	let schemaSql: string;
	try {
		({ handleTenantRequest, handleHostCommand, startGuestRuntime, pool, binding, schemaSql } =
			await withTemplateBuildLock(templateRoot, async () => {
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
					handlePodHostCommand?: HandleHostCommand;
					startPodHttpServer?: StartGuestRuntime;
				};
				if (
					!runtimeModule.handlePodRequest ||
					!runtimeModule.handlePodHostCommand ||
					!runtimeModule.startPodHttpServer
				) {
					throw new Error('built pod runtime is missing its request/host-command entry points');
				}
				const loadedPool = new Pool({ connectionString: pg.connectionString, max: 12 });
				const loadedBinding = createPgBinding(loadedPool);
				return {
					handleTenantRequest: runtimeModule.handlePodRequest,
					handleHostCommand: runtimeModule.handlePodHostCommand,
					startGuestRuntime: runtimeModule.startPodHttpServer,
					pool: loadedPool,
					binding: loadedBinding,
					schemaSql: await loadSchemaSql(templateRoot)
				};
			}));
	} catch (err) {
		pg.stop();
		if (usesOverlay)
			await rm(templateRoot, { recursive: true, force: true }).catch(() => undefined);
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
			return handleTenantRequest(request, { db: binding, ...facilities });
		},
		hostCommand(command) {
			return handleHostCommand(
				command,
				{ db: binding, ...facilities },
				{ userId: ADMIN_ID, organizationId: ORG_ID, organizationName: ORG_NAME }
			);
		},
		async serveGuest(options = {}) {
			const bindings: Record<string, unknown> = { db: binding, ...facilities };
			const calls: RecordedBindingCall[] = [];
			let configurations = 0;
			const host = createServer((req, res) => {
				void standInHost(req, res, bindings, calls, {
					hostPlugins: options.hostPlugins ?? [],
					onConfiguration: () => (configurations += 1)
				}).catch((cause: unknown) => {
					if (!res.headersSent) res.statusCode = 500;
					res.end(String(cause));
				});
			});
			await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
			const hostPort = (host.address() as AddressInfo).port;
			const port = await unusedPort();
			// The guest reads its environment at boot, the way the sandbox that starts it supplies one.
			process.env.POD_RUNTIME_PORT = String(port);
			process.env.POD_HOST_TOKEN = GUEST_HOST_TOKEN;
			process.env.NORBITAL_CORE_URL = `http://127.0.0.1:${hostPort}`;
			process.env.NORBITAL_BINDING_SECRET = GUEST_BINDING_SECRET;
			const guest = await startGuestRuntime();
			return {
				url: `http://127.0.0.1:${guest.port}`,
				hostToken: GUEST_HOST_TOKEN,
				bindingSecret: GUEST_BINDING_SECRET,
				headers(identity) {
					return {
						'x-norbital-host-token': GUEST_HOST_TOKEN,
						'x-norbital-user-id': identity.userId,
						'x-norbital-org-id': ORG_ID,
						'x-norbital-org-name': ORG_NAME,
						'x-norbital-base-scope-json': baseScope(identity)
					};
				},
				bindingCalls: calls,
				configurationRequests: () => configurations,
				async close() {
					await guest.close();
					await new Promise<void>((resolve) => host.close(() => resolve()));
				}
			};
		},
		async serveHttp(identity) {
			const server = createServer((req, res) => {
				void handleNodeRequest(req, res, identity, handleTenantRequest, {
					db: binding,
					...facilities
				}).catch((cause: unknown) => {
					if (!res.headersSent) res.statusCode = 500;
					res.end(String(cause));
				});
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
			if (usesOverlay)
				await rm(templateRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	};
}

/**
 * A port nothing is listening on, taken by briefly listening on it.
 *
 * The guest binds the port its environment names, because that is what a host's proxy routes to, so a
 * test has to choose one that is free rather than asking for an ephemeral one.
 */
async function unusedPort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
	const port = (probe.address() as AddressInfo).port;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

async function readAll(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

/**
 * The host half of the runtime wire: boot configuration, and one facility dispatcher.
 *
 * `structuredClone` around the result is the point of dispatching through here rather than handing
 * the guest the binding objects — it is what a value crossing this boundary really goes through, and
 * it is what a function (or a record of them) does not survive.
 */
async function standInHost(
	request: IncomingMessage,
	response: ServerResponse,
	bindings: Record<string, unknown>,
	calls: RecordedBindingCall[],
	options: { hostPlugins: readonly unknown[]; onConfiguration: () => void }
): Promise<void> {
	const answer = (status: number, body: unknown) => {
		response.statusCode = status;
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify(body));
	};
	// The secret is the whole of a guest's authorization here, exactly as it is in the real host.
	if (request.headers.authorization !== `Bearer ${GUEST_BINDING_SECRET}`) {
		response.statusCode = 401;
		response.end('Unauthorized');
		return;
	}
	const pathname = new URL(request.url ?? '/', 'http://host.local').pathname;
	if (pathname === '/_internal/runtime/config' && request.method === 'GET') {
		options.onConfiguration();
		answer(200, { hostPlugins: options.hostPlugins });
		return;
	}
	if (pathname !== '/_internal/runtime/binding' || request.method !== 'POST') {
		response.statusCode = 404;
		response.end('Not Found');
		return;
	}
	const rawBody = await readAll(request);
	const parsed = JSON.parse(rawBody) as {
		facility?: unknown;
		method?: unknown;
		args?: unknown;
	};
	const facility = typeof parsed.facility === 'string' ? parsed.facility : '';
	const method = typeof parsed.method === 'string' ? parsed.method : '';
	calls.push({ facility, method, rawBody });
	try {
		const target = bindings[facility] as Record<string, unknown> | undefined;
		if (!target) throw new Error(`No ${facility} binding`);
		const member = target[method];
		if (typeof member !== 'function') {
			throw new Error(`${facility}.${method} is not callable across the runtime boundary`);
		}
		const args = (Array.isArray(parsed.args) ? parsed.args : []).map(decodeWireValue);
		const value: unknown = await (member as (...a: unknown[]) => unknown).apply(target, args);
		answer(200, { ok: true, value: structuredClone(encodeWireValue(value)) });
	} catch (caught) {
		answer(200, { ok: false, error: caught instanceof Error ? caught.message : String(caught) });
	}
}

/** Convert a Node request → web Request (forging auth), run the runtime, stream the Response back. */
async function handleNodeRequest(
	req: IncomingMessage,
	res: ServerResponse,
	identity: Identity,
	handle: HandleTenantRequest,
	bindings: RuntimeFacilityBindings
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
	const response = await handle(request, bindings);
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
