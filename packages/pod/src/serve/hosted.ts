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
 * Nothing in here holds a credential, and nothing in here dials out. A facility the workspace needs —
 * the tenant database, object storage, a model, a map — is a call down the channel the host opened on
 * this process's own stdio (`serve/stdio.ts`), and the host resolves the tenant from the session it
 * started. So the hosted runtime can name a facility and a method, and cannot name a tenant, a
 * database or a bucket. There is no second transport: a sealed sandbox has no route to the host, so a
 * guest that dials out is a guest that cannot run.
 *
 * Static assets are deliberately absent. The host holds the same build output on disk and serves
 * `dist/` itself, so a page load never has to wake a runtime and this process only ever sees
 * `/_pod/bootstrap`, `/_runtime/*` and the host's own `/_host/*` control routes.
 *
 * The whole pipeline — token gate, host routes, authentication, and the final hand-off to
 * `handlePodRequest` — lives in the shared `serve/server.ts` core; this file is the adapter that
 * names the pieces and answers the host's `/_host/*` control plane.
 */
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { decodeWireValue, encodeWireValue } from '@norbital-ai/platform-utils/runtime/wire';
import type {
	HostAgentToolBinding,
	HostAiBinding,
	HostDbBinding,
	HostFileStorageBinding,
	HostMapsBinding,
	HostMessagingBinding,
	HostRuntimeLifecycleBinding,
	RuntimeFacilityBindings
} from '@norbital-ai/platform-utils/runtime/binding';
import { safeParse } from '@norbital-ai/std/json';
import { setDatabaseNotifications } from '$lib/server/collection/sync/db-notifications.server.js';
import { setHostPlugins } from '$lib/server/host-plugins.js';
import { trustedHeaderIdentity } from '$lib/host/identity.js';
import { handlePodHostCommand, type PodHostIdentity } from '../server/entry.js';
import { createPodHttpServer, type PodHttpServer } from './server.js';
import { claimStdoutForFrames, createStdioRuntimeClient } from './stdio.js';

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

/**
 * What the host injected.
 *
 * Two values, and neither is a credential for reaching the host: the channel the host opened *is*
 * the capability, so there is no address to configure and no shared secret crosses the guest
 * boundary. `POD_HOST_TOKEN` faces the other way — it gates traffic arriving from the host's proxy.
 */
type HostedEnvironment = { readonly port: number; readonly hostToken: string };

type HostedRuntime = {
	readonly bindings: RuntimeFacilityBindings;
	readonly notify: (channel: string, payload: string) => void;
};

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
 * The host injects these when it creates the sandbox. A hosted runtime that started without its token
 * would serve nothing — better as a process that never came up, named in the host's logs beside the
 * sandbox it belongs to. Exported so a test can assert that without setting process-wide state.
 */
export function hostedEnvironment(
	env: Readonly<Record<string, string | undefined>> = process.env
): HostedEnvironment {
	const value = (name: string): string => env[name]?.trim() ?? '';
	const hostToken = value('POD_HOST_TOKEN');
	if (!hostToken) {
		throw new Error('Missing required tenant runtime environment: POD_HOST_TOKEN');
	}
	const configuredPort = value('POD_RUNTIME_PORT');
	const port = configuredPort ? Number(configuredPort) : DEFAULT_RUNTIME_PORT;
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(
			`POD_RUNTIME_PORT must be an integer from 1 to 65535; received "${configuredPort}"`
		);
	}
	return { port, hostToken };
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
 * Serve the workspace bundle over the channel the host opened. Called by the generated `serve.mjs` at
 * the bundle root; never on import, so the build can import this bundle to read its manifest without
 * starting a server.
 *
 * Resolves once the port is bound, which is also the moment `/_host/health` starts to answer and the
 * moment the `ready` frame goes out — the host waits on that rather than on the process existing.
 *
 * stdout is claimed for frames before anything else happens. A channel that breaks ends the process,
 * because there is nothing to resynchronise on and a runtime that cannot reach its facilities can
 * only answer failures; exiting hands the host a session to evict and the next request a cold boot.
 */
export async function startPodHttpServer(): Promise<PodHttpServer> {
	const environment = hostedEnvironment();
	const writeFrame = claimStdoutForFrames({ stdout: process.stdout, stderr: process.stderr });
	const core = createStdioRuntimeClient({
		input: process.stdin,
		writeFrame,
		onFatal: (error) => {
			process.stderr.write(`[tenant-runtime] host channel failed: ${error.message}\n`);
			process.exit(1);
		},
		onClosed: () => process.exit(0)
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
		agentTools: facility<HostAgentToolBinding>('agentTools'),
		runtimeLifecycle: facility<HostRuntimeLifecycleBinding>('runtimeLifecycle')
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

	const server = await createPodHttpServer({
		origin: GUEST_ORIGIN,
		bind: { host: BIND_ADDRESS, port: environment.port },
		label: '[tenant-runtime]',
		token: environment.hostToken,
		identity: trustedHeaderIdentity({ token: environment.hostToken }),
		bindings,
		hostRoutes: (pathname, request, response) =>
			handleHostRoute(runtime, pathname, request, response)
	});
	core.readyForTraffic();
	return server;
}
