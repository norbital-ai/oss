import { beforeApiStorage } from '$lib/server/collection/hook-api-context.server.js';
import { createBeforeApi } from '$lib/server/collection/hook-api.server.js';
import { buildCtx } from '$lib/server/bootstrap/context.js';
import { runWithWorkspaceContext } from '$lib/server/bootstrap/workspace_runtime.js';
import { handleNorbitalRuntimeRequest } from '$lib/server/bootstrap/runtime_request.server.js';
import type { RuntimeFacilityBindings } from '@norbital-ai/platform-utils/runtime/binding';
import { NORBITAL_BASE_SCOPE_HEADER } from '$lib/server/bootstrap/host_base_scope.js';
import { error, isPodHttpError, json } from './http.js';
import { runWithRequestEvent, type PodRequestEvent } from './request-context.js';
import { loadTenantWorkspaceShellData } from './shell-data.server.js';
import { toRuntimeWorkspace } from '$lib/authoring/workspace/workspace-runtime.js';
import { registerTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import { dispatchRuntimeRun, parseRuntimeRunRequest } from '$lib/server/run/tenant_run.js';

export { getTenantManifest } from '$lib/server/bootstrap/tenant_workspace.server.js';
import type { RuntimeWorkspaceSource } from '$lib/authoring/workspace/workspace-runtime.js';
import {
	setDatabaseNotifications,
	type DatabaseNotifications
} from '$lib/server/collection/sync/db-notifications.server.js';

export function registerPodWorkspace(workspace: RuntimeWorkspaceSource): void {
	registerTenantWorkspace(toRuntimeWorkspace(workspace));
}

export function registerPodDatabaseNotifications(source: DatabaseNotifications | null): void {
	setDatabaseNotifications(source);
}

function cookieValue(request: Request, name: string): string | undefined {
	const cookie = request.headers.get('cookie');
	if (!cookie) return undefined;
	for (const part of cookie.split(';')) {
		const [key, ...value] = part.trim().split('=');
		if (key === name) return decodeURIComponent(value.join('='));
	}
	return undefined;
}

function createEvent(request: Request, bindings: RuntimeFacilityBindings): PodRequestEvent {
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
			identity: request.headers.get('x-norbital-user-id')?.trim() ?? '',
			org: {
				id: request.headers.get('x-norbital-org-id')?.trim() ?? process.env.NORBITAL_ORG_ID ?? '',
				name:
					request.headers.get('x-norbital-org-name')?.trim() ?? process.env.NORBITAL_ORG_NAME ?? ''
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

async function runRequest(event: PodRequestEvent): Promise<Response> {
	const marks: string[] = [];
	const context = await phase(marks, 'guest_context', () => buildCtx(event));
	if (!context) {
		const hasHostIdentity =
			Boolean(event.locals.identity) ||
			Boolean(event.request.headers.get(NORBITAL_BASE_SCOPE_HEADER)?.trim());
		if (hasHostIdentity) error(401, 'Workspace context could not be established');
		error(401, 'Unauthorized');
	}

	return beforeApiStorage.run(createBeforeApi(), () =>
		runWithWorkspaceContext(context, async () => {
			const pathname = new URL(event.request.url).pathname;
			if (pathname === '/_pod/bootstrap') {
				const shell = await phase(marks, 'guest_shell', () => loadTenantWorkspaceShellData(event));
				return withTimings(json(shell), marks);
			}
			if (pathname.startsWith('/_runtime/')) {
				return withTimings(await handleNorbitalRuntimeRequest(event), marks);
			}
			error(404, `Unknown Pod route: ${pathname}`);
		})
	);
}

export async function handlePodRequest(
	request: Request,
	bindings: RuntimeFacilityBindings
): Promise<Response> {
	const event = createEvent(request, bindings);
	try {
		return await runWithRequestEvent(event, () => runRequest(event));
	} catch (caught) {
		if (isPodHttpError(caught)) {
			return json(caught.body, { status: caught.status });
		}
		console.error('[pod-runtime]', caught);
		return json(
			{ message: caught instanceof Error ? caught.message : String(caught) },
			{ status: 500 }
		);
	}
}

export type PodHostIdentity = {
	readonly userId: string;
	readonly organizationId: string;
	readonly organizationName: string;
	readonly baseScope?: unknown;
};

/**
 * Private control plane used by the trusted host. It is deliberately not reachable through
 * `handlePodRequest`, so a tenant identity can never claim jobs or inject system events.
 */
export async function handlePodHostCommand(
	command: unknown,
	bindings: RuntimeFacilityBindings,
	identity: PodHostIdentity
): Promise<unknown> {
	const headers = new Headers({
		'x-norbital-user-id': identity.userId,
		'x-norbital-org-id': identity.organizationId,
		'x-norbital-org-name': identity.organizationName
	});
	if (identity.baseScope) {
		headers.set(NORBITAL_BASE_SCOPE_HEADER, JSON.stringify(identity.baseScope));
	}
	const event = createEvent(
		new Request('http://tenant.local/_host-command', { headers }),
		bindings
	);
	return runWithRequestEvent(event, async () => {
		const context = await buildCtx(event);
		if (!context) error(401, 'Host command workspace context could not be established');
		return beforeApiStorage.run(createBeforeApi(), () =>
			runWithWorkspaceContext(context, () => dispatchRuntimeRun(parseRuntimeRunRequest(command)))
		);
	});
}
