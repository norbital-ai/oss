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
import { parseAdmitHeaders, type PodAdmit } from './admit.js';
import { createCallRequest, headerLookup, readFetchRequest } from './call-request.js';
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

const ADMIT_HEADER_NAMES = new Set(['x-norbital-timeout-ms', 'x-norbital-deadline-at']);

export type HttpDispatchPayload = {
	readonly method: string;
	readonly search?: string;
	readonly headers: Record<string, string>;
	readonly body: string | null;
};

/** Strip admit headers so the guest never sizes work from a client- or host-written costume. */
function identityHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (ADMIT_HEADER_NAMES.has(key.toLowerCase())) continue;
		out[key] = value;
	}
	return out;
}

/** True when `payload` is the HTTP-shaped tenant call, not a host-command kind. */
function isHttpDispatchPayload(payload: unknown): payload is HttpDispatchPayload {
	if (payload == null || typeof payload !== 'object') return false;
	const record = payload as Record<string, unknown>;
	return (
		typeof record.method === 'string' &&
		record.headers != null &&
		typeof record.headers === 'object' &&
		!Array.isArray(record.headers) &&
		'body' in record
	);
}

/** Path the existing runtime handlers already understand. Never `tenant.local`. */
function dispatchHref(name: string, search: string): string {
	const pathname = name.startsWith('_pod/') ? `/${name}` : `/_runtime/${name}`;
	return `http://pod.local${pathname}${search}`;
}

/** Build the request event the guest runtime already understands from a named dispatch. */
function createDispatchEvent(
	name: string,
	payload: HttpDispatchPayload,
	bindings: RuntimeFacilityBindings
): PodRequestEvent {
	const headers = identityHeaders(payload.headers);
	const search = payload.search ?? '';
	const request = createCallRequest({
		method: payload.method,
		url: dispatchHref(name, search),
		headers,
		bodyText: payload.body
	});
	return {
		request,
		params: { path: name },
		platform: { bindings },
		locals: {
			db: bindings.db,
			identity: headerLookup(headers, 'x-norbital-user-id')?.trim() ?? '',
			org: {
				id: headerLookup(headers, 'x-norbital-org-id')?.trim() ?? '',
				name: headerLookup(headers, 'x-norbital-org-name')?.trim() ?? ''
			},
			zone: headerLookup(headers, 'x-norbital-zone') === 'preview' ? 'preview' : 'live'
		},
		fetch: globalThis.fetch,
		cookies: { get: (cookieName) => cookieValue(request, cookieName) }
	};
}

function readHostIdentity(payload: unknown): PodHostIdentity | null {
	if (payload == null || typeof payload !== 'object') return null;
	const record = payload as Record<string, unknown>;
	const nested = record.identity;
	if (nested == null || typeof nested !== 'object') return null;
	const source = nested as Record<string, unknown>;
	const userId = typeof source.userId === 'string' ? source.userId : '';
	const organizationId = typeof source.organizationId === 'string' ? source.organizationId : '';
	const organizationName = typeof source.organizationName === 'string' ? source.organizationName : '';
	if (!userId && !organizationId) return null;
	return {
		userId,
		organizationId,
		organizationName,
		...(source.baseScope !== undefined ? { baseScope: source.baseScope } : {})
	};
}

function hostCommandPayload(payload: unknown): unknown {
	if (payload == null || typeof payload !== 'object') return payload;
	const record = { ...(payload as Record<string, unknown>) };
	delete record.identity;
	return record;
}

/** Identity-only event for a host-command kind. Never `tenant.local`. */
function createHostCommandEvent(
	identity: PodHostIdentity | null,
	bindings: RuntimeFacilityBindings
): PodRequestEvent {
	const headers: Record<string, string> = {};
	if (identity) {
		headers['x-norbital-user-id'] = identity.userId;
		headers['x-norbital-org-id'] = identity.organizationId;
		headers['x-norbital-org-name'] = identity.organizationName;
		if (identity.baseScope) {
			headers[NORBITAL_BASE_SCOPE_HEADER] = JSON.stringify(identity.baseScope);
		}
	}
	const request = createCallRequest({
		method: 'POST',
		url: 'http://pod.local/_host-command',
		headers,
		bodyText: null
	});
	return {
		request,
		params: { path: '' },
		platform: { bindings },
		locals: {
			db: bindings.db,
			identity: identity?.userId ?? '',
			org: {
				id: identity?.organizationId ?? '',
				name: identity?.organizationName ?? ''
			},
			zone: 'live'
		},
		fetch: globalThis.fetch,
		cookies: { get: () => undefined }
	};
}

/**
 * Guest-side phase timings, surfaced as `Server-Timing` on the response.
 *
 * Core already reports how long the whole guest call took (`tenant_invoke`), which is enough to
 * know the guest is slow and useless for knowing why. These segments split that number so a slow
 * workspace load can be attributed without adding logging.
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

export type PodDispatchResult = {
	readonly status: number;
	readonly headers: Record<string, string>;
	readonly bodyText: string;
};

/** The trusted host's identity for a private control-plane command. */
export type PodHostIdentity = {
	readonly userId: string;
	readonly organizationId: string;
	readonly organizationName: string;
	readonly baseScope?: unknown;
};

async function dispatchHttp(
	name: string,
	payload: HttpDispatchPayload,
	bindings: RuntimeFacilityBindings,
	admit: PodAdmit | null
): Promise<PodDispatchResult> {
	const event = createDispatchEvent(name, payload, bindings);
	return runWithPodCall(
		{ admit, event, workspace: null, beforeApi: createBeforeApi() },
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

async function dispatchHostCommand(
	payload: unknown,
	bindings: RuntimeFacilityBindings,
	admit: PodAdmit | null
): Promise<unknown> {
	const identity = readHostIdentity(payload);
	const command = hostCommandPayload(payload);
	const event = createHostCommandEvent(identity, bindings);
	return runWithPodCall(
		{ admit, event, workspace: null, beforeApi: createBeforeApi() },
		async () => {
			const context = await buildCtx(event);
			if (!context) error(401, 'Host command workspace context could not be established');
			setPodCallWorkspace(context);
			return dispatchRuntimeRun(parseRuntimeRunRequest(command));
		}
	);
}

/**
 * The one guest door. `name` is a runtime path without `/_runtime/` (`sync/diff`,
 * `collections/findMany`, …) or a host-command kind (`automation`, `channel`, `agent`, …).
 *
 * HTTP-shaped payloads return `{ status, headers, bodyText }`. Host-command kinds return the
 * current host-command result. Admit is an argument — the guest does not read admit headers.
 */
export async function dispatch(
	name: string,
	payload: unknown,
	bindings: RuntimeFacilityBindings,
	admit?: PodAdmit | null
): Promise<unknown> {
	const resolvedAdmit = admit ?? null;
	if (isHttpDispatchPayload(payload)) {
		return dispatchHttp(name, payload, bindings, resolvedAdmit);
	}
	return dispatchHostCommand(payload, bindings, resolvedAdmit);
}

/** Runtime path without `/_runtime/`, used by host-edge HTTP adapters. */
export function runtimeNameFromPath(pathname: string): string {
	if (pathname.startsWith('/_runtime/')) return pathname.slice('/_runtime/'.length);
	return pathname.replace(/^\//, '');
}

/**
 * Host-edge Fetch adapter. Not a guest-bundle export — maps a Request onto `dispatch`.
 */
export async function handlePodRequest(
	request: Request,
	bindings: RuntimeFacilityBindings
): Promise<Response> {
	const input = await readFetchRequest(request);
	const url = new URL(request.url);
	const result = (await dispatch(
		runtimeNameFromPath(url.pathname),
		{
			method: input.method,
			search: url.search,
			headers: input.headers,
			body: input.bodyText
		},
		bindings,
		parseAdmitHeaders(request.headers)
	)) as PodDispatchResult;
	return new Response(result.bodyText, { status: result.status, headers: result.headers });
}

/**
 * Host-edge control-plane adapter. Not a guest-bundle export — maps a command onto `dispatch`.
 */
export async function handlePodHostCommand(
	command: unknown,
	bindings: RuntimeFacilityBindings,
	identity: PodHostIdentity,
	admit?: PodAdmit | null
): Promise<unknown> {
	const kind =
		command != null && typeof command === 'object' && 'kind' in command
			? String((command as { kind: unknown }).kind)
			: '';
	return dispatch(
		kind,
		{ ...(command != null && typeof command === 'object' ? command : { command }), identity },
		bindings,
		admit ?? null
	);
}
