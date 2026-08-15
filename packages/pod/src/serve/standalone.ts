/**
 * In-process `pod start` only. This file is the reference host: it implements the host API and
 * loads the compiled bundle with a native Node `import()`.
 *
 * Core does not boot this process. It compiles the same `output/server/index.js` in isolate-vm
 * and calls `dispatch`. There is no guest HTTP listener.
 *
 * This process authenticates itself (via the resolved host configuration), serves the workspace's
 * static assets and single-page document, and runs jobs, channels, and webhook listeners in the
 * same process. The HTTP pipeline lives in `serve/server.ts` and maps each request onto
 * `dispatch`. Timeout is host policy on admit (`config.timeoutMs ?? 2_000`); that 2_000 is this
 * host's default, not a Pod contract. The guest reads `remainingMs()`.
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
import { Client } from 'pg';
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
import { AsyncLocalStorage } from 'node:async_hooks';
import { startAdmit, type PodAdmit } from '../server/admit.js';
import { isHostSyncStreamPath, serveHostSyncStream } from '../host/sync-stream.js';
import { attachSyncWakeToDb, createInProcessSyncWakeBus } from '../host/sync-wake.js';
import { createPodHttpServer } from './server.js';
import { cookieSession, subjectHmac } from '../host/session.js';
import { emailOtpIdentity } from '../host/email-otp.js';
import { serverI18n } from '$lib/i18n/index.js';
import { assertChannelTransportsAreSupported } from '../authoring/channels/channels.js';
import { loadHostConfig, resolveDatabaseUrl, type ResolvedHostConfig } from '../host/config.js';
import { workspaceJobs } from '../host/jobs.js';
import { isHostMailCommand, runHostMail } from '../host/mail.js';
import {
	ADMIT_ARTIFACT_HEADER,
	serializeAdmitArtifact,
	withAdmitArtifact
} from '../host/admit-artifact.js';
import { standaloneAutomationJobs, STANDALONE_AUTOMATION_ARTIFACT } from './standalone-automation.js';
import { declaredWebhookBindings, webhookInboundDeliverer } from '../host/webhook-inbound.js';
import {
	reconcileDeclaredPolicies
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

/** The compiled guest bundle this host loads and admits functions into. */
interface PodRuntimeModule {
	readonly dispatch?: (
		name: string,
		payload: unknown,
		bindings: RuntimeFacilityBindings,
		admit?: PodAdmit | null
	) => Promise<unknown>;
	readonly handlePodHostCommand?: (command: unknown) => Promise<unknown>;
	readonly registerPodHostPlugins: (plugins: readonly HostAppPlugin[]) => void;
}

const ADMIT_HEADER_NAMES = new Set(['x-norbital-timeout-ms', 'x-norbital-deadline-at']);

/** Runtime path without `/_runtime/`. */
function runtimeNameFromPath(pathname: string): string {
	if (pathname.startsWith('/_runtime/')) return pathname.slice('/_runtime/'.length);
	return pathname.replace(/^\//, '');
}

/** Identity headers only — admit is an argument to `dispatch`, never a guest header. */
function requestIdentityHeaders(request: Request): Record<string, string> {
	const headers: Record<string, string> = {};
	request.headers.forEach((value, name) => {
		if (ADMIT_HEADER_NAMES.has(name.toLowerCase())) return;
		headers[name] = value;
	});
	return headers;
}

/** Map one authenticated HTTP request onto the guest `dispatch` door. */
async function dispatchHttpRequest(
	runtime: PodRuntimeModule,
	request: Request,
	bindings: RuntimeFacilityBindings,
	admit: PodAdmit | null
): Promise<Response> {
	const url = new URL(request.url);
	const body =
		request.method === 'GET' || request.method === 'HEAD' ? null : await request.text();
	const headers = requestIdentityHeaders(request);
	headers[ADMIT_ARTIFACT_HEADER] = serializeAdmitArtifact(STANDALONE_AUTOMATION_ARTIFACT);
	const result = (await dispatchGuest(
		runtime,
		runtimeNameFromPath(url.pathname),
		{
			method: request.method,
			search: url.search,
			headers,
			body
		},
		bindings,
		admit
	)) as { readonly status: number; readonly headers: Record<string, string>; readonly bodyText: string };
	return new Response(result.bodyText, { status: result.status, headers: result.headers });
}

/** Guest named dispatch, or the previous `handlePodHostCommand` export during transition. */
function dispatchGuest(
	runtime: PodRuntimeModule,
	name: string,
	payload: unknown,
	bindings: RuntimeFacilityBindings,
	admit: PodAdmit | null
): Promise<unknown> {
	if (typeof runtime.dispatch === 'function') {
		return runtime.dispatch(name, payload, bindings, admit);
	}
	if (typeof runtime.handlePodHostCommand === 'function') {
		return runtime.handlePodHostCommand(payload);
	}
	throw new Error('Pod runtime is missing dispatch');
}

/** Map one host command onto host mail or guest `dispatch(kind, command, bindings, admit)`. */
function dispatchHostCommand(
	runtime: PodRuntimeModule,
	command: unknown,
	bindings: RuntimeFacilityBindings,
	identity: HostIdentity,
	admit: PodAdmit | null,
	manifest: NorbitalManifest,
	db: HostDbBinding
): Promise<unknown> {
	if (isHostMailCommand(command)) {
		return runHostMail({ db, manifest, command });
	}
	const guestCommand = withAdmitArtifact(command, STANDALONE_AUTOMATION_ARTIFACT);
	const kind =
		guestCommand != null && typeof guestCommand === 'object' && 'kind' in guestCommand
			? String((guestCommand as { kind: unknown }).kind)
			: '';
	return dispatchGuest(
		runtime,
		kind,
		{
			...(guestCommand != null && typeof guestCommand === 'object' ? guestCommand : { command: guestCommand }),
			identity
		},
		bindings,
		admit
	);
}

/** Read one required `POD_*` / `DATABASE_URL` value from the process environment. */
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

/** Load and validate the reference host's process environment, optionally from a workspace `.env`. */
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

/** Absolute path to the workspace's compiled `.norbital/build` directory. */
export function standaloneBuildDirectory(root: string): string {
	return path.join(root, STANDALONE_BUILD_DIRECTORY);
}

/** Read the compiled workspace manifest from the reference host's build output. */
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

/** Refuse to start when the workspace names a facility this host does not supply. */
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

/** Run `run` inside one PostgreSQL transaction and roll back on failure. */
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

/** Insert or refresh the founding admin row this host's environment names. */
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
		const reconciled = await reconcileDeclaredPolicies(
			client,
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
			client,
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
		const result = (await dispatchHostCommand(
			runtime,
			{ kind: 'identity', action: 'invite', email, role: 'admin', publicUrl: config.publicUrl },
			facilityBindings(config, binding),
			{
				userId: environment.adminId,
				organizationId: environment.orgId,
				organizationName: environment.orgName
			},
			startAdmit(config.timeoutMs ?? 2_000),
			await loadStandaloneManifest(root),
			binding
		)) as { readonly acceptUrl?: string } | null;
		return result?.acceptUrl ?? null;
	} finally {
		await binding.close();
	}
}

/** Apply the workspace's authored seed into the tenant database. */
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
			client: seedClient,
			transaction: 'external'
		});
		// Reconcile again, because the seed is where teams come from.
		//
		// An approval names its approvers by `team.name`, and at `pod migrate` there is no team to
		// resolve against — the gates land stored but without approvers. This is the first moment the
		// teams exist, so binding them here is what closes that window rather than leaving it to the
		// operator to remember a second migrate.
		const reconciled = await reconcileDeclaredPolicies(
			client,
			await loadStandaloneManifest(root)
		);
		if (reconciled.created + reconciled.updated > 0) {
			console.log(
				`[pod] policies re-reconciled against seeded teams (${reconciled.updated} updated).`
			);
		}
	});
}

/** Import the compiled guest bundle this host will admit functions into. */
async function loadPodRuntime(root: string): Promise<PodRuntimeModule> {
	// Same `output/server/index.js` Core loads in isolate-vm and calls via `dispatch`.
	// This host `import()`s it in-process; only the bindings and the socket differ.
	(globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage ??=
		AsyncLocalStorage;
	const runtimePath = path.join(standaloneBuildDirectory(root), 'output', 'server', 'index.js');
	const loaded: unknown = await import(pathToFileURL(runtimePath).href);
	if (typeof loaded !== 'object' || loaded == null) {
		throw new Error(`Invalid standalone Pod runtime artifact: ${runtimePath}`);
	}
	const hasDispatch = 'dispatch' in loaded && typeof loaded.dispatch === 'function';
	const hasLegacyHost =
		'handlePodHostCommand' in loaded && typeof loaded.handlePodHostCommand === 'function';
	if (
		(!hasDispatch && !hasLegacyHost) ||
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

/** One startup log block naming the host config, identity provider, and facilities. */
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

	const connected: HostDbConnection = config.db.connect();
	await connected.validate();
	const runtime = await loadPodRuntime(root);
	runtime.registerPodHostPlugins(hostPlugins);
	const syncWake = createInProcessSyncWakeBus();
	const binding = attachSyncWakeToDb(connected, syncWake, environment.orgId);
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
			deliver: async ({ email, code, locale }) => {
				const channels = await messaging.listChannels();
				const i18n = serverI18n(locale);
				const result = await messaging.send({
					organizationId: environment.orgId,
					channel: channels[0] ?? 'email',
					recipientUserId: email,
					subject: i18n.t('pod.email.loginSubjectOrg', { workspace: environment.orgName }),
					message: i18n.t('pod.email.loginBody', { code, minutes: 10 }),
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

	const hostTimeoutMs = config.timeoutMs ?? 2_000;
	const dispatch = (command: unknown): Promise<unknown> =>
		dispatchHostCommand(
			runtime,
			command,
			bindings,
			{
				userId: environment.adminId,
				organizationId: environment.orgId,
				organizationName: environment.orgName
			},
			startAdmit(hostTimeoutMs),
			manifest,
			binding
		);

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
	 * It goes over the private control plane rather than HTTP `dispatch` for the same reason job
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
	 * control plane rather than HTTP `dispatch`: an integration writes collections elevated, and
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
		const jobs = [
			...workspaceJobs({
				manifest,
				dispatch,
				db: binding,
				organizationId: environment.orgId,
				...(config.integrationDelivery ? { integrationDelivery: config.integrationDelivery } : {}),
				...(config.messaging ? { messaging: config.messaging } : {}),
				...(config.secrets ? { secrets: config.secrets } : {})
			}),
			...standaloneAutomationJobs({
				manifest,
				dispatch,
				query: (sql, values) => binding.query(sql, values),
				...(config.ai ? { ai: config.ai } : {})
			})
		];
		if (config.queue && jobs.length > 0) stopQueue = await config.queue(jobs);
	} catch (cause) {
		await binding.close();
		throw cause;
	}

	let stopChannels: () => void = () => {};
	if (config.channels) {
		try {
			stopChannels = await config.channels(deliverChannelInbound);
		} catch (cause) {
			stopQueue();
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
			handlePodRequest: async (request, requestBindings) => {
				const admit = startAdmit(hostTimeoutMs);
				if (isHostSyncStreamPath(new URL(request.url).pathname)) {
					const served = serveHostSyncStream({
						path: `${new URL(request.url).pathname}${new URL(request.url).search}`,
						signal: request.signal,
						pullDiff: async (diffPath) => {
							const diffUrl = new URL(diffPath, 'http://pod.local');
							const pulled = (await dispatchGuest(
								runtime,
								runtimeNameFromPath(diffUrl.pathname),
								{
									method: 'GET',
									search: diffUrl.search,
									headers: requestIdentityHeaders(request),
									body: null
								},
								requestBindings,
								admit
							)) as {
								readonly status: number;
								readonly bodyText: string;
							};
							return { status: pulled.status, bodyText: pulled.bodyText };
						},
						subscribe: (wake) =>
							syncWake.subscribeSyncWake(environment.orgId, () => wake()),
						lastSeq: () => syncWake.lastSyncSeq(environment.orgId)
					});
					return new Response(served.body, { status: served.status, headers: served.headers });
				}
				return dispatchHttpRequest(runtime, request, requestBindings, admit);
			},
			timeoutMs: hostTimeoutMs
		});
		stopHttpServer = podServer.close;
		console.log(describeHost(config, identity, source));
		console.log(`Reference host listening at http://${environment.host}:${environment.port}`);
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
		if (stopHttpServer) await stopHttpServer();
		await binding.close();
	}
}
