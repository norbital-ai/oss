import type {
	HostDbBinding,
	RuntimeFacilityName,
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
import { Client, type Notification } from 'pg';
import { PostgresHostDbBinding, type HostDbConnection } from '../../host/db.js';
import {
	assertHostPlugins,
	isIdentityDescriptor,
	isVerifiedSubject,
	satisfiedFacilities,
	type HostAppPlugin,
	type HostIdentity,
	type HostIdentityProvider,
	type HostVerifiedSubject,
	type SelfHostedPodHostConfig
} from '../../host/types.js';
import { cookieSession, subjectHmac } from '../../host/session.js';
import { emailOtpIdentity } from '../../host/email-otp.js';
import { loadHostConfig, resolveDatabaseUrl, type ResolvedHostConfig } from './host-config.js';
import { workspaceJobs } from './jobs.js';
import {
	reconcileDeclaredPolicies,
	type PolicyReconcileClient
} from '../../server/bootstrap/policy_reconcile.server.js';

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
}

interface PodRuntimeModule {
	readonly handlePodRequest: (
		request: Request,
		bindings: RuntimeFacilityBindings
	) => Promise<Response>;
	readonly handlePodHostCommand: (
		command: unknown,
		bindings: RuntimeFacilityBindings,
		identity: HostIdentity
	) => Promise<unknown>;
	readonly registerPodDatabaseNotifications: (
		source: { subscribe(listener: (channel: string, payload: string) => void): () => void } | null
	) => void;
	readonly registerPodHostPlugins: (plugins: readonly HostAppPlugin[]) => void;
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

	return {
		databaseUrl: requiredEnvironmentValue('DATABASE_URL'),
		host,
		port,
		orgId: requiredEnvironmentValue('POD_ORG_ID'),
		orgName: requiredEnvironmentValue('POD_ORG_NAME'),
		adminId: requiredEnvironmentValue('POD_ADMIN_ID'),
		adminName: requiredEnvironmentValue('POD_ADMIN_NAME'),
		adminEmail: requiredEnvironmentValue('POD_ADMIN_EMAIL'),
		templateKey: requiredEnvironmentValue('POD_TEMPLATE_KEY')
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
	available: ReadonlySet<RuntimeFacilityName>
): void {
	const missing = requiredRuntimeFacilities(manifest).filter(
		(facility) => !available.has(facility)
	);
	if (missing.length === 0) return;
	throw new Error(
		`Standalone Pod workspace requires unavailable runtime facilities: ${missing.join(', ')}. Run this build in a host that implements every required facility.`
	);
}

async function installDatabaseNotifications(
	runtime: PodRuntimeModule,
	databaseUrl: string
): Promise<() => Promise<void>> {
	const client = new Client({ connectionString: databaseUrl });
	const listeners = new Set<(channel: string, payload: string) => void>();
	await client.connect();
	client.on('notification', (message: Notification) => {
		for (const listener of listeners) listener(message.channel, message.payload ?? '');
	});
	await client.query('LISTEN norbital_sync');
	runtime.registerPodDatabaseNotifications({
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	});
	return async () => {
		runtime.registerPodDatabaseNotifications(null);
		await client.end();
	};
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
		// Declared policies land in the same transaction as the schema they grant on. A migration that
		// adds a collection and a policy that reads it must become visible together, or a deploy has a
		// window where the collection exists and nothing may touch it.
		const manifest = await loadStandaloneManifest(root);
		// stupidity: boundary-cast -- node-postgres satisfies the narrow query contract reconciliation needs.
		const reconciled = await reconcileDeclaredPolicies(
			client as unknown as PolicyReconcileClient,
			manifest
		);
		if (reconciled.created + reconciled.updated > 0) {
			console.log(
				`[pod] policies reconciled (${reconciled.created} created, ${reconciled.updated} updated).`
			);
		}
		await bootstrapStandaloneAdmin(client, environment);
	});
}

/**
 * Mint a founding invitation without starting a server.
 *
 * It boots just enough runtime to reach the private control plane — the invitation lives in the
 * tenant database and the token has to be generated there, so this cannot be a plain SQL insert.
 * Returns the accept URL for the operator to open or forward; a live invitation for the same address
 * returns `null` rather than issuing a second redeemable token.
 */
export async function inviteStandalone(
	root: string,
	environment: StandaloneEnvironment,
	email: string
): Promise<string | null> {
	const { config } = await resolveStandaloneHost(root, environment, false);
	const runtime = await loadPodRuntime(root);
	const binding: HostDbConnection = config.db.connect();
	await binding.validate();
	try {
		const result = (await runtime.handlePodHostCommand(
			{ kind: 'identity', action: 'invite', email, role: 'admin', publicUrl: config.publicUrl },
			facilityBindings(config, binding),
			{
				userId: environment.adminId,
				organizationId: environment.orgId,
				organizationName: environment.orgName
			}
		)) as { readonly acceptUrl?: string } | null;
		return result?.acceptUrl ?? null;
	} finally {
		await binding.close();
	}
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
		typeof loaded.handlePodRequest !== 'function' ||
		!('handlePodHostCommand' in loaded) ||
		typeof loaded.handlePodHostCommand !== 'function' ||
		!('registerPodDatabaseNotifications' in loaded) ||
		typeof loaded.registerPodDatabaseNotifications !== 'function' ||
		!('registerPodHostPlugins' in loaded) ||
		typeof loaded.registerPodHostPlugins !== 'function'
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
	development: boolean
): Promise<ResolvedHostConfig> {
	return loadHostConfig({
		root,
		development,
		databaseUrl: environment.databaseUrl,
		orgId: environment.orgId,
		orgName: environment.orgName,
		adminId: environment.adminId,
		publicUrl: `http://${environment.host}:${environment.port}`
	});
}

export type StandaloneStartOptions = {
	/** Core targets may be locally emulated only through `pod dev`. */
	readonly development?: boolean;
};

/**
 * Bind the facilities the resolved host configuration provides.
 *
 * Optional facilities are omitted rather than set to `undefined` so that `requireRuntimeFacility`
 * reports "the hosting platform did not provide the X facility" — the message that tells an author
 * what to configure — instead of failing later inside a binding that does not exist.
 */
function facilityBindings(
	config: SelfHostedPodHostConfig,
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

function describeHost(
	config: SelfHostedPodHostConfig,
	identity: HostIdentityProvider,
	source: string
): string {
	const supplied = [...satisfiedFacilities(config)];
	const lines = [
		`[pod] host configuration: ${source}`,
		`[pod] identity provider: ${identity.name}`,
		`[pod] facilities: ${supplied.join(', ')}`
	];
	return lines.join('\n');
}

export async function startStandalone(
	root: string,
	environment: StandaloneEnvironment,
	options: StandaloneStartOptions = {}
): Promise<void> {
	const { config, source } = await resolveStandaloneHost(
		root,
		environment,
		options.development === true
	);

	const manifest = await loadStandaloneManifest(root);
	assertStandaloneFacilities(manifest, satisfiedFacilities(config));
	// Validated before anything is served: an unusable `entry` must name its plugin here rather than
	// render into every session's sidebar.
	const hostPlugins = config.hostPlugins ?? [];
	assertHostPlugins(hostPlugins);

	const binding: HostDbConnection = config.db.connect();
	await binding.validate();
	const runtime = await loadPodRuntime(root);
	runtime.registerPodHostPlugins(hostPlugins);
	let closeDatabaseNotifications: () => Promise<void>;
	try {
		closeDatabaseNotifications = await installDatabaseNotifications(
			runtime,
			config.db.connectionString
		);
	} catch (cause) {
		await binding.close();
		throw cause;
	}
	const bindings = facilityBindings(config, binding);

	// Keys the digest the host-facing event stream carries. Absent means events carry no subject key,
	// which is honest: a host that supplied no key cannot maintain a routing index anyway.
	const subjectKey = process.env.POD_SUBJECT_HMAC_KEY?.trim() ?? '';

	/**
	 * Turn a named provider into a live one.
	 *
	 * This is the seam the descriptor exists for: delivery needs the messaging facility and the
	 * invitation lookup needs the tenant database, and neither is reachable from a configuration file.
	 * Binding here means an operator writes `emailOtp({ secret })` and gets a working login.
	 */
	const bindIdentity = (): HostIdentityProvider => {
		if (!isIdentityDescriptor(config.identity)) return config.identity;
		const descriptor = config.identity;
		const notifications = config.notifications;
		if (!notifications) {
			throw new Error(
				'emailOtp requires a notifications provider to send codes. Configure `notifications` in pod.host.ts.'
			);
		}
		return emailOtpIdentity({
			sessions: cookieSession({
				secret: descriptor.secret,
				...(descriptor.sessionTtlSeconds ? { maxAgeSeconds: descriptor.sessionTtlSeconds } : {}),
				...(descriptor.secureCookies === false ? { secure: false } : {})
			}),
			secret: descriptor.secret,
			organizationId: environment.orgId,
			organizationName: environment.orgName,
			...(descriptor.codeTtlSeconds ? { ttlSeconds: descriptor.codeTtlSeconds } : {}),
			...(descriptor.maxRequestsPerWindow
				? { maxRequestsPerWindow: descriptor.maxRequestsPerWindow }
				: {}),
			deliver: async ({ email, code }) => {
				const result = await notifications.send({
					organizationId: environment.orgId,
					channel: notifications.channels[0] ?? 'email',
					recipientUserId: email,
					subject: `Your ${environment.orgName} sign-in code`,
					message: `Your sign-in code is ${code}. It expires in ten minutes.`,
					cta: null
				});
				if (!result.sent) throw new Error(result.reason ?? 'provider refused delivery');
			},
			inviteeEmailForToken: async (token) => {
				const found = (await dispatch({
					kind: 'identity',
					action: 'invite-email',
					token
				})) as { readonly email?: string | null } | null;
				return found?.email ?? null;
			}
		});
	};

	const identity = bindIdentity();

	const dispatch = (command: unknown): Promise<unknown> =>
		runtime.handlePodHostCommand(command, bindings, {
			userId: environment.adminId,
			organizationId: environment.orgId,
			organizationName: environment.orgName
		});

	const resolveSubject = async (verified: HostVerifiedSubject): Promise<HostIdentity | null> => {
		const resolved = (await dispatch({
			kind: 'identity',
			action: 'resolve-subject',
			email: verified.subject.email,
			...(verified.subject.displayName ? { displayName: verified.subject.displayName } : {}),
			...(subjectKey ? { subjectHmac: subjectHmac(subjectKey, verified.subject.email) } : {})
		})) as { readonly userId?: string } | null;
		if (!resolved?.userId) return null;
		return {
			userId: resolved.userId,
			organizationId: verified.organizationId,
			organizationName: verified.organizationName
		};
	};

	const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
		const webRequest = await toWebRequest(request, environment);
		// A provider owns its routes before anything else looks at the request, so a login page is
		// reachable while unauthenticated and is never mistaken for a workspace asset.
		const routed = await identity.handleRoute?.(webRequest);
		if (routed) return writeWebResponse(routed, response);

		const asset = await standaloneStaticAsset(root, request);
		if (asset) {
			response.statusCode = 200;
			response.setHeader('content-type', asset.contentType);
			response.setHeader('content-length', String(asset.body.byteLength));
			response.end(request.method === 'HEAD' ? undefined : asset.body);
			return;
		}

		const authentication = await identity.authenticate(webRequest);
		if (!authentication) {
			response.statusCode = 401;
			response.end('Unauthorized');
			return;
		}
		// A provider that wants a browser to go somewhere returns the response itself. `null` still
		// means a bare 401, which is right for an API client and useless for a person.
		if (authentication instanceof Response) {
			return writeWebResponse(authentication, response);
		}
		// The provider proved an address; the directory that turns it into a user lives in the tenant
		// database, so resolution goes over the private control plane rather than here.
		const resolved = isVerifiedSubject(authentication)
			? await resolveSubject(authentication)
			: authentication;
		if (!resolved) {
			response.statusCode = 403;
			response.end('Forbidden: this address has no workspace user and no pending invitation');
			return;
		}
		const authenticated = await withHostIdentity(webRequest, resolved);
		await writeWebResponse(await runtime.handlePodRequest(authenticated, bindings), response);
	};
	const server = createServer((request, response) => {
		void handleRequest(request, response).catch((cause: unknown) => {
			console.error('[pod] request failed', cause);
			if (!response.headersSent) response.statusCode = 500;
			response.end('Internal Server Error');
		});
	});

	// The job set is built even with no queue configured, so an invalid cron expression still fails
	// at startup naming the automation rather than at the first tick that never comes.
	let stopQueue: () => void = () => {};
	try {
		const jobs = workspaceJobs({
			manifest,
			dispatch,
			organizationId: environment.orgId,
			...(config.integrationDelivery ? { integrationDelivery: config.integrationDelivery } : {}),
			...(config.notifications ? { notifications: config.notifications } : {})
		});
		if (config.queue && jobs.length > 0) stopQueue = await config.queue(jobs);
	} catch (cause) {
		await closeDatabaseNotifications();
		await binding.close();
		throw cause;
	}

	try {
		await listen(server, environment);
		console.log(describeHost(config, identity, source));
		console.log(`Pod listening at http://${environment.host}:${environment.port}`);
		if (identity.name === 'dev') {
			console.log(
				`[pod] DEVELOPMENT IDENTITY: every request is ${environment.adminEmail}. Never expose this process.`
			);
		}
		await new Promise<void>((resolve) => {
			process.once('SIGINT', resolve);
			process.once('SIGTERM', resolve);
		});
	} finally {
		stopQueue();
		await closeDatabaseNotifications();
		await new Promise<void>((resolve, reject) => {
			server.close((cause) => (cause ? reject(cause) : resolve()));
		});
		await binding.close();
	}
}
