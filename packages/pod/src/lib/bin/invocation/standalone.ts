import type {
	DbQueryConfig,
	DbQueryInput,
	DbQueryResult,
	HostDbBinding,
	RuntimeFacilityRequirement,
	RuntimeFacilityBindings
} from '@norbital-ai/platform-utils/runtime/binding';
import { requiredRuntimeFacilities } from '@norbital-ai/platform-utils/runtime/binding';
import { parseNorbitalManifest } from '@norbital-ai/platform-utils/manifest/parse';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import { BaseScopeSchema } from '@norbital-ai/platform-utils/scope/types';
import {
	CHECKPOINT_MANIFEST_FILENAME,
	staticAssetContentType
} from '@norbital-ai/platform-utils/tenant_workspace/build-output';
import { applyMigrations } from '@norbital-ai/platform-utils/tenant_workspace/migrations/apply';
import { compiledSeedPlanFromManifest } from '@norbital-ai/platform-utils/seed/plan';
import { parseSeedManifest } from '@norbital-ai/platform-utils/seed/manifest';
import { seedTemplateDataFromPlan } from '@norbital-ai/platform-utils/seed/execute';
import { safeParse } from '@norbital-ai/std/json';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, Pool, type PoolClient, type QueryResult } from 'pg';

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
	'POD_TEMPLATE_KEY',
	'POD_TRUSTED_HOST_TOKEN'
] as const;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const TRUSTED_HOST_TOKEN_HEADER = 'x-norbital-host-token';
const BUILT_IN_FACILITIES = new Set<RuntimeFacilityRequirement>(['db']);

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

export function loadStandaloneEnvironment(): StandaloneEnvironment {
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

	const trustedHostToken = requiredEnvironmentValue('POD_TRUSTED_HOST_TOKEN');
	if (Buffer.byteLength(trustedHostToken, 'utf8') < 32) {
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

function queryResult(result: QueryResult): DbQueryResult {
	return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
}

async function runQuery(
	client: Pool | PoolClient,
	input: DbQueryInput,
	params?: readonly unknown[]
): Promise<DbQueryResult> {
	if (typeof input === 'string') {
		return queryResult(await client.query(input, params ? [...params] : undefined));
	}
	const config: DbQueryConfig = input;
	return queryResult(
		await client.query({
			text: config.text,
			...(config.values ? { values: [...config.values] } : {}),
			...(config.rowMode ? { rowMode: config.rowMode } : {})
		})
	);
}

export class PostgresHostDbBinding implements HostDbBinding {
	readonly #pool: Pool;
	readonly #transactions = new Map<string, PoolClient>();

	constructor(databaseUrl: string) {
		this.#pool = new Pool({ connectionString: databaseUrl });
	}

	async validate(): Promise<void> {
		const result = await this.#pool.query<{ server_version_num: string }>(
			`SELECT current_setting('server_version_num') AS server_version_num`
		);
		const version = Number(result.rows[0]?.server_version_num);
		if (!Number.isInteger(version) || version < 180_000) {
			throw new Error(`Standalone Pod requires PostgreSQL 18 or newer; server reported ${version}`);
		}
	}

	query(sql: DbQueryInput, params?: readonly unknown[]): Promise<DbQueryResult> {
		return runQuery(this.#pool, sql, params);
	}

	async begin(): Promise<string> {
		const transactionId = crypto.randomUUID();
		const client = await this.#pool.connect();
		try {
			await client.query('BEGIN');
			this.#transactions.set(transactionId, client);
			return transactionId;
		} catch (cause) {
			client.release();
			throw cause;
		}
	}

	txQuery(
		transactionId: string,
		sql: DbQueryInput,
		params?: readonly unknown[]
	): Promise<DbQueryResult> {
		return runQuery(this.#transaction(transactionId), sql, params);
	}

	async commit(transactionId: string): Promise<void> {
		const client = this.#transaction(transactionId);
		try {
			await client.query('COMMIT');
		} finally {
			this.#transactions.delete(transactionId);
			client.release();
		}
	}

	async rollback(transactionId: string): Promise<void> {
		const client = this.#transaction(transactionId);
		try {
			await client.query('ROLLBACK');
		} finally {
			this.#transactions.delete(transactionId);
			client.release();
		}
	}

	async close(): Promise<void> {
		// stupidity:allow A6 -- each checked-out transaction must roll back before its client is released.
		for (const [transactionId, client] of this.#transactions) {
			try {
				await client.query('ROLLBACK');
			} catch (cause) {
				console.error(`[pod] failed to roll back transaction ${transactionId}`, cause);
			} finally {
				client.release();
			}
		}
		this.#transactions.clear();
		await this.#pool.end();
	}

	#transaction(transactionId: string): PoolClient {
		const client = this.#transactions.get(transactionId);
		if (!client) throw new Error(`Unknown or completed database transaction: ${transactionId}`);
		return client;
	}
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
	const binding = new PostgresHostDbBinding(environment.databaseUrl);
	try {
		await binding.validate();
	} finally {
		await binding.close();
	}
	await withPostgresTransaction(environment.databaseUrl, async (client) => {
		// stupidity: boundary-cast -- node-postgres and Neon expose the same query client contract.
		const migrationClient = client as unknown as NonNullable<
			Parameters<typeof applyMigrations>[0]['client']
		>;
		await applyMigrations({
			connStr: environment.databaseUrl,
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
	await withPostgresTransaction(environment.databaseUrl, async (client) => {
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
			liveUrl: environment.databaseUrl,
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

class StandaloneRequestError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

function trustedHostTokenMatches(provided: string, expected: string): boolean {
	const providedBytes = Buffer.from(provided, 'utf8');
	const expectedBytes = Buffer.from(expected, 'utf8');
	return (
		providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes)
	);
}

function validateForwardedIdentity(headers: Headers, environment: StandaloneEnvironment): void {
	const token = headers.get(TRUSTED_HOST_TOKEN_HEADER)?.trim() ?? '';
	if (!trustedHostTokenMatches(token, environment.trustedHostToken)) {
		throw new StandaloneRequestError(401, 'Trusted host authentication is required');
	}
	const userId = headers.get('x-norbital-user-id')?.trim() ?? '';
	const orgId = headers.get('x-norbital-org-id')?.trim() ?? '';
	const orgName = headers.get('x-norbital-org-name')?.trim() ?? '';
	const rawScope = headers.get('x-norbital-base-scope-json')?.trim() ?? '';
	let scope: unknown;
	try {
		scope = safeParse(rawScope);
	} catch {
		throw new StandaloneRequestError(401, 'Trusted host workspace scope is invalid');
	}
	const parsed = BaseScopeSchema.safeParse(scope);
	if (
		!parsed.success ||
		!userId ||
		!orgId ||
		!orgName ||
		parsed.data.requestor.norbital_id !== userId ||
		parsed.data.organization.norbital_id !== orgId ||
		parsed.data.organization.name !== orgName
	) {
		throw new StandaloneRequestError(401, 'Trusted host workspace scope is invalid');
	}
}

async function toWebRequest(
	request: IncomingMessage,
	environment: StandaloneEnvironment
): Promise<Request> {
	const headers = new Headers();
	appendIncomingHeaders(request, headers);
	const pathname = new URL(request.url ?? '/', `http://${environment.host}:${environment.port}`)
		.pathname;
	if (pathname === '/_pod/bootstrap' || pathname.startsWith('/_runtime/')) {
		validateForwardedIdentity(headers, environment);
	}
	headers.delete(TRUSTED_HOST_TOKEN_HEADER);
	const body = await requestBody(request);
	return new Request(`http://${environment.host}:${environment.port}${request.url ?? '/'}`, {
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

export async function startStandalone(
	root: string,
	environment: StandaloneEnvironment
): Promise<void> {
	assertStandaloneFacilities(await loadStandaloneManifest(root), BUILT_IN_FACILITIES);
	const binding = new PostgresHostDbBinding(environment.databaseUrl);
	await binding.validate();
	const runtime = await loadPodRuntime(root);
	const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
		try {
			const asset = await standaloneStaticAsset(root, request);
			if (asset) {
				response.statusCode = 200;
				response.setHeader('content-type', asset.contentType);
				response.setHeader('content-length', String(asset.body.byteLength));
				response.end(request.method === 'HEAD' ? undefined : asset.body);
				return;
			}
			const webRequest = await toWebRequest(request, environment);
			await writeWebResponse(await runtime.handlePodRequest(webRequest, { db: binding }), response);
		} catch (cause) {
			if (!(cause instanceof StandaloneRequestError)) throw cause;
			response.statusCode = cause.status;
			response.end(cause.message);
		}
	};
	const server = createServer((request, response) => {
		void handleRequest(request, response).catch((cause: unknown) => {
			console.error('[pod] request failed', cause);
			if (!response.headersSent) response.statusCode = 500;
			response.end('Internal Server Error');
		});
	});

	try {
		await listen(server, environment);
		console.log(`Pod listening at http://${environment.host}:${environment.port}`);
		await new Promise<void>((resolve) => {
			process.once('SIGINT', resolve);
			process.once('SIGTERM', resolve);
		});
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((cause) => (cause ? reject(cause) : resolve()));
		});
		await binding.close();
	}
}
