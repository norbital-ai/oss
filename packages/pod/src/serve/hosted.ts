/**
 * The hosted Pod server: the tenant runtime inside Core's Cube microVM.
 *
 * One HTTP server (serve/server.ts), two deployments: hosted (Cube microVM, remote facilities)
 * and standalone (pod dev/pod start, in-process facilities). This is the hosted adapter.
 *
 * This is the entry point of every hosted tenant runtime. The workspace bundle is served over one
 * HTTP port that only the host may reach: every inbound request must carry the shared host token, so
 * an unauthenticated caller is refused before any body is read and never reaches workspace code. The
 * identity a request acts under is whatever the host asserts in its `x-norbital-*` headers, which is
 * trustworthy for exactly the same reason.
 *
 * Nothing in here holds a credential. A facility the workspace needs — the tenant database, object
 * storage, a model, a map — is a call back to the host through the client below, authorized by a
 * per-sandbox secret the host resolves a tenant from. So the hosted runtime can name a facility
 * and a method, and cannot name a tenant, a database or a bucket.
 *
 * Static assets are deliberately absent. The host holds the same build output on disk and serves
 * `dist/` itself, so a page load never has to wake a runtime and this process only ever sees
 * `/_pod/bootstrap`, `/_runtime/*` and the host's own `/_host/*` control routes.
 *
 * The whole pipeline — token gate, host routes, authentication, and the final hand-off to
 * `handlePodRequest` — lives in the shared `serve/server.ts` core; this file is the adapter that
 * names the pieces and answers the host's `/_host/*` control plane.
 */
import {
	Agent as HttpAgent,
	request as httpRequest,
	type IncomingMessage,
	type ServerResponse
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { decodeWireValue, encodeWireValue } from '@norbital-ai/platform-utils/runtime/wire';
import type {
	HostAgentToolBinding,
	HostAiBinding,
	HostAppPlugin,
	HostDbBinding,
	HostFileStorageBinding,
	HostMapsBinding,
	HostMessagingBinding,
	RuntimeFacilityBindings
} from '@norbital-ai/platform-utils/runtime/binding';
import { safeParse } from '@norbital-ai/std/json';
import { setDatabaseNotifications } from '$lib/server/collection/sync/db-notifications.server.js';
import { setHostPlugins } from '$lib/server/host-plugins.js';
import { trustedHeaderIdentity } from '$lib/host/identity.js';
import { assertHostPlugins } from '../host/types.js';
import { handlePodHostCommand, type PodHostIdentity } from '../server/entry.js';
import { createPodHttpServer, type PodHttpServer } from './server.js';

/**
 * The authority workspace code sees, and the address the socket binds.
 *
 * A hosted runtime is reachable only through the host's proxy, so the URL a request arrives with says
 * nothing useful and is not read back: query parameters are parsed out of this origin instead. The
 * bind address is every interface because the proxy reaches the hosted runtime from outside it — the token is
 * what makes that safe, and it is required on every route.
 */
const GUEST_ORIGIN = 'http://tenant.local';
const BIND_ADDRESS = '0.0.0.0';
const DEFAULT_RUNTIME_PORT = 3000;

const HEALTH_PATH = '/_host/health';
const COMMAND_PATH = '/_host/command';
const NOTIFY_PATH = '/_host/notify';

type HostedEnvironment = {
	readonly port: number;
	readonly hostToken: string;
	readonly coreUrl: string;
	readonly bindingSecret: string;
};

type HostedRuntime = {
	readonly bindings: RuntimeFacilityBindings;
	readonly notify: (channel: string, payload: string) => void;
};

/**
 * The hosted runtime's channel to its host.
 *
 * A tenant runtime holds no credential and knows no address other than this one: it cannot name its
 * organization, its database, or its object store. Everything that needs one of those is a call to
 * the host over this client, authorized by a secret that was minted for this sandbox alone. The host
 * resolves which tenant the secret belongs to, which is why a request from here carries a facility, a
 * method and arguments and nothing that identifies a tenant — a hosted runtime that named its own organization
 * would be asserting the one thing it must not be able to assert.
 *
 * Arguments and results are escaped by `encodeWireValue`, because file bytes and `timestamptz`
 * values do not survive a plain JSON round trip.
 */
const BINDING_PATH = '/_internal/runtime/binding';
const CONFIGURATION_PATH = '/_internal/runtime/config';

export type CoreRuntimeClient = {
	/** Deployment configuration, read once before the runtime serves anything. */
	configuration(): Promise<readonly HostAppPlugin[]>;
	/** Invoke one host facility method. Returns the still-escaped result. */
	call(facility: string, method: string, args: readonly unknown[]): Promise<unknown>;
};

type HostReply = {
	readonly status: number;
	readonly body: string;
};

/**
 * One agent per scheme, with no timeout of any kind.
 *
 * A facility call is not a page load and has no deadline that belongs on this side. `ai.readStream`
 * waits for the next event of a model response, so the host answers it when there is something to
 * say and not before; a client-side inactivity timeout would abort exactly the calls that were
 * behaving correctly, and the symptom would be an agent turn that dies partway through a sentence.
 * Connections are kept alive because a single request can make dozens of these calls.
 */
const httpAgent = new HttpAgent({ keepAlive: true });
const httpsAgent = new HttpsAgent({ keepAlive: true });

function send(url: string, method: string, headers: Record<string, string>, body?: string) {
	const target = new URL(url);
	const secure = target.protocol === 'https:';
	const perform = secure ? httpsRequest : httpRequest;
	return new Promise<HostReply>((resolve, reject) => {
		const request = perform(
			target,
			{ method, headers, agent: secure ? httpsAgent : httpAgent },
			(response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('error', reject);
				response.on('end', () =>
					resolve({
						status: response.statusCode ?? 0,
						body: Buffer.concat(chunks).toString('utf8')
					})
				);
			}
		);
		request.on('error', reject);
		if (body == null) request.end();
		else request.end(body);
	});
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value != null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** First line of a host error body, so a failure names its cause without pasting a page of HTML. */
function summarize(body: string): string {
	const trimmed = body.trim().split('\n')[0] ?? '';
	return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

/**
 * Validate the plugin set the host supplies at boot.
 *
 * A malformed entry has to fail here, naming what was wrong. The alternative is a `TypeError` from
 * somewhere in the shell for every session of the workspace, blamed on the workspace.
 */
function parseHostPlugins(value: unknown): readonly HostAppPlugin[] {
	if (!Array.isArray(value)) {
		throw new Error('Host runtime configuration did not carry a hostPlugins array');
	}
	const plugins = value.map((entry, index) => {
		const plugin = record(entry);
		const key = plugin?.key;
		const label = plugin?.label;
		const target = plugin?.entry;
		const placement: HostAppPlugin['placement'] | null =
			plugin?.placement === 'sidebar'
				? 'sidebar'
				: plugin?.placement === 'settings'
					? 'settings'
					: null;
		if (
			typeof key !== 'string' ||
			typeof label !== 'string' ||
			typeof target !== 'string' ||
			placement == null
		) {
			throw new Error(
				`Host plugin at index ${index} is missing a string key, label and entry, or a placement of sidebar or settings`
			);
		}
		const icon = plugin?.icon;
		return {
			key,
			label,
			entry: target,
			placement,
			icon: typeof icon === 'string' ? icon : null,
			...(plugin?.adminOnly === true ? { adminOnly: true } : {})
		};
	});
	assertHostPlugins(plugins);
	return plugins;
}

export function createCoreRuntimeClient(options: {
	readonly baseUrl: string;
	readonly secret: string;
}): CoreRuntimeClient {
	const base = options.baseUrl.replace(/\/+$/, '');
	const authorization = `Bearer ${options.secret}`;
	return {
		async configuration() {
			const reply = await send(`${base}${CONFIGURATION_PATH}`, 'GET', { authorization });
			if (reply.status !== 200) {
				throw new Error(
					`Host refused the runtime configuration request (HTTP ${reply.status}): ${summarize(reply.body)}`
				);
			}
			const parsed = record(safeParse(reply.body));
			if (!parsed) throw new Error('Host runtime configuration was not a JSON object');
			return parseHostPlugins(parsed.hostPlugins);
		},
		async call(facility, method, args) {
			const reply = await send(
				`${base}${BINDING_PATH}`,
				'POST',
				{ authorization, 'content-type': 'application/json' },
				JSON.stringify({ facility, method, args: args.map(encodeWireValue) })
			);
			// A non-200 never carries a facility result, so it is a transport failure however plausible
			// its body looks. Reporting it as one keeps a revoked secret or a restarting host from
			// arriving in workspace code as `undefined`.
			if (reply.status !== 200) {
				throw new Error(
					`Host binding call ${facility}.${method} failed (HTTP ${reply.status}): ${summarize(reply.body)}`
				);
			}
			const parsed = record(safeParse(reply.body));
			if (!parsed) {
				throw new Error(`Host binding call ${facility}.${method} answered with malformed JSON`);
			}
			if (parsed.ok === true) return parsed.value;
			throw new Error(
				typeof parsed.error === 'string' && parsed.error
					? parsed.error
					: `Host binding call ${facility}.${method} was refused without a reason`
			);
		}
	};
}

/**
 * Project one host facility into the hosted runtime.
 *
 * Every facility is the same shape — forward the call, decode the result — so the bindings are
 * projections of one proxy rather than six hand-written adapters. The consequence is that a facility
 * binding may only declare *methods*: this trap answers every property get with a call forwarder, so
 * a data field on the host object arrives here as a function. Exported so a test can drive a binding
 * through the real thing rather than a look-alike.
 */
export function facilityProxy<T>(
	name: string,
	call: (facility: string, method: string, args: readonly unknown[]) => Promise<unknown>
): T {
	// stupidity:allow R3a -- Proxy needs an object target; every exposed property is trapped below.
	return new Proxy({} as Record<string, unknown>, {
		get(_target, method: string) {
			return (...args: unknown[]) => call(name, method, args).then(decodeWireValue);
		}
	}) as T;
}

/**
 * Read the hosted runtime's environment, refusing to boot on anything missing.
 *
 * The host injects these when it creates the sandbox. A hosted runtime that started without its token would
 * serve nothing, and one that started without its host address or secret would answer every request
 * with a facility failure — both are better as a process that never came up, named in the host's logs
 * beside the sandbox it belongs to.
 */
function hostedEnvironment(): HostedEnvironment {
	const value = (name: string): string => process.env[name]?.trim() ?? '';
	const required = ['POD_HOST_TOKEN', 'NORBITAL_CORE_URL', 'NORBITAL_BINDING_SECRET'] as const;
	const missing = required.filter((name) => !value(name));
	if (missing.length > 0) {
		throw new Error(`Missing required tenant runtime environment: ${missing.join(', ')}`);
	}
	const coreUrl = value('NORBITAL_CORE_URL');
	if (!/^https?:\/\/[^/]+/.test(coreUrl)) {
		throw new Error(`NORBITAL_CORE_URL must be an http or https origin; received "${coreUrl}"`);
	}
	const configuredPort = value('POD_RUNTIME_PORT');
	const port = configuredPort ? Number(configuredPort) : DEFAULT_RUNTIME_PORT;
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(
			`POD_RUNTIME_PORT must be an integer from 1 to 65535; received "${configuredPort}"`
		);
	}
	return {
		port,
		hostToken: value('POD_HOST_TOKEN'),
		coreUrl,
		bindingSecret: value('NORBITAL_BINDING_SECRET')
	};
}

function json(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.statusCode = status;
	response.setHeader('content-type', 'application/json');
	response.setHeader('content-length', String(Buffer.byteLength(payload)));
	response.end(payload);
}

function refuse(response: ServerResponse, status: number, message: string): void {
	response.statusCode = status;
	response.setHeader('content-type', 'text/plain');
	response.end(message);
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	const parsed = safeParse(Buffer.concat(chunks).toString('utf8'));
	return typeof parsed === 'object' && parsed != null && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: null;
}

/** The identity a host command runs as. Rejected rather than defaulted: there is nothing to default to. */
function commandIdentity(value: unknown): PodHostIdentity | null {
	if (typeof value !== 'object' || value == null) return null;
	const record = value as Record<string, unknown>;
	const userId = typeof record.userId === 'string' ? record.userId.trim() : '';
	const organizationId =
		typeof record.organizationId === 'string' ? record.organizationId.trim() : '';
	const organizationName =
		typeof record.organizationName === 'string' ? record.organizationName.trim() : '';
	if (!userId || !organizationId || !organizationName) return null;
	return {
		userId,
		organizationId,
		organizationName,
		...(record.baseScope != null ? { baseScope: record.baseScope } : {})
	};
}

/**
 * The host's private control plane.
 *
 * These routes reach past every tenant-facing check: a command runs jobs and writes system events,
 * and a notification wakes the change feed. The token is therefore the whole of their authorization,
 * and it has already been compared — in constant time, before a byte of any body was read — by the
 * time this runs. Returns `true` in every case: the core treats an unknown route as this handler's
 * 404 rather than falling through to tenant handling.
 */
async function handleHostRoute(
	runtime: HostedRuntime,
	pathname: string,
	request: IncomingMessage,
	response: ServerResponse
): Promise<boolean> {
	if (pathname === HEALTH_PATH) {
		if (request.method !== 'GET') {
			refuse(response, 405, 'Method Not Allowed');
			return true;
		}
		// Answering at all is the readiness signal: the socket is bound only after the deployment
		// configuration is in and the facilities are wired.
		json(response, 200, { ok: true });
		return true;
	}
	if (request.method !== 'POST') {
		refuse(response, 405, 'Method Not Allowed');
		return true;
	}
	const body = await jsonBody(request);
	if (!body) {
		refuse(response, 400, 'Expected a JSON object body');
		return true;
	}

	if (pathname === COMMAND_PATH) {
		const identity = commandIdentity(body.identity);
		if (!identity) {
			refuse(response, 400, 'Host command identity is incomplete');
			return true;
		}
		try {
			const value = await handlePodHostCommand(
				decodeWireValue(body.command),
				runtime.bindings,
				identity
			);
			json(response, 200, { ok: true, value: encodeWireValue(value) });
		} catch (caught) {
			json(response, 200, {
				ok: false,
				error: caught instanceof Error ? (caught.stack ?? caught.message) : String(caught)
			});
		}
		return true;
	}

	if (pathname === NOTIFY_PATH) {
		const { channel, payload } = body;
		if (typeof channel !== 'string' || typeof payload !== 'string') {
			refuse(response, 400, 'Expected channel and payload strings');
			return true;
		}
		runtime.notify(channel, payload);
		response.statusCode = 204;
		response.end();
		return true;
	}

	refuse(response, 404, 'Unknown host route');
	return true;
}

/**
 * Serve the workspace bundle. Called by the generated `serve.mjs` at the bundle root; never on
 * import, so the build can import this bundle to read its manifest without starting a server.
 *
 * Resolves once the port is bound, which is also the moment `/_host/health` starts to answer.
 */
export async function startPodHttpServer(): Promise<PodHttpServer> {
	const environment = hostedEnvironment();
	const core = createCoreRuntimeClient({
		baseUrl: environment.coreUrl,
		secret: environment.bindingSecret
	});
	// Deployment configuration comes before the socket, so the first request cannot arrive at a
	// workspace whose host surfaces are half-installed. Anything a browser must not be able to assert
	// travels this way rather than in a request header: a sidebar entry is the motivating case, since a
	// spoofable header would let a caller put an arbitrary link under the host's own label into every
	// session's navigation.
	setHostPlugins(await core.configuration());

	const facility = <T>(name: string): T => facilityProxy<T>(name, core.call);
	const bindings: RuntimeFacilityBindings = {
		db: facility<HostDbBinding>('db'),
		fileStorage: facility<HostFileStorageBinding>('fileStorage'),
		ai: facility<HostAiBinding>('ai'),
		messaging: facility<HostMessagingBinding>('messaging'),
		maps: facility<HostMapsBinding>('maps'),
		agentTools: facility<HostAgentToolBinding>('agentTools')
	};

	// The host owns the LISTEN connection (one per tenant database, shared by every runtime on it) and
	// pushes each notification in. The sync stream waits on this instead of asking the database
	// whether anything changed.
	const listeners = new Set<(channel: string, payload: string) => void>();
	setDatabaseNotifications({
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	});

	const runtime: HostedRuntime = {
		bindings,
		notify: (channel, payload) => {
			for (const listener of listeners) listener(channel, payload);
		}
	};

	return createPodHttpServer({
		origin: GUEST_ORIGIN,
		bind: { host: BIND_ADDRESS, port: environment.port },
		label: '[tenant-runtime]',
		token: environment.hostToken,
		identity: trustedHeaderIdentity({ token: environment.hostToken }),
		bindings,
		hostRoutes: (pathname, request, response) =>
			handleHostRoute(runtime, pathname, request, response)
	});
}
