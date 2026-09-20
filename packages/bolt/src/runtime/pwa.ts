import { Effect, Option, Redacted } from 'effect';
import {
	PUBLIC_WORKSPACE_ROOT_CONFIG_KEY,
	PWA_MANIFEST_PATH,
	SERVICE_WORKER_PATH,
	type DispatchResponse,
	type Invocation
} from '@norbital-ai/bolt-protocol';
import { HostConfig } from '#lib/runtime/access/system-principal.js';
import * as Workspace from '#lib/runtime/workspace.js';

/**
 * What makes a workspace an installable app: its manifest and its service worker, both minted here
 * so every host serves them the same way and no template writes either.
 *
 * The install is scoped to the host's mount of the workspace shell (`/__bolt` on Colony and on the
 * standalone server), which is why the mount has to be known: the manifest's `scope` and
 * `start_url` and the worker's `Service-Worker-Allowed` all name it. The configured public root
 * says it outright; failing that the request's own path does, since the standalone server hands
 * the runtime the URL it was asked for unstripped.
 *
 * The worker is deliberately thin. It caches nothing on install and only ever caches the
 * release-scoped static namespace, whose URLs carry the release id and are therefore immutable —
 * a second launch paints from disk while the entry resolution, sync and every command still cross
 * the network, so the "release mismatch disconnects the stream" rule keeps seeing the truth. A
 * navigation with no network gets the offline page below; the client is not a replica and this
 * is the honest version of "offline".
 */
const pathnameOf = (url: string): string => new URL(url, 'http://bolt.invalid').pathname;

const mountOf = Effect.fn('Bolt.pwa.mount')(function* (requestPath: string, suffix: string) {
	const hostConfig = yield* Effect.serviceOption(HostConfig);
	const configured = Option.isNone(hostConfig)
		? Option.none<string>()
		: yield* hostConfig.value.read(PUBLIC_WORKSPACE_ROOT_CONFIG_KEY).pipe(
				Effect.map(Option.map((value) => pathnameOf(Redacted.value(value)))),
				Effect.orElseSucceed(() => Option.none<string>())
			);
	if (Option.isSome(configured)) return configured.value.replace(/\/+$/, '');
	// `/__bolt/request/sw.js` → `/__bolt`; a stripped `/sw.js` → the origin root.
	const requestNamespace = `/request${suffix}`;
	return requestPath.endsWith(requestNamespace)
		? requestPath.slice(0, -requestNamespace.length)
		: '';
});

const manifestOf = (name: string, mount: string, tenantId: string): string =>
	JSON.stringify({
		id: tenantId,
		name,
		short_name: name,
		start_url: mount === '' ? '/' : mount,
		scope: `${mount}/`,
		display: 'standalone',
		background_color: '#f2f1ed',
		theme_color: '#f2f1ed',
		icons: [
			{
				src: `data:image/svg+xml,${encodeURIComponent(iconSvg(name))}`,
				sizes: 'any',
				type: 'image/svg+xml',
				purpose: 'any maskable'
			}
		]
	});

/** The workspace's initial on the brand ground; a template that ships its own icon replaces this later. */
const iconSvg = (name: string): string => {
	const initial = (name.trim().charAt(0) || 'N').toUpperCase().replace(/[<&]/g, '');
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#26251e"/><text x="256" y="336" text-anchor="middle" font-family="system-ui,sans-serif" font-size="280" font-weight="600" fill="#f7f7f4">${initial}</text></svg>`;
};

// The name is the document's to choose, so it is text here, never markup.
const escapeHtml = (text: string): string =>
	text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const offlineHtml = (name: string): string =>
	`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(name)}</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f2f1ed;color:#26251e;text-align:center;padding:2rem}p{color:#26251e99}</style><main><h1>${escapeHtml(name)}</h1><p>You are offline. This workspace needs a connection; it will pick up where you left off.</p></main>`;

const workerOf = (name: string, mount: string): string => `'use strict';
const STATIC = ${JSON.stringify(`${mount}/static/`)};
const CACHE = 'bolt-static';
const OFFLINE = ${JSON.stringify(offlineHtml(name))};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request).catch(() => new Response(OFFLINE, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
		);
		return;
	}
	if (!url.pathname.startsWith(STATIC)) return;
	// ponytail: cache-first with no eviction; the release id is in the path so entries never go stale,
	// and the browser's quota eviction bounds it. Prune old release prefixes if quota ever bites.
	event.respondWith(
		caches.open(CACHE).then(async (cache) => {
			const hit = await cache.match(request);
			if (hit) return hit;
			const response = await fetch(request);
			if (response.ok) void cache.put(request, response.clone());
			return response;
		})
	);
});
self.addEventListener('push', (event) => {
	let data = {};
	try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
	event.waitUntil(
		self.registration.showNotification(data.title || ${JSON.stringify(name)}, {
			body: data.body || '',
			data: { url: data.url || ${JSON.stringify(mount === '' ? '/' : mount)} }
		})
	);
});
self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url = (event.notification.data && event.notification.data.url) || ${JSON.stringify(mount === '' ? '/' : mount)};
	event.waitUntil(
		self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
			const open = clients.find((client) => 'focus' in client);
			return open ? open.focus().then(() => open.navigate(url)) : self.clients.openWindow(url);
		})
	);
});
`;

const bytes = (
	text: string,
	contentType: string,
	headers: Record<string, string> = {}
): DispatchResponse => ({
	status: 200,
	headers: Object.fromEntries(
		Object.entries({ 'content-type': contentType, 'cache-control': 'no-cache', ...headers }).map(
			([key, value]) => [key, [value]]
		)
	),
	body: new TextEncoder().encode(text)
});

/** The name the document asked for, bounded; the workspace's package name when it asked for none. */
const nameOf = (url: string, fallback: string): string => {
	const asked = new URL(url, 'http://bolt.invalid').searchParams.get('name')?.trim() ?? '';
	return asked.length > 0 && asked.length <= 80 ? asked : fallback;
};

/** The response for one of the two app paths, or nothing when the request was for neither. */
export const answerAppRequest = Effect.fn('Bolt.pwa.answer')(function* (
	invocation: Extract<Invocation, { readonly _tag: 'Request' }>
) {
	const path = pathnameOf(invocation.url);
	const suffix = path.endsWith(PWA_MANIFEST_PATH)
		? PWA_MANIFEST_PATH
		: path.endsWith(SERVICE_WORKER_PATH)
			? SERVICE_WORKER_PATH
			: undefined;
	if (suffix === undefined) return undefined;
	const name = nameOf(invocation.url, (yield* Workspace.Service).definition.name);
	const mount = yield* mountOf(path, suffix);
	return suffix === PWA_MANIFEST_PATH
		? bytes(
				manifestOf(name, mount, String(invocation.scope.tenantId)),
				'application/manifest+json; charset=utf-8'
			)
		: bytes(workerOf(name, mount), 'text/javascript; charset=utf-8', {
				'service-worker-allowed': `${mount}/`
			});
});
