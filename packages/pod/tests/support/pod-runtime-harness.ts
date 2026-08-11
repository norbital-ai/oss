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
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, Pool, type Notification, type PoolClient } from 'pg';
import type {
	HostAiBinding,
	HostFileStorageBinding,
	HostMapsBinding,
	HostMessagingBinding,
	RuntimeFacilityBindings
} from '@norbital-ai/platform-utils/runtime/binding';
import { linkCurrentPodWorkspaceDependencies } from './current-package-node-modules.js';
import type { TUserRole } from '@norbital-ai/platform-utils/system/types';
import { startPostgresFromTemplate, type PgHarness } from './pg-harness.js';

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
	stop(): Promise<void>;
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

type NotificationSource = {
	subscribe(listener: (channel: string, payload: string) => void): () => void;
} | null;

type RegisterDatabaseNotifications = (source: NotificationSource) => void;

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

/**
 * The newest mtime under a directory, or 0 when it does not exist.
 *
 * Cheap enough to run per boot: a template's `src/` is a few hundred files and this walks it once.
 */
async function newestMtime(root: string): Promise<number> {
	const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(() => null);
	if (!entries) return 0;
	let newest = 0;
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const info = await stat(path.join(entry.parentPath, entry.name)).catch(() => null);
		if (info && info.mtimeMs > newest) newest = info.mtimeMs;
	}
	return newest;
}

/**
 * Whether the built tenant bundle already reflects both of its inputs.
 *
 * Fifteen suites boot this harness and all but two of them ask for the same template, so the build
 * they each ran was the same build fifteen times — and because they wrote it to the same shared
 * directory they had to take a lock to do it, which is what made the whole `node-runtime` project
 * run one file at a time. The bundle is a pure function of the template source and the pod package
 * it is built with, so a boot that finds both older than the artefact can simply use it.
 *
 * Both inputs are checked. Comparing against the template alone would hand back a stale bundle to
 * every suite the moment `packages/pod` was rebuilt, which is exactly the case a runtime test is
 * there to catch.
 */
async function isRuntimeBuildFresh(templateRoot: string, runtimePath: string): Promise<boolean> {
	const built = await stat(runtimePath).catch(() => null);
	if (!built) return false;
	const [templateSource, podPackage] = await Promise.all([
		newestMtime(path.join(templateRoot, 'src')),
		newestMtime(path.join(REPO_ROOT, 'packages/pod/build'))
	]);
	return built.mtimeMs > templateSource && built.mtimeMs > podPackage;
}

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
			// depends on contrib extensions PGlite doesn't bundle (pg_trgm's gin_trgm_ops,
			// pgvector HNSW/IVFFlat).
			if (/gin_trgm_ops/i.test(statement)) continue;
			if (/\busing\s+(hnsw|ivfflat)\b/i.test(statement)) continue;
			if (/\b(bit_hamming_ops|bit_jaccard_ops|vector_(l2|ip|cosine|l1)_ops)\b/i.test(statement))
				continue;
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
 * Inside the repo, because package resolution stays local to this checkout. The copy is taken under
 * the shared build lock:
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
	await linkCurrentPodWorkspaceDependencies(
		REPO_ROOT,
		root,
		path.join(templateRoot, 'node_modules')
	);
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
	// The checked-in template is source-only. Always build an isolated copy linked to the package
	// graph under test; its installed 0.0.1 dependencies intentionally model an old consumer and must
	// never decide whether current package tests pass.
	const usesOverlay = true;
	const templateRoot = await materializeOverlay(sharedTemplateRoot, sources);
	const runtimePath = path.join(templateRoot, '.norbital', 'build', 'output', 'server', 'index.js');
	const podEnv = (databaseUrl: string) => ({
		...process.env,
		DATABASE_URL: databaseUrl,
		POD_HOST: '127.0.0.1',
		POD_PORT: '7799',
		POD_ORG_ID: ORG_ID,
		POD_ORG_NAME: ORG_NAME,
		POD_ADMIN_ID: ADMIN_ID,
		POD_ADMIN_NAME: 'IT Admin',
		POD_ADMIN_EMAIL: 'admin@it.local',
		POD_TEMPLATE_KEY: template,
		POD_TRUSTED_HOST_TOKEN: '0123456789abcdef0123456789abcdef-trusted-host-token'
	});

	/*
	 * Build and migrate once per template, per worker; every suite then starts from a copy.
	 *
	 * Both were per suite, and both produced the same result every time: fifteen suites asked for
	 * `construction` and each ran the same build into the same directory and the same migration into
	 * its own empty database. The build is guarded by the cross-process lock because it writes to the
	 * shared template tree; the migration is not, because it writes only to the template database
	 * this worker just made for itself.
	 *
	 * An overlay gets its own key: its source differs per suite, so its build and schema are its own.
	 */
	const pg: PgHarness = await startPostgresFromTemplate(
		usesOverlay ? templateRoot : `template:${template}`,
		async (templateDatabaseUrl) => {
			const env = podEnv(templateDatabaseUrl);
			await withTemplateBuildLock(templateRoot, async () => {
				if (usesOverlay || !(await isRuntimeBuildFresh(templateRoot, runtimePath))) {
					execFileSync('node', [POD_BIN, 'build'], { cwd: templateRoot, env, stdio: 'ignore' });
				}
			});
			execFileSync('node', [POD_BIN, 'migrate'], { cwd: templateRoot, env, stdio: 'ignore' });
		}
	);

	// Everything past this point can fail. Drop the database on the way out rather than leaving it.
	let handleTenantRequest: HandleTenantRequest;
	let handleHostCommand: HandleHostCommand;
	let pool: Pool;
	let binding: ReturnType<typeof createPgBinding>;
	let schemaSql: string;
	let notifyClient: Client | undefined;
	let registerNotifications: RegisterDatabaseNotifications | undefined;
	try {
		const runtimeModule = (await import(pathToFileURL(runtimePath).href)) as {
			handlePodRequest?: HandleTenantRequest;
			handlePodHostCommand?: HandleHostCommand;
			registerPodDatabaseNotifications?: RegisterDatabaseNotifications;
		};
		if (!runtimeModule.handlePodRequest || !runtimeModule.handlePodHostCommand) {
			throw new Error('built pod runtime is missing its request/host-command entry points');
		}
		handleTenantRequest = runtimeModule.handlePodRequest;
		handleHostCommand = runtimeModule.handlePodHostCommand;
		pool = new Pool({ connectionString: pg.connectionString, max: 12 });
		binding = createPgBinding(pool);
		schemaSql = await loadSchemaSql(templateRoot);

		// The change feed wakes an idle stream only through a real commit notification (see
		// db-notifications.server.ts) — there is no timer fallback. Without this, every runtime
		// harness suite would boot into the no-source branch and a still-connected stream would
		// never learn about a later write. Mirrors installDatabaseNotifications in serve/standalone.ts.
		registerNotifications = runtimeModule.registerPodDatabaseNotifications;
		if (registerNotifications) {
			notifyClient = new Client({ connectionString: pg.connectionString });
			const listeners = new Set<(channel: string, payload: string) => void>();
			await notifyClient.connect();
			notifyClient.on('notification', (message: Notification) => {
				for (const listener of listeners) listener(message.channel, message.payload ?? '');
			});
			await notifyClient.query('LISTEN norbital_sync');
			registerNotifications({
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				}
			});
		}
	} catch (err) {
		await notifyClient?.end().catch(() => undefined);
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
			registerNotifications?.(null);
			await notifyClient?.end().catch(() => undefined);
			await pool.end().catch(() => undefined);
			pg.stop();
			if (usesOverlay)
				await rm(templateRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	};
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
