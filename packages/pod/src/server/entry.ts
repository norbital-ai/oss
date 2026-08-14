import { createBeforeApi } from '$lib/server/collection/hook-api.server.js';
import { buildCtx } from '$lib/server/bootstrap/context.js';
import { setPodCallWorkspace } from '$lib/server/pod-call.js';
import { handleNorbitalRuntimeRequest } from '$lib/server/bootstrap/runtime_request.server.js';
import type {
	HostAppPlugin,
	RuntimeFacilityBindings
} from '@norbital-ai/platform-utils/runtime/binding';
import { setHostPlugins } from '$lib/server/host-plugins.js';
import { NORBITAL_BASE_SCOPE_HEADER } from '$lib/server/bootstrap/host_base_scope.js';
import { error, isPodHttpError, json } from './http.js';
import type { PodRequestEvent } from './request-context.js';
import { loadTenantWorkspaceShellData } from './shell-data.server.js';
import {
	toRuntimeWorkspace,
	type RuntimeWorkspaceSource
} from '$lib/authoring/workspace/workspace-runtime.js';
import { registerTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import { dispatchRuntimeRun, parseRuntimeRunRequest } from '$lib/server/run/tenant_run.js';
import {
	admitHeaders,
	parseAdmitHeaderRecord,
	parseAdmitHeaders,
	type PodAdmit
} from './admit.js';
import { createCallRequest, readFetchRequest } from './call-request.js';
import { runWithPodCall } from './pod-call.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';

// This one re-export is the bundle contract, not a barrel: the generated server entry that
// `vite/index.ts` writes imports `getTenantManifest` from `server/entry.js` (it needs the manifest
// after registering the workspace) and re-exports it as `workspaceManifest`. Any consumer that wants
// the manifest without the bundle imports it from `tenant_workspace.server.js` directly.
export { getTenantManifest } from '$lib/server/bootstrap/tenant_workspace.server.js';

/** Register the compiled workspace so every later request and host command sees the same registry. */
export function registerPodWorkspace(workspace: RuntimeWorkspaceSource): void {
	registerTenantWorkspace(toRuntimeWorkspace(workspace));
}

/**
 * Register the host's sidebar surfaces. Called once at startup by the host, never from a request, so
 * a caller cannot inject a navigation entry. See `host_plugins.ts`.
 */
export function registerPodHostPlugins(plugins: readonly HostAppPlugin[]): void {
	setHostPlugins(plugins);
}

/** Read one cookie from the inbound request. Used only to populate `event.cookies`. */
function cookieValue(request: PodRequestEvent['request'], name: string): string | undefined {
	const cookie = request.headers.get('cookie');
	if (!cookie) return undefined;
	for (const part of cookie.split(';')) {
		const [key, ...value] = part.trim().split('=');
		if (key === name) return decodeURIComponent(value.join('='));
	}
	return undefined;
}

/** Build the request event the guest runtime already understands from host-written headers. */
function createEvent(
	request: PodRequestEvent['request'],
	bindings: RuntimeFacilityBindings
): PodRequestEvent {
	const url = new URL(request.url);
	const runtimePath = url.pathname.startsWith('/_runtime/')
		? url.pathname.slice('/_runtime/'.length)
		: '';
	return {
		request,
		params: { path: runtimePath },
		platform: { bindings },
		locals: {
			db: bindings.db,
			// Identity comes from the request or not at all. Every caller that reaches here has already
			// proven it is the trusted host and re-issued the request with the identity it established,
			// so a request that arrives without one is a request nobody vouched for — and an ambient
			// fallback would serve it under an organization nobody proved.
			identity: request.headers.get('x-norbital-user-id')?.trim() ?? '',
			org: {
				id: request.headers.get('x-norbital-org-id')?.trim() ?? '',
				name: request.headers.get('x-norbital-org-name')?.trim() ?? ''
			},
			zone: request.headers.get('x-norbital-zone') === 'preview' ? 'preview' : 'live'
		},
		fetch: globalThis.fetch,
		cookies: { get: (name) => cookieValue(request, name) }
	};
}

/**
 * Guest-side phase timings, surfaced as `Server-Timing` on the response.
 *
 * Core already reports how long the whole guest call took (`tenant_invoke`), which is enough to
 * know the guest is slow and useless for knowing why. These segments split that number, so a slow
 * workspace load can be attributed without adding logging or attaching a profiler to a microVM.
 */
async function phase<T>(marks: string[], name: string, run: () => Promise<T>): Promise<T> {
	const startedAt = performance.now();
	try {
		return await run();
	} finally {
		marks.push(`${name};dur=${(performance.now() - startedAt).toFixed(1)}`);
	}
}

/** Attach accumulated `Server-Timing` marks without dropping any the inner handler already set. */
function withTimings(response: Response, marks: readonly string[]): Response {
	if (marks.length === 0) return response;
	const headers = new Headers(response.headers);
	const existing = headers.get('server-timing');
	headers.set('server-timing', [existing, marks.join(', ')].filter(Boolean).join(', '));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

/** Route one already-authenticated guest request to bootstrap or `/_runtime/*`. */
async function runRequest(event: PodRequestEvent, marks: string[]): Promise<Response> {
	getWorkspace();
	const pathname = new URL(event.request.url).pathname;
	if (pathname === '/_pod/bootstrap') {
		const shell = await phase(marks, 'guest_shell', () => loadTenantWorkspaceShellData(event));
		return withTimings(json(shell), marks);
	}
	if (pathname.startsWith('/_runtime/')) {
		return withTimings(await handleNorbitalRuntimeRequest(event), marks);
	}
	error(404, `Unknown Pod route: ${pathname}`);
}

async function dispatchResultFromResponse(response: Response): Promise<PodDispatchResult> {
	return {
		status: response.status,
		headers: Object.fromEntries(response.headers.entries()),
		bodyText: await response.text()
	};
}

export type PodDispatchInput = {
	readonly method: string;
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly bodyText: string | null;
};

export type PodDispatchResult = {
	readonly status: number;
	readonly headers: Record<string, string>;
	readonly bodyText: string;
};

/**
 * Guest dispatch entry for isolate and other non-Fetch callers. Parses the host's admit headers and
 * runs the request under one PodCall so `remainingMs()` is visible to every function the request
 * reaches.
 */
export async function handlePodDispatch(
	input: PodDispatchInput,
	bindings: RuntimeFacilityBindings,
	admit?: PodAdmit | null
): Promise<PodDispatchResult> {
	const resolvedAdmit = admit !== undefined ? admit : parseAdmitHeaderRecord(input.headers);
	const event = createEvent(createCallRequest(input), bindings);

	return runWithPodCall(
		{ admit: resolvedAdmit, event, workspace: null, beforeApi: createBeforeApi() },
		async () => {
			try {
				const marks: string[] = [];
				const context = await phase(marks, 'guest_context', () => buildCtx(event));
				if (!context) {
					const hasHostIdentity =
						Boolean(event.locals.identity) ||
						Boolean(event.request.headers.get(NORBITAL_BASE_SCOPE_HEADER)?.trim());
					if (hasHostIdentity) error(401, 'Workspace context could not be established');
					error(401, 'Unauthorized');
				}
				setPodCallWorkspace(context);
				return await dispatchResultFromResponse(await runRequest(event, marks));
			} catch (caught) {
				if (isPodHttpError(caught)) {
					return {
						status: caught.status,
						headers: { 'content-type': 'application/json' },
						bodyText: JSON.stringify(caught.body)
					};
				}
				console.error('[pod-runtime]', caught);
				return {
					status: 500,
					headers: { 'content-type': 'application/json' },
					bodyText: JSON.stringify({
						message: caught instanceof Error ? caught.message : String(caught)
					})
				};
			}
		}
	);
}

/**
 * Self-host HTTP adapter. Parses the host's admit headers and runs the request through
 * `handlePodDispatch`, then re-wraps the plain result as a web Response.
 */
export async function handlePodRequest(
	request: Request,
	bindings: RuntimeFacilityBindings
): Promise<Response> {
	const input = await readFetchRequest(request);
	const result = await handlePodDispatch(input, bindings, parseAdmitHeaders(request.headers));
	return new Response(result.bodyText, { status: result.status, headers: result.headers });
}

/** The trusted host's identity for a private control-plane command. */
export type PodHostIdentity = {
	readonly userId: string;
	readonly organizationId: string;
	readonly organizationName: string;
	readonly baseScope?: unknown;
};

/**
 * Private control plane used by the trusted host. It is deliberately not reachable through
 * `handlePodRequest`, so a tenant identity can never claim jobs or inject system events.
 *
 * `admit` is the host's budget for this command. When omitted, admit headers on the synthetic
 * request are parsed — a host that already has a `PodAdmit` should pass it.
 */
export async function handlePodHostCommand(
	command: unknown,
	bindings: RuntimeFacilityBindings,
	identity: PodHostIdentity,
	admit?: PodAdmit | null
): Promise<unknown> {
	const headers: Record<string, string> = {
		'x-norbital-user-id': identity.userId,
		'x-norbital-org-id': identity.organizationId,
		'x-norbital-org-name': identity.organizationName
	};
	if (identity.baseScope) {
		headers[NORBITAL_BASE_SCOPE_HEADER] = JSON.stringify(identity.baseScope);
	}
	if (admit) {
		for (const [name, value] of Object.entries(admitHeaders(admit))) {
			headers[name] = value;
		}
	}
	const resolvedAdmit =
		admit !== undefined ? admit : parseAdmitHeaderRecord(headers);
	const event = createEvent(
		createCallRequest({
			method: 'POST',
			url: 'http://tenant.local/_host-command',
			headers,
			bodyText: null
		}),
		bindings
	);

	return runWithPodCall(
		{ admit: resolvedAdmit, event, workspace: null, beforeApi: createBeforeApi() },
		async () => {
			const context = await buildCtx(event);
			if (!context) error(401, 'Host command workspace context could not be established');
			setPodCallWorkspace(context);
			return dispatchRuntimeRun(parseRuntimeRunRequest(command));
		}
	);
}
