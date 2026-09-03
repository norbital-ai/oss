import { createServer, get as requestGet } from 'node:http';
import { describe, expect, it } from 'vitest';
import { startSessionGateway, workspaceDocumentHtml } from '../src/session-gateway.js';
import { waitUntilReady } from '../src/ready.js';

const listenUpstream = async (
	handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void
): Promise<{ readonly host: string; readonly port: number; readonly stop: () => Promise<void> }> => {
	const server = createServer(handler);
	const address = await new Promise<{ host: string; port: number }>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const bound = server.address();
			if (bound === null || typeof bound === 'string') {
				reject(new Error('upstream did not bind'));
				return;
			}
			resolve({ host: '127.0.0.1', port: bound.port });
		});
	});
	return {
		...address,
		stop: () =>
			new Promise<void>((resolve, reject) => {
				server.close((cause) => (cause === undefined ? resolve() : reject(cause)));
				server.closeAllConnections();
			})
	};
};

describe('session gateway', () => {
	it('serves the workspace document and attaches the session bearer', async () => {
		const upstream = await listenUpstream((request, response) => {
			if (request.url === '/readyz') {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(
					JSON.stringify({ ready: true, accepting: true, inFlight: 0, finalized: false })
				);
				return;
			}
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify({
					authorization: request.headers.authorization ?? null,
					url: request.url
				})
			);
		});
		const gateway = await startSessionGateway({
			upstream,
			credential: 'founder-token',
			cookieName: 'norbital_session',
			isDocument: (pathname) => pathname === '/app' || pathname === '/app/',
			rewritePath: (pathname) =>
				pathname.startsWith('/app/sync/') ? `/sync/${pathname.slice('/app/sync/'.length)}` : pathname,
			document: workspaceDocumentHtml({
				tenantId: 'acme',
				environment: 'test',
				releaseId: 'r1',
				principal: 'founder',
				title: 'Acme',
				commandPrefix: '/_bolt/command/',
				syncStreamUrl: '/sync/stream',
				viewPath: '/app'
			})
		});
		try {
			const page = await fetch(`${gateway.baseUrl}/app`);
			expect(page.status).toBe(200);
			expect(page.headers.get('content-type')).toMatch(/text\/html/);
			const html = await page.text();
			expect(html).toContain('mountWorkspace');
			expect(html).toContain('/sync/stream');
			expect(html).toContain('previewTeam === null ? "operator"');
			expect(html).toContain('credential: "http-only-host-session"');
			expect(html).toContain('previewTeam');
			expect(html).toContain("'team:'");
			expect(html).toContain('const remount = async');
			expect(html).toContain('await remount()');
			expect(html).toContain('__norbitalSessionActions');
			expect(html).toContain('x-colony-impersonated-team');
			const cookie = page.headers.get('set-cookie') ?? '';
			expect(cookie).toContain('norbital_session=');

			const streamed = await fetch(`${gateway.baseUrl}/app/sync/stream`, {
				headers: { cookie: cookie.split(';', 1)[0] ?? '' }
			});
			expect(streamed.status).toBe(200);
			const echoed = (await streamed.json()) as {
				readonly authorization: string | null;
				readonly url: string;
			};
			expect(echoed.authorization).toBe('Bearer founder-token');
			expect(echoed.url).toBe('/sync/stream');

			const sessionValue = cookie.split('=', 2)[1]?.split(';', 1)[0] ?? '';
			const streamedByQuery = await fetch(
				`${gateway.baseUrl}/app/sync/stream?norbital_session=${sessionValue}`
			);
			expect(streamedByQuery.status).toBe(200);
			const echoedQuery = (await streamedByQuery.json()) as {
				readonly authorization: string | null;
				readonly url: string;
			};
			expect(echoedQuery.authorization).toBe('Bearer founder-token');
			expect(echoedQuery.url).toBe(`/sync/stream?norbital_session=${sessionValue}`);

			const snapshot = await waitUntilReady(gateway.baseUrl);
			expect(snapshot.ready).toBe(true);
		} finally {
			await gateway.stop();
			await upstream.stop();
		}
	});

	it('keeps a proxied SSE socket open so a later connect can join', { timeout: 15_000 }, async () => {
		const openIds = new Set<string>();
		const upstream = await listenUpstream((request, response) => {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			if (url.pathname === '/sync/stream') {
				const id = url.searchParams.get('connectionId') ?? '';
				openIds.add(id);
				response.writeHead(200, {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-store'
				});
				response.write(': keepalive\n\n');
				response.once('close', () => {
					openIds.delete(id);
				});
				return;
			}
			if (url.pathname === '/sync/connect') {
				const id = request.headers['x-bolt-sync-connection'];
				const key = typeof id === 'string' ? id : '';
				response.writeHead(openIds.has(key) ? 200 : 410, {
					'content-type': 'application/json'
				});
				response.end(JSON.stringify({ open: openIds.has(key) }));
				return;
			}
			response.writeHead(404);
			response.end();
		});
		const gateway = await startSessionGateway({
			upstream,
			credential: 'founder-token',
			cookieName: 'norbital_session',
			isDocument: (pathname) => pathname === '/app',
			rewritePath: (pathname) =>
				pathname.startsWith('/app/sync/') ? `/sync/${pathname.slice('/app/sync/'.length)}` : pathname,
			document: '<html></html>'
		});
		let stream: import('node:http').IncomingMessage | undefined;
		try {
			const page = await fetch(`${gateway.baseUrl}/app`);
			const cookie = page.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
			stream = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('sse headers not received')), 3_000);
				const req = requestGet(
					`${gateway.baseUrl}/app/sync/stream?connectionId=sse-1`,
					{ headers: { cookie } },
					(response) => {
						clearTimeout(timer);
						resolve(response);
					}
				);
				req.once('error', (cause) => {
					clearTimeout(timer);
					reject(cause);
				});
			});
			expect(stream.statusCode).toBe(200);
			const joined = await fetch(`${gateway.baseUrl}/app/sync/connect`, {
				method: 'POST',
				headers: { cookie, 'x-bolt-sync-connection': 'sse-1' }
			});
			expect(joined.status).toBe(200);
			expect(await joined.json()).toEqual({ open: true });
		} finally {
			stream?.destroy();
			await gateway.stop();
			await upstream.stop();
		}
	});

	it('inbox long-polls Node SSE frames as finite JSON', { timeout: 15_000 }, async () => {
		const sinks = new Set<import('node:http').ServerResponse>();
		const upstream = await listenUpstream((request, response) => {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			if (url.pathname === '/sync/stream') {
				response.writeHead(200, {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-store'
				});
				response.write('event: hello\ndata: ready\n\n');
				sinks.add(response);
				return;
			}
			response.writeHead(404);
			response.end();
		});
		const gateway = await startSessionGateway({
			upstream,
			credential: 'founder-token',
			cookieName: 'norbital_session',
			isDocument: (pathname) => pathname === '/app',
			rewritePath: (pathname) =>
				pathname.startsWith('/__bolt/sync/')
					? `/sync/${pathname.slice('/__bolt/sync/'.length)}`
					: pathname,
			document: '<html></html>'
		});
		try {
			const page = await fetch(`${gateway.baseUrl}/app`);
			const cookie = page.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
			const session = cookie.split('=', 2)[1] ?? '';
			const inbox = `${gateway.baseUrl}/__norbital/sse-inbox?stream=${encodeURIComponent('/__bolt/sync/stream?connectionId=inbox-1')}&norbital_session=${session}`;
			const first = await fetch(inbox, { headers: { cookie } });
			expect(first.status).toBe(200);
			const opened = (await first.json()) as {
				readonly opened: boolean;
				readonly events: readonly { readonly type: string; readonly data: string }[];
			};
			expect(opened.opened).toBe(true);
			expect(sinks.size).toBe(1);
			let hello = opened.events;
			if (!hello.some((event) => event.type === 'hello')) {
				const retry = await fetch(inbox, { headers: { cookie } });
				hello = (
					(await retry.json()) as {
						readonly events: readonly { readonly type: string; readonly data: string }[];
					}
				).events;
			}
			expect(hello).toContainEqual({ type: 'hello', data: 'ready' });
			const waiting = fetch(`${inbox}&waitMs=2000`, { headers: { cookie } });
			await new Promise((resolve) => setTimeout(resolve, 50));
			for (const sink of sinks) sink.write('event: apply\ndata: mutated\n\n');
			const second = await waiting;
			expect(second.status).toBe(200);
			expect(await second.json()).toEqual({
				ok: true,
				opened: true,
				closed: false,
				events: [{ type: 'apply', data: 'mutated' }]
			});
		} finally {
			await gateway.stop();
			await upstream.stop();
		}
	});
});
