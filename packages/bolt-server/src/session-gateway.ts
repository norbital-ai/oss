import {
	createServer,
	request as requestUpstream,
	type IncomingMessage,
	type Server
} from 'node:http';
import { randomUUID } from 'node:crypto';
import { Predicate } from 'effect';
import { decodeNumber } from '@norbital-ai/std/json';

const hopByHop = new Set([
	'connection',
	'keep-alive',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
]);

/** One socket per browser request. Reusing the SSE socket for `/sync/connect` detaches the stream (410). */

/** Obscura EventSource opens without delivering frames. Tests poll this finite JSON inbox instead. */
export const SSE_INBOX_PATH = '/__norbital/sse-inbox';

type SseInboxEvent = { readonly type: string; readonly data: string };

type SseInboxLane = {
	readonly events: SseInboxEvent[];
	readonly waiters: Array<(events: readonly SseInboxEvent[]) => void>;
	readonly abort: AbortController;
	opened: boolean;
	closed: boolean;
};

const takeInboxEvents = (lane: SseInboxLane): SseInboxEvent[] => {
	const events = lane.events.splice(0, lane.events.length);
	return events;
};

const parseSseBlock = (raw: string): SseInboxEvent | undefined => {
	let type = 'message';
	const data: string[] = [];
	for (const line of raw.split('\n')) {
		if (line.startsWith(':')) continue;
		if (line.startsWith('event:')) type = line.slice(6).trim();
		else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
	}
	return data.length === 0 ? undefined : { type, data: data.join('\n') };
};

const consumeSse = (buffer: string): { readonly rest: string; readonly events: SseInboxEvent[] } => {
	const events: SseInboxEvent[] = [];
	let rest = buffer;
	for (;;) {
		const split = rest.indexOf('\n\n');
		if (split < 0) break;
		const parsed = parseSseBlock(rest.slice(0, split));
		rest = rest.slice(split + 2);
		if (parsed !== undefined) events.push(parsed);
	}
	return { rest, events };
};

export type SessionGatewayAddress = {
	readonly host: string;
	readonly port: number;
};

export type SessionGatewayDocument =
	| string
	| ((session: { readonly browserSession: string }) => string);

export type SessionGatewayInput = {
	readonly upstream: SessionGatewayAddress;
	readonly credential: string;
	readonly cookieName: string;
	readonly isDocument: (pathname: string) => boolean;
	readonly rewritePath?: (pathname: string) => string;
	readonly document: SessionGatewayDocument;
	readonly listen?: { readonly host?: string; readonly port?: number };
};

export type SessionGateway = {
	readonly address: SessionGatewayAddress;
	readonly baseUrl: string;
	readonly cookieName: string;
	readonly stop: () => Promise<void>;
};

export type WorkspaceDocumentInput = {
	readonly tenantId: string;
	readonly environment: string;
	readonly releaseId: string;
	readonly principal: string;
	readonly workspaceId?: string;
	readonly syncPrincipal?: string;
	readonly organizationName?: string;
	readonly title?: string;
	readonly commandPrefix?: string;
	readonly syncStreamUrl?: string;
	readonly viewPath?: string;
	/** Colony founder scope is `operator`. `administrator` is not a real access scope. */
	readonly accessScope?: string;
	/** Test embedder only. Colony keeps the bearer on the http-only cookie. */
	readonly credential?: string;
	/** Host `user.admin`. Runtime `access.impersonation` is the picker authority. */
	readonly admin?: boolean;
};

const loopbackHost = (host: string): string =>
	host === '0.0.0.0' || host === '::' || host === '[::]' ? '127.0.0.1' : host;

const hasSessionCookie = (cookieHeader: string | undefined, name: string, value: string): boolean =>
	(cookieHeader ?? '')
		.split(';')
		.map((part) => part.trim())
		.includes(`${name}=${value}`);

const listen = (server: Server, host: string, port: number): Promise<SessionGatewayAddress> =>
	new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => {
			const address = server.address();
			// repository-health:allow GUARD2 -- `server.address()` returns Node's own `string | AddressInfo | null` union; discriminating the platform SDK value is the seam itself.
			if (address === null || typeof address === 'string') {
				reject(new Error('session gateway did not bind a TCP port'));
				return;
			}
			resolve({ host, port: address.port });
		});
	});

/** HTML document that mounts the compiled guest at `#workspace`. */
export const workspaceDocumentHtml = (input: WorkspaceDocumentInput): string => {
	const organizationName = input.organizationName ?? input.tenantId;
	const workspaceId = input.workspaceId ?? input.tenantId;
	const syncPrincipal = input.syncPrincipal ?? input.principal;
	const title = input.title ?? organizationName;
	const commandPrefix = input.commandPrefix ?? '/_bolt/command/';
	const syncStreamUrl = input.syncStreamUrl ?? '/sync/stream';
	const viewPath = input.viewPath ?? '/';
	const accessScope = input.accessScope ?? 'operator';
	const credential = input.credential ?? 'http-only-host-session';
	const admin = input.admin !== false;
	const json = (value: string) => JSON.stringify(value);
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>${title.replaceAll('<', '&lt;')}</title>
		<style>html, body, #workspace { min-height: 100%; margin: 0; }</style>
	</head>
	<body>
		<div id="workspace"></div>
		<script type="module">
			const target = document.querySelector('#workspace');
			let previewTeam = null;
			const command = async (name, input, signal, headers = {}) => {
				const response = await fetch(${json(commandPrefix)} + encodeURIComponent(name), {
					method: 'POST',
					credentials: 'same-origin',
					headers: {
						'content-type': 'application/json',
						...(previewTeam === null ? {} : { 'x-colony-impersonated-team': previewTeam }),
						...headers
					},
					body: JSON.stringify(input),
					signal
				});
				const text = await response.text();
				const value = text === '' ? null : JSON.parse(text);
				if (!response.ok) throw new Error(value?.message ?? value?.error?.message ?? response.statusText);
				return value;
			};
			const unavailable = async () => { throw new Error('This embedder does not expose that host operation.'); };
			const sessionOf = () => ({
				workspaceId: ${json(workspaceId)},
				tenantId: ${json(input.tenantId)},
				environment: ${json(input.environment)},
				releaseId: ${json(input.releaseId)},
				syncPrincipal: ${json(syncPrincipal)},
				principal: ${json(input.principal)},
				accessScope: previewTeam === null ? ${json(accessScope)} : 'team:' + previewTeam,
				credential: ${json(credential)},
				transport: { command },
				syncStreamUrl: ${json(syncStreamUrl)},
				authoringStreamUrl: '/authoring/stream',
				files: { store: unavailable, remove: unavailable, urlFor: (key) => '/files/' + key },
				operations: { read: async () => ({}), run: unavailable }
			});
			const currentView = () => ({
				organization: { id: ${json(input.tenantId)}, name: ${json(organizationName)} },
				organizations: [{ organizationId: ${json(input.tenantId)}, organizationName: ${json(organizationName)}, logoUrl: null }],
				user: {
					id: ${json(input.principal)},
					email: ${json(`${input.principal}@example.test`)},
					teamPath: previewTeam === null ? [] : [previewTeam],
					admin: previewTeam === null && ${admin}
				},
				path: location.pathname === '/' ? ${json(viewPath)} : location.pathname,
				search: location.search
			});
			let handle;
			const entry = await import('/workspace.js');
			const remount = async () => {
				handle?.destroy?.();
				target.replaceChildren();
				handle = await entry.mountWorkspace(target, { session: sessionOf(), view: currentView(), actions });
			};
			const actions = {
				navigate: (href, options = {}) => {
					history[options.replace ? 'replaceState' : 'pushState']({}, '', href);
					handle?.update({ ...currentView(), path: location.pathname, search: location.search });
				},
				signOut: () => location.reload(),
				changeOrganization: () => {},
				impersonate: async (teamId) => {
					previewTeam = teamId;
					await remount();
				},
				stopImpersonating: async () => {
					previewTeam = null;
					await remount();
				}
			};
			handle = await entry.mountWorkspace(target, { session: sessionOf(), view: currentView(), actions });
			globalThis.__norbitalSessionActions = actions;
			addEventListener('popstate', () => handle.update({ ...currentView(), path: location.pathname, search: location.search }));
		</script>
	</body>
</html>`;
};

/**
 * Cookie → Bearer document in front of a listening `startApplication`.
 * EventSource cannot set Authorization; bolt-server `/sync/stream` is Authorization-only.
 * Cookie or the same session value as a query parameter — Obscura's EventSource may omit cookies.
 */
export const startSessionGateway = async (input: SessionGatewayInput): Promise<SessionGateway> => {
	const browserSession = randomUUID();
	const document = Predicate.isFunction(input.document)
		? input.document({ browserSession })
		: input.document;
	const upstreamHost = loopbackHost(input.upstream.host);
	const listenHost = input.listen?.host ?? '127.0.0.1';
	const listenPort = input.listen?.port ?? 0;
	const rewritePath = input.rewritePath ?? ((pathname: string) => pathname);

	const inboxes = new Map<string, SseInboxLane>();
	const authorized = (requestUrl: URL, cookieHeader: string | undefined): boolean => {
		const querySession = requestUrl.searchParams.get(input.cookieName);
		return (
			hasSessionCookie(cookieHeader, input.cookieName, browserSession) ||
			querySession === browserSession
		);
	};

	const openInbox = (connectionId: string, streamPath: string, streamSearch: string): SseInboxLane => {
		const existing = inboxes.get(connectionId);
		if (existing !== undefined) return existing;
		const abort = new AbortController();
		const lane: SseInboxLane = {
			events: [],
			waiters: [],
			abort,
			opened: false,
			closed: false
		};
		inboxes.set(connectionId, lane);
		const flush = (): void => {
			if (lane.waiters.length === 0 || (lane.events.length === 0 && !lane.closed && !lane.opened))
				return;
			const waiters = lane.waiters.splice(0, lane.waiters.length);
			const events = takeInboxEvents(lane);
			for (const waiter of waiters) waiter(events);
		};
		const upstream = requestUpstream(
			{
				host: upstreamHost,
				port: input.upstream.port,
				method: 'GET',
				path: `${rewritePath(streamPath)}${streamSearch}`,
				headers: {
					host: `${upstreamHost}:${input.upstream.port}`,
					authorization: `Bearer ${input.credential}`,
					// repository-health:allow LIVE2 -- this gateway relays the sync engine's own SSE stream to the browser; the engine's client driver and server are the documented owners and this is their transport hop.
					accept: 'text/event-stream'
				},
				agent: false
			},
			(upstreamResponse: IncomingMessage) => {
				if ((upstreamResponse.statusCode ?? 502) >= 400) {
					lane.closed = true;
					flush();
					return;
				}
				let buffer = '';
				upstreamResponse.on('data', (chunk: Buffer) => {
					const consumed = consumeSse(buffer + chunk.toString('utf8'));
					buffer = consumed.rest;
					if (consumed.events.length === 0) return;
					lane.events.push(...consumed.events);
					flush();
				});
				upstreamResponse.on('end', () => {
					lane.closed = true;
					flush();
				});
				lane.opened = true;
				flush();
			}
		);
		upstream.setTimeout(0);
		upstream.on('error', () => {
			lane.closed = true;
			flush();
		});
		abort.signal.addEventListener('abort', () => {
			lane.closed = true;
			upstream.destroy();
			flush();
		});
		upstream.end();
		return lane;
	};

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
		if (url.pathname === SSE_INBOX_PATH && request.method === 'GET') {
			if (!authorized(url, request.headers.cookie)) {
				response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
				response.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
				return;
			}
			const streamSpec = url.searchParams.get('stream') ?? '';
			let streamUrl: URL;
			try {
				streamUrl = new URL(streamSpec, 'http://session-gateway.local');
			} catch {
				response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
				response.end(JSON.stringify({ ok: false, error: 'stream' }));
				return;
			}
			const connectionId = streamUrl.searchParams.get('connectionId')?.trim() ?? '';
			if (connectionId.length === 0) {
				response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
				response.end(JSON.stringify({ ok: false, error: 'connectionId' }));
				return;
			}
			const lane = openInbox(connectionId, streamUrl.pathname, streamUrl.search);
			const waitMs = Math.min(
				2_000,
				Math.max(0, decodeNumber(url.searchParams.get('waitMs') ?? '2000'))
			);
			const finish = (events: readonly SseInboxEvent[]): void => {
				if (response.writableEnded) return;
				response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
				response.end(JSON.stringify({ ok: true, opened: lane.opened, closed: lane.closed, events }));
			};
			if (lane.events.length > 0 || lane.closed) {
				finish(takeInboxEvents(lane));
				return;
			}
			const waiter = (events: readonly SseInboxEvent[]): void => {
				clearTimeout(timer);
				finish(events);
			};
			const timer = setTimeout(() => {
				const index = lane.waiters.indexOf(waiter);
				if (index >= 0) lane.waiters.splice(index, 1);
				finish(takeInboxEvents(lane));
			}, waitMs);
			timer.unref();
			lane.waiters.push(waiter);
			return;
		}
		if (input.isDocument(url.pathname) && request.method === 'GET') {
			response.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'set-cookie': `${input.cookieName}=${browserSession}; HttpOnly; SameSite=Lax; Path=/`
			});
			response.end(document);
			return;
		}

		const headers: Record<string, string | string[] | undefined> = {};
		for (const [name, value] of Object.entries(request.headers)) {
			if (!hopByHop.has(name) && name !== 'accept-encoding') headers[name] = value;
		}
		headers.host = `${upstreamHost}:${input.upstream.port}`;
		if (authorized(url, request.headers.cookie)) {
			headers.authorization = `Bearer ${input.credential}`;
		}

		const upstream = requestUpstream(
			{
				host: upstreamHost,
				port: input.upstream.port,
				method: request.method,
				path: `${rewritePath(url.pathname)}${url.search}`,
				headers,
				agent: false
			},
			(upstreamResponse: IncomingMessage) => {
				const responseHeaders: Record<string, string | string[] | undefined> = {};
				for (const [name, value] of Object.entries(upstreamResponse.headers)) {
					if (!hopByHop.has(name)) responseHeaders[name] = value;
				}
				response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
				// An idle SSE stream opens on headers; registration must not wait for its heartbeat.
				response.flushHeaders();
				upstreamResponse.pipe(response);
			}
		);
		upstream.setTimeout(0);
		request.setTimeout(0);
		response.setTimeout(0);
		upstream.on('error', (cause: Error) => {
			if (response.headersSent) {
				response.destroy();
				return;
			}
			response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
			response.end(`session gateway upstream failed: ${cause.message}`);
		});
		if (request.method === 'GET' || request.method === 'HEAD') {
			upstream.end();
		} else {
			request.pipe(upstream);
		}
	});

	const address = await listen(server, listenHost, listenPort);
	let stopping = false;
	return {
		address,
		baseUrl: `http://${loopbackHost(address.host)}:${address.port}`,
		cookieName: input.cookieName,
		stop: async () => {
			if (stopping) return;
			stopping = true;
			for (const lane of inboxes.values()) lane.abort.abort();
			inboxes.clear();
			await new Promise<void>((resolve, reject) => {
				server.close((cause) => (cause === undefined ? resolve() : reject(cause)));
				server.closeAllConnections();
			});
		}
	};
};
