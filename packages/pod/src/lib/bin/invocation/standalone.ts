import type {
	HostDbBinding,
	RuntimeFacilityRequirement,
	RuntimeFacilityBindings
} from '@norbital-ai/platform-utils/runtime/binding';
import { requiredRuntimeFacilities } from '@norbital-ai/platform-utils/runtime/binding';
import { parseNorbitalManifest } from '@norbital-ai/platform-utils/manifest/parse';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import {
	CHECKPOINT_MANIFEST_FILENAME,
	staticAssetContentType
} from '@norbital-ai/platform-utils/tenant_workspace/build-output';
import { applyMigrations } from '@norbital-ai/platform-utils/tenant_workspace/migrations/apply';
import { compiledSeedPlanFromManifest } from '@norbital-ai/platform-utils/seed/plan';
import { parseSeedManifest } from '@norbital-ai/platform-utils/seed/manifest';
import { seedTemplateDataFromPlan } from '@norbital-ai/platform-utils/seed/execute';
import { safeParse } from '@norbital-ai/std/json';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { PostgresHostDbBinding, type HostDbConnection } from '../../host/db.js';
import { STORAGE_ROUTE_PREFIX, type LocalFileStorage } from '../../host/file-storage.js';
import { satisfiedFacilities, type HostIdentity, type PodHostConfig } from '../../host/types.js';
import {
	loadHostConfig,
	resolveDatabaseUrl,
	type ResolvedHostConfig,
	type StandaloneIdentityMode
} from './host-config.js';
import { startScheduler } from './scheduler.js';

const STANDALONE_BUILD_DIRECTORY = path.join('.norbital', 'build');
const REQUIRED_ENVIRONMENT = [
	'DATABASE_URL',
	'POD_HOST',
	'POD_PORT',
	'POD_ORG_ID',
	'POD_ORG_NAME',
	'POD_ADMIN_ID',
	'POD_ADMIN_NAME',
	'POD_ADMIN_EMAIL',
	'POD_TEMPLATE_KEY'
] as const;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

interface StandaloneEnvironment {
	readonly databaseUrl: string;
	readonly host: string;
	readonly port: number;
	readonly orgId: string;
	readonly orgName: string;
	readonly adminId: string;
	readonly adminName: string;
	readonly adminEmail: string;
	readonly templateKey: string;
	/** Empty unless the host authenticates with the trusted-header provider. */
	readonly trustedHostToken: string;
}

interface PodRuntimeModule {
	readonly handlePodRequest: (
		request: Request,
		bindings: RuntimeFacilityBindings
	) => Promise<Response>;
}

function requiredEnvironmentValue(name: (typeof REQUIRED_ENVIRONMENT)[number]): string {
	return process.env[name]?.trim() ?? '';
}

/**
 * Read the workspace `.env` before the environment is inspected, so a cloned template only needs
 * the file the README tells it to copy. Values already present in the real environment win, which
 * keeps CI and container overrides authoritative over a file that happens to be on disk.
 */
function loadWorkspaceEnvFile(root: string): void {
	const envPath = path.join(root, '.env');
	if (!existsSync(envPath)) return;
	try {
		process.loadEnvFile(envPath);
	} catch (cause) {
		throw new Error(`Failed to read ${envPath}`, { cause });
	}
}

export function loadStandaloneEnvironment(root?: string): StandaloneEnvironment {
	if (root) loadWorkspaceEnvFile(root);
	const missing = REQUIRED_ENVIRONMENT.filter((name) => !requiredEnvironmentValue(name));
	if (missing.length > 0) {
		throw new Error(`Missing required standalone Pod environment: ${missing.join(', ')}`);
	}

	const portValue = requiredEnvironmentValue('POD_PORT');
	const port = Number(portValue);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`POD_PORT must be an integer from 1 to 65535; received "${portValue}"`);
	}
	const host = requiredEnvironmentValue('POD_HOST');
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error(
			`POD_HOST must be a loopback address; received "${host}". Put the trusted authenticated host in front of 127.0.0.1 instead of exposing this process directly.`
		);
	}

	// Validated here rather than where it is used so a typo fails before the build is loaded and
	// the database is touched. Absence is legal: only the trusted-header provider needs it, and
	// `resolveStandaloneHost` is what refuses to install that provider without one.
	const trustedHostToken = process.env.POD_TRUSTED_HOST_TOKEN?.trim() ?? '';
	if (trustedHostToken && Buffer.byteLength(trustedHostToken, 'utf8') < 32) {
		throw new Error('POD_TRUSTED_HOST_TOKEN must contain at least 32 bytes');
	}

	return {
		databaseUrl: requiredEnvironmentValue('DATABASE_URL'),
		host,
		port,
		orgId: requiredEnvironmentValue('POD_ORG_ID'),
		orgName: requiredEnvironmentValue('POD_ORG_NAME'),
		adminId: requiredEnvironmentValue('POD_ADMIN_ID'),
		adminName: requiredEnvironmentValue('POD_ADMIN_NAME'),
		adminEmail: requiredEnvironmentValue('POD_ADMIN_EMAIL'),
		templateKey: requiredEnvironmentValue('POD_TEMPLATE_KEY'),
		trustedHostToken
	};
}

export function standaloneBuildDirectory(root: string): string {
	return path.join(root, STANDALONE_BUILD_DIRECTORY);
}

async function loadStandaloneManifest(root: string): Promise<NorbitalManifest> {
	const manifestPath = path.join(standaloneBuildDirectory(root), CHECKPOINT_MANIFEST_FILENAME);
	let source: string;
	try {
		source = await readFile(manifestPath, 'utf8');
	} catch (cause) {
		throw new Error(`Standalone Pod build is missing ${manifestPath}`, { cause });
	}
	return parseNorbitalManifest(safeParse(source));
}

export function assertStandaloneFacilities(
	manifest: NorbitalManifest,
	available: ReadonlySet<RuntimeFacilityRequirement>
): void {
	const missing = requiredRuntimeFacilities(manifest).filter(
		(facility) => !available.has(facility)
	);
	if (missing.length === 0) return;
	throw new Error(
		`Standalone Pod workspace requires unavailable runtime facilities: ${missing.join(', ')}. Run this build in a host that implements every required facility.`
	);
}

async function withPostgresTransaction(
	databaseUrl: string,
	run: (client: Client) => Promise<void>
): Promise<void> {
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		await client.query('BEGIN');
		try {
			await run(client);
			await client.query('COMMIT');
		} catch (cause) {
			await client.query('ROLLBACK');
			throw cause;
		}
	} finally {
		await client.end();
	}
}

async function bootstrapStandaloneAdmin(
	client: Client,
	environment: StandaloneEnvironment
): Promise<void> {
	const existing = await client.query<{ norbital_id: string; email: string }>(
		`SELECT norbital_id, email
		   FROM public."user"
		  WHERE norbital_id = $1::uuid OR lower(email) = lower($2)`,
		[environment.adminId, environment.adminEmail]
	);
	const mismatch = existing.rows.find(
		(row) =>
			row.norbital_id !== environment.adminId ||
			row.email.toLowerCase() !== environment.adminEmail.toLowerCase()
	);
	if (mismatch) {
		throw new Error(
			'POD_ADMIN_ID and POD_ADMIN_EMAIL must identify the same standalone user record'
		);
	}
	await client.query(
		`INSERT INTO public."user" (norbital_id, email, name, status, role, kind)
		 VALUES ($1::uuid, $2, $3, 'active', 'admin', 'human')
		 ON CONFLICT (norbital_id) DO UPDATE
		 SET email = EXCLUDED.email,
		     name = EXCLUDED.name,
		     status = 'active',
		     role = 'admin',
		     kind = 'human',
		     norbital_updated_at = CURRENT_TIMESTAMP`,
		[environment.adminId, environment.adminEmail, environment.adminName]
	);
}

export async function migrateStandalone(
	root: string,
	environment: StandaloneEnvironment
): Promise<void> {
	// The configured adapter wins over the environment: a workspace that points `pod start` at one
	// database must not have `pod migrate` quietly migrate a different one.
	const databaseUrl = await resolveDatabaseUrl(root, environment.databaseUrl);
	const binding = new PostgresHostDbBinding(databaseUrl);
	try {
		await binding.validate();
	} finally {
		await binding.close();
	}
	await withPostgresTransaction(databaseUrl, async (client) => {
		// stupidity: boundary-cast -- node-postgres and Neon expose the same query client contract.
		const migrationClient = client as unknown as NonNullable<
			Parameters<typeof applyMigrations>[0]['client']
		>;
		await applyMigrations({
			connStr: databaseUrl,
			bundleDir: standaloneBuildDirectory(root),
			client: migrationClient
		});
		await bootstrapStandaloneAdmin(client, environment);
	});
}

export async function seedStandalone(
	root: string,
	environment: StandaloneEnvironment
): Promise<void> {
	const manifestPath = path.join(standaloneBuildDirectory(root), 'seed-manifest.json');
	let source: string;
	try {
		source = await readFile(manifestPath, 'utf8');
	} catch (cause) {
		if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
			console.log('Pod workspace has no authored seed.');
			return;
		}
		throw cause;
	}
	const manifest = parseSeedManifest(safeParse(source));
	const databaseUrl = await resolveDatabaseUrl(root, environment.databaseUrl);
	await withPostgresTransaction(databaseUrl, async (client) => {
		// stupidity: boundary-cast -- seed execution uses only the shared pg query contract.
		const seedClient = client as unknown as NonNullable<
			Parameters<typeof seedTemplateDataFromPlan>[0]['client']
		>;
		await seedTemplateDataFromPlan({
			templateKey: environment.templateKey,
			plan: compiledSeedPlanFromManifest(manifest),
			orgId: environment.orgId,
			orgName: environment.orgName,
			adminId: environment.adminId,
			liveUrl: databaseUrl,
			log: (message) => console.log(message),
			client: seedClient
		});
	});
}

function appendIncomingHeaders(source: IncomingMessage, target: Headers): void {
	for (const [name, rawValue] of Object.entries(source.headers)) {
		if (Array.isArray(rawValue)) {
			for (const value of rawValue) target.append(name, value);
		} else if (rawValue != null) {
			target.set(name, rawValue);
		}
	}
}

async function requestBody(request: IncomingMessage): Promise<string | undefined> {
	if (request.method === 'GET' || request.method === 'HEAD') return undefined;
	const chunks: Uint8Array[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
	}
	return chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined;
}

/** Headers the runtime reads to establish identity. Never forwarded from the client. */
const IDENTITY_HEADERS = [
	'x-norbital-user-id',
	'x-norbital-org-id',
	'x-norbital-org-name',
	'x-norbital-base-scope-json',
	'x-norbital-host-token'
] as const;

async function toWebRequest(
	request: IncomingMessage,
	environment: StandaloneEnvironment
): Promise<Request> {
	const headers = new Headers();
	appendIncomingHeaders(request, headers);
	const body = await requestBody(request);
	return new Request(`http://${environment.host}:${environment.port}${request.url ?? '/'}`, {
		method: request.method,
		headers,
		...(body ? { body } : {})
	});
}

/**
 * Re-issue a request carrying the identity the provider established, and nothing the client sent
 * about identity.
 *
 * Stripping first is what makes any provider safe to write. The runtime trusts `x-norbital-*`
 * absolutely — that is the contract with Core, which sits behind an authenticated edge — so a
 * client that set those headers itself would otherwise be believed. A provider therefore cannot
 * accidentally pass identity through by forgetting to clear it; the only identity that survives
 * this function is the one it returned.
 */
async function withHostIdentity(request: Request, identity: HostIdentity): Promise<Request> {
	const headers = new Headers(request.headers);
	for (const name of IDENTITY_HEADERS) headers.delete(name);
	headers.set('x-norbital-user-id', identity.userId);
	headers.set('x-norbital-org-id', identity.organizationId);
	headers.set('x-norbital-org-name', identity.organizationName);
	if (identity.baseScope) {
		headers.set('x-norbital-base-scope-json', JSON.stringify(identity.baseScope));
	}
	const body =
		request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
	return new Request(request.url, {
		method: request.method,
		headers,
		...(body ? { body } : {})
	});
}

async function writeWebResponse(response: Response, target: ServerResponse): Promise<void> {
	target.statusCode = response.status;
	response.headers.forEach((value, name) => target.setHeader(name, value));

	// Stream the body incrementally when present so Server-Sent Events (the sync-engine
	// `/_runtime/sync/stream` endpoint) reach the client as they are produced rather than
	// being collapsed into one chunk. Buffered responses still work — a fully-enqueued body
	// simply flushes in one pass. The loop ends when the producer closes the stream or the
	// client disconnects (the web ReadableStream cancels, breaking the read).
	if (response.body) {
		const reader = response.body.getReader();
		target.on('close', () => {
			reader.cancel().catch(() => {});
		});
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value && !target.writableEnded) target.write(Buffer.from(value));
			}
		} catch {
			// client disconnect or producer error — fall through to end()
		}
		if (!target.writableEnded) target.end();
		return;
	}

	target.end();
}

async function loadPodRuntime(root: string): Promise<PodRuntimeModule> {
	// The same server bundle the hosted runtime container executes — standalone differs only in
	// who supplies the bindings and who owns the socket, never in the code being run.
	const runtimePath = path.join(standaloneBuildDirectory(root), 'output', 'server', 'index.js');
	const loaded: unknown = await import(pathToFileURL(runtimePath).href);
	if (
		typeof loaded !== 'object' ||
		loaded == null ||
		!('handlePodRequest' in loaded) ||
		typeof loaded.handlePodRequest !== 'function'
	) {
		throw new Error(`Invalid standalone Pod runtime artifact: ${runtimePath}`);
	}
	// stupidity: boundary-cast -- validated ESM module namespace with the generated runtime signature.
	return loaded as PodRuntimeModule;
}

async function listen(server: Server, environment: StandaloneEnvironment): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const onError = (cause: Error) => {
			server.off('listening', onListening);
			reject(cause);
		};
		const onListening = () => {
			server.off('error', onError);
			resolve();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(environment.port, environment.host);
	});
}

async function standaloneStaticAsset(
	root: string,
	request: IncomingMessage
): Promise<{ body: Buffer; contentType: string } | null> {
	if (request.method !== 'GET' && request.method !== 'HEAD') return null;
	const pathname = new URL(request.url ?? '/', 'http://pod.local').pathname;
	if (pathname.startsWith('/_pod/') || pathname.startsWith('/_runtime/')) return null;
	// A workspace app is a single-page client: unknown paths fall through to index.html below, so
	// a deep link opened directly resolves to the shell rather than a 404.
	const distRoot = path.join(standaloneBuildDirectory(root), 'dist');
	const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
	const candidate = path.normalize(path.join(distRoot, relativePath));
	if (candidate !== distRoot && !candidate.startsWith(`${distRoot}${path.sep}`)) return null;
	const read = async (filePath: string): Promise<{ body: Buffer; contentType: string } | null> => {
		try {
			return {
				body: await readFile(filePath),
				contentType: staticAssetContentType(filePath)
			};
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
			throw error;
		}
	};
	return (await read(candidate)) ?? (await read(path.join(distRoot, 'index.html')));
}

/**
 * Resolve the host configuration and refuse the combinations that are unsafe rather than merely
 * wrong.
 *
 * Both checks here are about a process that would otherwise start and look fine: a trusted-header
 * provider with no token would reject every request as unauthenticated with no hint why, and a dev
 * identity on a routable address is an open workspace. `loadStandaloneEnvironment` already refuses
 * a non-loopback bind, so the second check is defence in depth against that rule being relaxed.
 */
async function resolveStandaloneHost(
	root: string,
	environment: StandaloneEnvironment,
	identityMode: StandaloneIdentityMode
): Promise<ResolvedHostConfig> {
	if (identityMode === 'trusted-host' && !environment.trustedHostToken) {
		throw new Error(
			'POD_TRUSTED_HOST_TOKEN is required to serve with trusted-host identity. Set it, supply your own identity provider in pod.config.ts, or use `pod dev` for a local development identity.'
		);
	}
	if (identityMode === 'dev' && !LOOPBACK_HOSTS.has(environment.host)) {
		throw new Error(
			`Development identity refuses to bind ${environment.host}: it authenticates nobody. Bind a loopback address or configure a real identity provider in pod.config.ts.`
		);
	}
	return loadHostConfig({
		root,
		identityMode,
		databaseUrl: environment.databaseUrl,
		host: environment.host,
		port: environment.port,
		orgId: environment.orgId,
		orgName: environment.orgName,
		adminId: environment.adminId,
		trustedHostToken: environment.trustedHostToken
	});
}

/**
 * The presigned-URL reader, when the configured file storage has one.
 *
 * Presigning is meaningless without a server willing to redeem the URL, and only a storage
 * implementation that lives in this process needs that server — an S3-backed binding hands out
 * URLs its own provider serves. So the route is installed exactly when the binding offers to
 * resolve for it, rather than being conditioned on a particular implementation.
 */
function presignedStorage(config: PodHostConfig): LocalFileStorage | null {
	const storage = config.fileStorage;
	if (!storage) return null;
	return typeof (storage as LocalFileStorage).resolvePresigned === 'function'
		? (storage as LocalFileStorage)
		: null;
}

export type StandaloneStartOptions = {
	/**
	 * `trusted-host` keeps the deployment contract: an authenticated proxy forwards the identity it
	 * established. `dev` makes every request the bootstrapped admin, and is only reachable through
	 * `pod dev` or an explicit flag.
	 */
	readonly identityMode?: StandaloneIdentityMode;
};

/**
 * Bind the facilities the resolved host configuration provides.
 *
 * Optional facilities are omitted rather than set to `undefined` so that `requireRuntimeFacility`
 * reports "the hosting platform did not provide the X facility" — the message that tells an author
 * what to configure — instead of failing later inside a binding that does not exist.
 */
function facilityBindings(
	config: PodHostConfig,
	db: HostDbBinding
): RuntimeFacilityBindings {
	return {
		db,
		...(config.fileStorage ? { fileStorage: config.fileStorage } : {}),
		...(config.ai ? { ai: config.ai } : {}),
		...(config.notifications ? { notifications: config.notifications } : {}),
		...(config.maps ? { maps: config.maps } : {})
	};
}

function describeHost(config: PodHostConfig, stubbed: readonly string[], source: string): string {
	const supplied = ['db', ...satisfiedFacilities(config)].filter(
		(name, index, all) => all.indexOf(name) === index
	);
	const lines = [
		`[pod] host configuration: ${source}`,
		`[pod] identity provider: ${config.identity.name}`,
		`[pod] facilities: ${supplied.join(', ')}`
	];
	if (stubbed.length > 0) {
		lines.push(
			`[pod] placeholder facilities (they will fail when used): ${stubbed.join(', ')} — supply them in pod.config.ts`
		);
	}
	return lines.join('\n');
}

export async function startStandalone(
	root: string,
	environment: StandaloneEnvironment,
	options: StandaloneStartOptions = {}
): Promise<void> {
	const identityMode = options.identityMode ?? 'trusted-host';
	const { config, source, stubbed } = await resolveStandaloneHost(root, environment, identityMode);

	const manifest = await loadStandaloneManifest(root);
	assertStandaloneFacilities(manifest, satisfiedFacilities(config));

	const binding: HostDbConnection = config.db.connect();
	await binding.validate();
	const runtime = await loadPodRuntime(root);
	const bindings = facilityBindings(config, binding);
	const storage = presignedStorage(config);

	/**
	 * The host's own channel into the runtime. It carries the admin identity directly rather than
	 * going through the identity provider: the scheduler is not a request from anyone, and making
	 * it authenticate would mean every provider had to invent a service credential for it.
	 */
	const dispatch = async (body: unknown): Promise<unknown> => {
		const headers = new Headers({
			'content-type': 'application/json',
			'x-norbital-user-id': environment.adminId,
			'x-norbital-org-id': environment.orgId,
			'x-norbital-org-name': environment.orgName
		});
		const request = new Request(
			`http://${environment.host}:${environment.port}/_runtime/runtime/run`,
			{ method: 'POST', headers, body: JSON.stringify(body) }
		);
		const response = await runtime.handlePodRequest(request, bindings);
		if (!response.ok) {
			throw new Error(`Runtime rejected host dispatch (${response.status}): ${await response.text()}`);
		}
		return response.json();
	};

	const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
		const webRequest = await toWebRequest(request, environment);
		const url = new URL(webRequest.url);

		// A provider owns its routes before anything else looks at the request, so a login page is
		// reachable while unauthenticated and is never mistaken for a workspace asset.
		const routed = await config.identity.handleRoute?.(webRequest);
		if (routed) return writeWebResponse(routed, response);

		if (storage && url.pathname.startsWith(STORAGE_ROUTE_PREFIX)) {
			const object = await storage.resolvePresigned(url);
			if (!object) {
				response.statusCode = 404;
				response.end('Not Found');
				return;
			}
			response.statusCode = 200;
			response.setHeader('content-type', staticAssetContentType(object.key));
			response.setHeader('content-length', String(object.body.byteLength));
			response.end(request.method === 'HEAD' ? undefined : object.body);
			return;
		}

		const asset = await standaloneStaticAsset(root, request);
		if (asset) {
			response.statusCode = 200;
			response.setHeader('content-type', asset.contentType);
			response.setHeader('content-length', String(asset.body.byteLength));
			response.end(request.method === 'HEAD' ? undefined : asset.body);
			return;
		}

		const identity = await config.identity.authenticate(webRequest);
		if (!identity) {
			response.statusCode = 401;
			response.end('Unauthorized');
			return;
		}
		const authenticated = await withHostIdentity(webRequest, identity);
		await writeWebResponse(await runtime.handlePodRequest(authenticated, bindings), response);
	};
	const server = createServer((request, response) => {
		void handleRequest(request, response).catch((cause: unknown) => {
			console.error('[pod] request failed', cause);
			if (!response.headersSent) response.statusCode = 500;
			response.end('Internal Server Error');
		});
	});

	const scheduler = startScheduler({
		manifest,
		dispatch,
		automations: config.scheduler?.automations === true,
		...(config.integrationDelivery ? { integrationDelivery: config.integrationDelivery } : {}),
		intervalMs: config.scheduler?.intervalMs ?? 30_000
	});

	try {
		await listen(server, environment);
		console.log(describeHost(config, stubbed, source));
		console.log(`Pod listening at http://${environment.host}:${environment.port}`);
		if (identityMode === 'dev') {
			console.log(
				`[pod] DEVELOPMENT IDENTITY: every request is ${environment.adminEmail}. Never expose this process.`
			);
		}
		await new Promise<void>((resolve) => {
			process.once('SIGINT', resolve);
			process.once('SIGTERM', resolve);
		});
	} finally {
		scheduler.stop();
		await new Promise<void>((resolve, reject) => {
			server.close((cause) => (cause ? reject(cause) : resolve()));
		});
		await binding.close();
	}
}
