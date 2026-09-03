import { createServer } from 'node:http';
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

			const snapshot = await waitUntilReady(gateway.baseUrl);
			expect(snapshot.ready).toBe(true);
		} finally {
			await gateway.stop();
			await upstream.stop();
		}
	});
});
