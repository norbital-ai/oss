/**
 * The standalone Pod server: `pod start`, and the operations that share its pipeline.
 *
 * One HTTP server (serve/server.ts), two deployments: hosted (Cube microVM, remote facilities)
 * and standalone (pod dev/pod start, in-process facilities). This is the standalone adapter.
 *
 * This is the standalone counterpart of `serve/hosted.ts`. Where the hosted adapter trusts a host
 * proxy for identity and serves only runtime routes, this process authenticates itself (via the
 * resolved host configuration), serves the workspace's static assets and single-page document, and
 * runs jobs, channels, and webhook listeners in the same process. Both adapters delegate their
 * whole request pipeline to the shared `serve/server.ts` core, which hands the request to the
 * `handlePodRequest`/`handlePodHostCommand` entry points.
 *
 * The `pod` CLI (`bin/invocation/index.ts`) imports the operations here directly.
 */
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
import { type IncomingMessage } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, type Notification } from 'pg';
import { PostgresHostDbBinding, type HostDbConnection } from '../host/db.js';
import {
	assertHostPlugins,
	isIdentityDescriptor,
	satisfiedFacilities,
	type ChannelInboundMessage,
	type ChannelInboundResult,
	type HostAppPlugin,
	type HostIdentity,
	type HostIdentityProvider,
	type HostVerifiedSubject,
	type SelfHostedPodHostConfig
} from '../host/types.js';
import { assertHostAgentTools, hostAgentTools } from '../host/agent-tools.js';
import { createPodHttpServer } from './server.js';
import { cookieSession, subjectHmac } from '../host/session.js';
import { emailOtpIdentity } from '../host/email-otp.js';
import { assertChannelTransportsAreSupported } from '../authoring/channels/channels.js';
import { loadHostConfig, resolveDatabaseUrl, type ResolvedHostConfig } from '../host/config.js';
import { workspaceJobs } from '../host/jobs.js';
import { declaredWebhookBindings, webhookInboundDeliverer } from '../host/webhook-inbound.js';
import {
	reconcileDeclaredPolicies,
	type PolicyReconcileClient
} from '../server/bootstrap/policy_reconcile.server.js';
import { reconcileDeclaredChannels } from '../server/bootstrap/channel_reconcile.server.js';

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

/** Every distinct transport this workspace's channels name, in a stable order. */
export function manifestChannelTransports(manifest: NorbitalManifest): readonly string[] {
	return [
		...new Set(Object.values(manifest.channels ?? {}).map((channel) => channel.transport))
	].sort();
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
		// After the policies, because a channel principal's team points at one: a channel declaring a
		// policy this deploy also introduces must find it already there.
		const channels = await reconcileDeclaredChannels(
			// stupidity: boundary-cast -- node-postgres satisfies the narrow query contract reconciliation needs.
			client as unknown as PolicyReconcileClient,
			manifest
		);
		if (channels.created + channels.updated > 0) {
			console.log(
				`[pod] channel principals reconciled (${channels.created} created, ${channels.updated} updated).`
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
		// Reconcile again, because the seed is where teams come from.
		//
		// An approval names its approvers by `team.name`, and at `pod migrate` there is no team to
		// resolve against — the gates land stored but without approvers. This is the first moment the
		// teams exist, so binding them here is what closes that window rather than leaving it to the
		// operator to remember a second migrate.
		const reconciled = await reconcileDeclaredPolicies(
			// stupidity: boundary-cast -- node-postgres satisfies the narrow query contract reconciliation needs.
			client as unknown as PolicyReconcileClient,
			await loadStandaloneManifest(root)
		);
		if (reconciled.created + reconciled.updated > 0) {
			console.log(
				`[pod] policies re-reconciled against seeded teams (${reconciled.updated} updated).`
			);
		}
	});
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

/**
 * Resolve the host configuration for a standalone run.
 *
 * A thin delegation to `loadHostConfig`, which owns the refusals: a `mode: 'core'` config cannot run
 * under `pod start` outside development emulation. The dev-identity-on-a-routable-address case is
 * enforced upstream instead — `loadStandaloneEnvironment` refuses a non-loopback bind.
 */
async function resolveStandaloneHost(
	root: string,
	environment: StandaloneEnvironment,
	development: boolean,
	channelTransports: readonly string[] = []
): Promise<ResolvedHostConfig> {
	return loadHostConfig({
		root,
		development,
		databaseUrl: environment.databaseUrl,
		orgId: environment.orgId,
		orgName: environment.orgName,
		adminId: environment.adminId,
		publicUrl: `http://${environment.host}:${environment.port}`,
		channelTransports
	});
}

type StandaloneStartOptions = {
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
		...(config.messaging ? { messaging: config.messaging } : {}),
		...(config.maps ? { maps: config.maps } : {}),
		...(config.agentTools && config.agentTools.length > 0
			? { agentTools: hostAgentTools(config.agentTools) }
			: {})
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
	// The manifest is read before the host is resolved because `pod dev` stands in for the transports
	// the workspace declares, and it cannot do that without knowing what they are.
	const manifest = await loadStandaloneManifest(root);
	const { config, source } = await resolveStandaloneHost(
		root,
		environment,
		options.development === true,
		manifestChannelTransports(manifest)
	);

	assertStandaloneFacilities(manifest, satisfiedFacilities(config));
	// A channel names a wire only the host can hold open, so this is the last cross-reference in the
	// startup set: a name that matches nothing must fail here rather than at the first inbound message.
	assertChannelTransportsAreSupported(
		manifest.channels ?? {},
		new Set(config.messaging ? await config.messaging.listTransports() : [])
	);
	// The other cross-reference the host owns: a host tool that shadows a workspace one, or an agent
	// naming a host tool nobody supplies. Both are silent at runtime — a shadowed workspace tool keeps
	// compiling and simply stops being what runs — so they are settled here, before the first run.
	assertHostAgentTools(config.agentTools ?? [], manifest);
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
		const messaging = config.messaging;
		if (!messaging) {
			throw new Error(
				'emailOtp requires a messaging provider to send codes. Configure `messaging` in pod.host.ts.'
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
			// The challenge cookie needs this as much as the session one: a `Secure` challenge over a
			// loopback HTTP bind is dropped by the browser, and sign-in then fails with nothing logged.
			...(descriptor.secureCookies === false ? { secureCookies: false } : {}),
			deliver: async ({ email, code }) => {
				const channels = await messaging.listChannels();
				const result = await messaging.send({
					organizationId: environment.orgId,
					channel: channels[0] ?? 'email',
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

	const origin = `http://${environment.host}:${environment.port}`;

	/**
	 * A real file from `dist/`, for a request that has not authenticated yet.
	 *
	 * Only a file that actually exists. The single-page fallback to index.html deliberately does not
	 * happen here: this runs *before* authentication, so falling back would serve the app shell — and
	 * every unknown deep link — to anyone. `appDocument` does it after a session is proven.
	 */
	const staticAssets = async (
		request: IncomingMessage
	): Promise<{ body: Buffer; contentType: string } | null> => {
		if (request.method !== 'GET' && request.method !== 'HEAD') return null;
		const pathname = new URL(request.url ?? '/', 'http://pod.local').pathname;
		if (pathname.startsWith('/_pod/') || pathname.startsWith('/_runtime/')) return null;
		const distRoot = path.join(standaloneBuildDirectory(root), 'dist');
		const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '');
		// `/` is the app document, not an asset. Resolving it here would serve the shell before the
		// session is checked, which is the same hole as the removed fallback — `appDocument` owns it.
		if (relativePath === '' || relativePath === 'index.html') return null;
		const candidate = path.normalize(path.join(distRoot, relativePath));
		if (candidate !== distRoot && !candidate.startsWith(`${distRoot}${path.sep}`)) return null;
		const read = async (
			filePath: string
		): Promise<{ body: Buffer; contentType: string } | null> => {
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
		return read(candidate);
	};

	/**
	 * The single-page shell, for a request that authenticated and matched no real file.
	 *
	 * A deep link opened directly has to resolve to the shell rather than a 404, but it is a *document*,
	 * so it belongs behind the session rather than beside the JavaScript. Serving it before authentication
	 * meant an anonymous visitor got a shell that booted, fired its first sync call, received a redirect to
	 * the login page in place of JSON, and failed — instead of simply landing on the login page.
	 */
	const appDocument = async (
		request: IncomingMessage
	): Promise<{ body: Buffer; contentType: string } | null> => {
		if (request.method !== 'GET' && request.method !== 'HEAD') return null;
		// The runtime owns its own prefixes. Returning the shell for one would answer a bootstrap or sync
		// call with HTML, which the client then fails to parse — the same confusion the pre-auth fallback
		// caused, just moved behind the session.
		const pathname = new URL(request.url ?? '/', 'http://pod.local').pathname;
		if (pathname.startsWith('/_pod/') || pathname.startsWith('/_runtime/')) return null;
		const distRoot = path.join(standaloneBuildDirectory(root), 'dist');
		try {
			const indexPath = path.join(distRoot, 'index.html');
			return { body: await readFile(indexPath), contentType: staticAssetContentType(indexPath) };
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
			throw error;
		}
	};

	/**
	 * Hand one already-authenticated inbound message to the workspace.
	 *
	 * It goes over the private control plane rather than `handlePodRequest` for the same reason job
	 * dispatch does: nothing a tenant request can reach may run the agent as a channel principal.
	 */
	const deliverChannelInbound = async (
		message: ChannelInboundMessage
	): Promise<ChannelInboundResult> => {
		const outcome = (await dispatch({
			kind: 'channel',
			action: 'inbound',
			channel: message.channel,
			conversationId: message.conversationId,
			messageId: message.messageId,
			text: message.text,
			...(message.sender ? { sender: message.sender } : {})
		})) as ChannelInboundResult;
		return outcome;
	};

	/**
	 * Hand one webhook delivery to the workspace, once its signature has been checked.
	 *
	 * The verification is inside `webhookInboundDeliverer`, not in the listener, so a host that writes
	 * its own endpoint cannot accidentally skip it. Like the channel path, it crosses the private
	 * control plane rather than `handlePodRequest`: an integration writes collections elevated, and
	 * nothing a tenant request can reach may do that.
	 */
	const webhookBindings = declaredWebhookBindings(manifest);
	const deliverWebhookInbound = webhookInboundDeliverer({
		manifest,
		dispatch,
		...(config.secrets ? { secrets: config.secrets } : {})
	});
	if (webhookBindings.length > 0 && !config.webhooks) {
		// Not fatal: a host may own the endpoint outside this process and call `deliver` itself. But a
		// declared webhook with nothing listening is indistinguishable from a provider that never fires,
		// so say it once — the same reason the channel warning below exists.
		console.warn(
			`[pod] webhook receive bindings are declared but this host supplies no listener: ${webhookBindings
				.map((webhook) => `${webhook.integrationName}.${webhook.bindingName}`)
				.join(', ')}. Nothing will arrive. Set \`webhooks\` in pod.host.ts.`
		);
	}
	const unsigned = webhookBindings.filter((webhook) => !webhook.signed);
	if (config.webhooks && unsigned.length > 0) {
		// A binding with no `authentication` accepts whatever the listener hands over. That is legitimate
		// when the host proves the sender some other way — mutual TLS, a private network — and a mistake
		// otherwise, and the two look identical from here.
		console.warn(
			`[pod] webhook bindings declare no signature and are accepted unverified: ${unsigned
				.map((webhook) => `${webhook.integrationName}.${webhook.bindingName}`)
				.join(', ')}. Declare \`authentication\` unless this host proves the sender itself.`
		);
	}

	const declaredChannels = Object.keys(manifest.channels ?? {});
	if (declaredChannels.length > 0 && !config.channels) {
		// Not fatal: a host may drive inbound from outside this process. But a workspace that declares a
		// channel and never receives on it looks identical to a broken transport, so say it once.
		console.warn(
			`[pod] channels declared but this host supplies no inbound listener: ${declaredChannels.join(', ')}. ` +
				'Replies can be sent; nothing will arrive. Set `channels` in pod.host.ts.'
		);
	}

	// The job set is built even with no queue configured, so an invalid cron expression still fails
	// at startup naming the automation rather than at the first tick that never comes.
	let stopQueue: () => void = () => {};
	try {
		const jobs = workspaceJobs({
			manifest,
			dispatch,
			organizationId: environment.orgId,
			...(config.integrationDelivery ? { integrationDelivery: config.integrationDelivery } : {}),
			...(config.messaging ? { messaging: config.messaging } : {}),
			...(config.secrets ? { secrets: config.secrets } : {})
		});
		if (config.queue && jobs.length > 0) stopQueue = await config.queue(jobs);
	} catch (cause) {
		await closeDatabaseNotifications();
		await binding.close();
		throw cause;
	}

	let stopChannels: () => void = () => {};
	if (config.channels) {
		try {
			stopChannels = await config.channels(deliverChannelInbound);
		} catch (cause) {
			stopQueue();
			await closeDatabaseNotifications();
			await binding.close();
			throw cause;
		}
	}

	let stopWebhooks: () => void = () => {};
	if (config.webhooks) {
		try {
			stopWebhooks = await config.webhooks(deliverWebhookInbound, webhookBindings);
		} catch (cause) {
			stopChannels();
			stopQueue();
			await closeDatabaseNotifications();
			await binding.close();
			throw cause;
		}
	}

	// The socket binds only after the queue, channels, and webhooks are wired: the first request must
	// not arrive at a workspace whose scheduled work and inbound listeners are half-installed. The
	// request pipeline itself is the shared core, which hands tenant traffic to the bundled runtime —
	// the same bundle the workspace was registered into, and the same instance `dispatch` runs host
	// commands in.
	let stopHttpServer: (() => Promise<void>) | null = null;
	try {
		const podServer = await createPodHttpServer({
			origin,
			bind: environment,
			identity,
			bindings,
			staticAssets,
			appDocument,
			resolveSubject,
			handlePodRequest: runtime.handlePodRequest
		});
		stopHttpServer = podServer.close;
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
		stopWebhooks();
		stopChannels();
		stopQueue();
		await closeDatabaseNotifications();
		if (stopHttpServer) await stopHttpServer();
		await binding.close();
	}
}
