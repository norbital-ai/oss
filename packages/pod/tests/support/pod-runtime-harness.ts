import { AsyncLocalStorage } from 'node:async_hooks';
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
import { Pool } from 'pg';
import { PostgresHostDbBinding } from '../../src/host/db.js';
import { isHostSyncStreamPath, serveHostSyncStream } from '../../src/host/sync-stream.js';
import { attachSyncWakeToDb, createInProcessSyncWakeBus, type SyncWakeBus } from '../../src/host/sync-wake.js';
import type {
	HostAiBinding,
	HostFileStorageBinding,
	HostMapsBinding,
	HostMessagingBinding,
	RuntimeFacilityBindings
} from '@norbital-ai/platform-utils/runtime/binding';
import type { DurableHostEffectRequest } from '../../src/host/types.js';
import { settleHostReceiptEffect } from '../../src/host/settle-receipt-effect.js';
import { parseAdmitHeaders, startAdmit, type PodAdmit } from '../../src/server/admit.js';
import { dispatchHostOrGuest } from '../../src/host/mail.js';
import {
	ADMIT_ARTIFACT_HEADER,
	serializeAdmitArtifact,
	withAdmitArtifact
} from '../../src/host/admit-artifact.js';
import { parseNorbitalManifest } from '@norbital-ai/platform-utils/manifest/parse';
import { CHECKPOINT_MANIFEST_FILENAME } from '@norbital-ai/platform-utils/tenant_workspace/build-output';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import { INTERACTIVE_AGENT_AUTOMATION_NAME } from '../../src/server/run/automation-dispatch.server.js';

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

const HARNESS_AUTOMATION_ARTIFACT = {
	artifactId: 'test-artifact',
	checkpointId: 'test-checkpoint',
	treeHash: 'test-tree',
	runtimeVersion: 'test-runtime'
} as const;

type DurableReceiptOutcome =
	| { readonly status: 'completed' }
	| { readonly status: 'failed'; readonly error?: string }
	| {
			readonly status: 'waiting_effect';
			readonly effectId?: string;
			readonly ordinal?: number;
			readonly requestHash?: string;
			readonly request?: DurableHostEffectRequest;
	  };

export type InteractiveAgentTurnResult = {
	readonly runId: string;
	readonly chatId: string;
	readonly outcome: 'completed' | 'failed';
	readonly error?: string;
};

/**
 * Start an interactive turn through `/_runtime/agent/start`, then drive the durable admit/run/settle
 * path until the receipt completes or fails.
 */
export async function completeInteractiveAgentTurn(
	harness: PodRuntimeHarness,
	identity: Identity,
	input: { readonly message: string; readonly runId?: string },
	ai: HostAiBinding
): Promise<InteractiveAgentTurnResult> {
	const response = await harness.request(
		{
			method: 'POST',
			path: 'agent/start',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(input)
		},
		identity
	);
	if (response.status !== 200) {
		throw new Error(
			`agent/start failed (${response.status}): ${await response.clone().text()}`
		);
	}
	const started = (await response.json()) as { runId: string; chatId: string; accepted: true };
	await harness.hostCommand({
		kind: 'automation-events',
		action: 'admit',
		artifact: HARNESS_AUTOMATION_ARTIFACT,
		limit: 200
	});
	const receipt = await harness.pool.query<{ norbital_id: string }>(
		`SELECT norbital_id::text FROM _norbital_automation_job
		  WHERE automation_name = $1
		  ORDER BY created_at DESC LIMIT 1`,
		[INTERACTIVE_AGENT_AUTOMATION_NAME]
	);
	const receiptId = receipt.rows[0]?.norbital_id;
	if (!receiptId) throw new Error('No interactive agent receipt after agent/start');
	for (let step = 0; step < 64; step += 1) {
		const outcome = (await harness.hostCommand({
			kind: 'automation-events',
			action: 'run',
			receiptId,
			artifact: HARNESS_AUTOMATION_ARTIFACT
		})) as DurableReceiptOutcome;
		if (outcome.status === 'completed') {
			return { runId: started.runId, chatId: started.chatId, outcome: 'completed' };
		}
		if (outcome.status === 'failed') {
			return {
				runId: started.runId,
				chatId: started.chatId,
				outcome: 'failed',
				...(outcome.error ? { error: outcome.error } : {})
			};
		}
		if (
			outcome.status !== 'waiting_effect' ||
			!outcome.effectId ||
			!outcome.request ||
			outcome.ordinal == null ||
			!outcome.requestHash
		) {
			throw new Error(`Unexpected agent step: ${JSON.stringify(outcome)}`);
		}
		const settled = await settleHarnessHostEffect(ai, outcome.request);
		await settleHarnessReceiptEffect(
			harness,
			{
				receiptId,
				effectId: outcome.effectId,
				ordinal: outcome.ordinal,
				requestHash: outcome.requestHash
			},
			settled
		);
	}
	throw new Error(`Interactive agent receipt ${receiptId} exceeded 64 durable steps`);
}

/**
 * Persist one host-effect outcome on the receipt. Same write standalone `pod start` uses.
 */
export async function settleHarnessReceiptEffect(
	harness: Pick<PodRuntimeHarness, 'pool'>,
	effect: {
		readonly receiptId: string;
		readonly effectId: string;
		readonly ordinal: number;
		readonly requestHash: string;
	},
	outcome: { readonly status: 'succeeded' | 'failed'; readonly result?: unknown; readonly error?: string }
): Promise<void> {
	await settleHostReceiptEffect(
		(sql, values) => harness.pool.query(sql, [...values]),
		effect,
		outcome
	);
}

/**
 * Execute one fenced host AI effect the same way standalone `pod start` does.
 */
async function settleHarnessHostEffect(
	ai: HostAiBinding,
	request: DurableHostEffectRequest
): Promise<{ readonly status: 'succeeded'; readonly result: unknown } | { readonly status: 'failed'; readonly error: string }> {
	try {
		switch (request.kind) {
			case 'ai.prompt': {
				const result = await ai.chat({
					messages: [{ role: 'user', content: request.prompt }],
					...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
					...(request.model ? { model: request.model } : {}),
					...(request.profile ? { profile: request.profile } : {})
				});
				return { status: 'succeeded', result };
			}
			case 'ai.turn': {
				const result = await ai.chat({
					messages: request.system
						? [{ role: 'system', content: request.system }, ...request.messages]
						: request.messages,
					...(request.tools ? { tools: request.tools } : {}),
					...(request.model ? { model: request.model } : {}),
					...(request.profile ? { profile: request.profile } : {})
				});
				return { status: 'succeeded', result };
			}
			default: {
				const _exhaustive: never = request;
				return {
					status: 'failed',
					error: `Unhandled harness automation effect kind: ${JSON.stringify(_exhaustive)}`
				};
			}
		}
	} catch (cause) {
		return { status: 'failed', error: cause instanceof Error ? cause.message : String(cause) };
	}
}

type GuestDispatch = (
	name: string,
	payload: unknown,
	bindings: RuntimeFacilityBindings,
	admit?: PodAdmit | null
) => Promise<unknown>;

const ADMIT_HEADER_NAMES = new Set(['x-norbital-timeout-ms', 'x-norbital-deadline-at']);

/** Runtime path without `/_runtime/`. */
function runtimeNameFromPath(pathname: string): string {
	if (pathname.startsWith('/_runtime/')) return pathname.slice('/_runtime/'.length);
	return pathname.replace(/^\//, '');
}

/** Identity headers only — admit is an argument to `dispatch`. */
function requestIdentityHeaders(request: Request): Record<string, string> {
	const headers: Record<string, string> = {};
	request.headers.forEach((value, name) => {
		if (ADMIT_HEADER_NAMES.has(name.toLowerCase())) return;
		headers[name] = value;
	});
	return headers;
}

/** Map one harness HTTP request onto the guest `dispatch` door. */
async function dispatchHttpRequest(
	dispatch: GuestDispatch,
	request: Request,
	bindings: RuntimeFacilityBindings
): Promise<Response> {
	const url = new URL(request.url);
	const body =
		request.method === 'GET' || request.method === 'HEAD' ? null : await request.text();
	const result = (await dispatch(
		runtimeNameFromPath(url.pathname),
		{
			method: request.method,
			search: url.search,
			headers: requestIdentityHeaders(request),
			body
		},
		bindings,
		parseAdmitHeaders(request.headers) ?? startAdmit(2_000)
	)) as { readonly status: number; readonly headers: Record<string, string>; readonly bodyText: string };
	return new Response(result.bodyText, { status: result.status, headers: result.headers });
}

type HostSyncWake = Pick<SyncWakeBus, 'subscribeSyncWake' | 'lastSyncSeq'>;


const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ORG_NAME = 'Sync IT Org';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
export const TEST_PERMISSION_BYPASS_KEY = 'pod-runtime-test-permission-bypass-key-0123456789abcdef';

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
	process.env.SECRET_PERMISSION_BYPASS_KEY = TEST_PERMISSION_BYPASS_KEY;
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
		SECRET_PERMISSION_BYPASS_KEY: TEST_PERMISSION_BYPASS_KEY,
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
	let guestDispatch: GuestDispatch;
	let pool: Pool;
	let binding: ReturnType<typeof attachSyncWakeToDb<PostgresHostDbBinding>>;
	let schemaSql: string;
	let compiledManifest: NorbitalManifest;
	const hostSyncWake = createInProcessSyncWakeBus();
	try {
		(globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage ??=
			AsyncLocalStorage;
		const runtimeModule = (await import(pathToFileURL(runtimePath).href)) as {
			dispatch?: GuestDispatch;
			handlePodHostCommand?: (command: unknown) => Promise<unknown>;
		};
		if (!runtimeModule.dispatch && !runtimeModule.handlePodHostCommand) {
			throw new Error('built pod runtime is missing its dispatch entry point');
		}
		guestDispatch =
			runtimeModule.dispatch ??
			(async (_name, payload, _bindings, _admit) => {
				if (!runtimeModule.handlePodHostCommand) {
					throw new Error('built pod runtime is missing its dispatch entry point');
				}
				return runtimeModule.handlePodHostCommand(payload);
			});
		const manifestSource = await readFile(
			path.join(templateRoot, '.norbital', 'build', CHECKPOINT_MANIFEST_FILENAME),
			'utf8'
		);
		compiledManifest = parseNorbitalManifest(JSON.parse(manifestSource));
		pool = new Pool({ connectionString: pg.connectionString, max: 12 });
		binding = attachSyncWakeToDb(
			new PostgresHostDbBinding(pg.connectionString, { pool }),
			hostSyncWake,
			ORG_ID
		);
		schemaSql = await loadSchemaSql(templateRoot);
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
			headers.set(ADMIT_ARTIFACT_HEADER, serializeAdmitArtifact(HARNESS_AUTOMATION_ARTIFACT));
			const request = new Request(`http://pod.local/_runtime/${init.path}`, {
				method: init.method,
				headers,
				signal: init.signal,
				...(init.body ? { body: init.body } : {})
			});
			return dispatchTenantRequest(request, guestDispatch, { db: binding, ...facilities }, hostSyncWake);
		},
		hostCommand(command) {
			return dispatchHostOrGuest({
				command,
				db: binding,
				manifest: compiledManifest,
				guest: (guestCommand) => {
					const injected = withAdmitArtifact(guestCommand, HARNESS_AUTOMATION_ARTIFACT);
					const kind =
						injected != null && typeof injected === 'object' && 'kind' in injected
							? String((injected as { kind: unknown }).kind)
							: '';
					return guestDispatch(
						kind,
						{
							...(injected != null && typeof injected === 'object' ? injected : { command: injected }),
							identity: { userId: ADMIN_ID, organizationId: ORG_ID, organizationName: ORG_NAME }
						},
						{ db: binding, ...facilities },
						startAdmit(2_000)
					);
				}
			});
		},
		async serveHttp(identity) {
			const server = createServer((req, res) => {
				void handleNodeRequest(req, res, identity, guestDispatch, {
					db: binding,
					...facilities
				}, hostSyncWake).catch((cause: unknown) => {
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
			await binding.close();
			await pool.end().catch(() => undefined);
			pg.stop();
			if (usesOverlay)
				await rm(templateRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	};
}

function dispatchTenantRequest(
	request: Request,
	dispatch: GuestDispatch,
	bindings: RuntimeFacilityBindings,
	hostSyncWake: HostSyncWake
): Promise<Response> {
	if (!isHostSyncStreamPath(new URL(request.url).pathname)) {
		return dispatchHttpRequest(dispatch, request, bindings);
	}
	const served = serveHostSyncStream({
		path: `${new URL(request.url).pathname}${new URL(request.url).search}`,
		signal: request.signal,
		pullDiff: async (diffPath) => {
			const diffUrl = new URL(diffPath, 'http://pod.local');
			const pulled = (await dispatch(
				runtimeNameFromPath(diffUrl.pathname),
				{
					method: 'GET',
					search: diffUrl.search,
					headers: requestIdentityHeaders(request),
					body: null
				},
				bindings,
				parseAdmitHeaders(request.headers) ?? startAdmit(2_000)
			)) as { readonly status: number; readonly bodyText: string };
			return { status: pulled.status, bodyText: pulled.bodyText };
		},
		subscribe: (wake) => hostSyncWake.subscribeSyncWake(ORG_ID, () => wake()),
		lastSeq: () => hostSyncWake.lastSyncSeq(ORG_ID)
	});
	return Promise.resolve(new Response(served.body, { status: served.status, headers: served.headers }));
}

/** Convert a Node request → web Request (forging auth), run the runtime, stream the Response back. */
async function handleNodeRequest(
	req: IncomingMessage,
	res: ServerResponse,
	identity: Identity,
	handle: GuestDispatch,
	bindings: RuntimeFacilityBindings,
	hostSyncWake: HostSyncWake
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
	headers.set(ADMIT_ARTIFACT_HEADER, serializeAdmitArtifact(HARNESS_AUTOMATION_ARTIFACT));
	const request = new Request(`http://pod.local${req.url ?? '/'}`, {
		method: req.method,
		headers,
		...(req.method === 'GET' || req.method === 'HEAD' || chunks.length === 0
			? {}
			: { body: Buffer.concat(chunks) })
	});
	const response = await dispatchTenantRequest(request, handle, bindings, hostSyncWake);
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
