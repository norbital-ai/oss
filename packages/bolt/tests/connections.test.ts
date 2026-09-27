// Connections (§3.3.8, §5.11.4): the OAuth2 flow every host binds, the header auth injected host-side, and an
// automation's `ctx.http` answer. One guarantee per test, against a loopback provider.
import { createHash } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { bindConnections, connectionCall, connections, oauth, tokenName, type OAuth } from '../src/engine/connections.ts';
import type { EngineManifest } from '../src/engine/contracts.ts';
import type { HttpPort } from '../src/engine/integrations/runner.ts';
import { publicFetch, type Address, type PageWrite } from '../src/engine/net.ts';

const servers: HttpServer[] = [];
afterAll(() => { for (const s of servers) s.close(); });
async function serve(handle: (url: URL, body: Buffer) => { status: number; json?: unknown }): Promise<string> {
	const s = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c)).on('end', () => {
			const r = handle(new URL(req.url!, 'http://x'), Buffer.concat(chunks));
			res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.json ?? {}));
		});
	});
	servers.push(s);
	await new Promise<void>((ok) => s.listen(0, '127.0.0.1', () => ok()));
	const a = s.address();
	return `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
}
const signal = () => AbortSignal.timeout(5_000);

describe('OAuth2 connections (§5.11.4)', () => {
	let now = Date.parse('2026-09-25T00:00:00Z');
	const issued: string[] = [];
	let refreshable = true, challenge = '';
	const providerUrl = serve((url, body) => {
		const p = new URLSearchParams(body.toString());
		if (url.pathname !== '/token' || p.get('client_id') !== 'cid' || p.get('client_secret') !== 'csecret') return { status: 401, json: { error: 'invalid_client' } };
		const n = issued.length + 1;
		if (p.get('grant_type') === 'client_credentials') { issued.push(`cc${n}`); return { status: 200, json: { access_token: `cc${n}`, expires_in: 600 } }; }
		if (p.get('grant_type') === 'authorization_code') {
			const ok = p.get('code') === 'good' && createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') === challenge;
			if (!ok) return { status: 400, json: { error: 'invalid_grant' } };
			issued.push(`a${n}`);
			return { status: 200, json: { access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 600 } };
		}
		if (p.get('grant_type') === 'refresh_token' && refreshable) { issued.push(`a${n}`); return { status: 200, json: { access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 600 } }; }
		return { status: 400, json: { error: 'invalid_grant' } };
	});
	const spec = (extra: object) => ({ baseUrl: 'API', auth: { oauth2: { tokenUrl: 'TOKEN', clientId: 'CID', clientSecret: 'CSECRET', ...extra } } });
	const m = { connections: { cc: spec({ grant: 'client_credentials' }),
		ws: spec({ grant: 'authorization_code', per: 'workspace', authorizeUrl: 'AUTHORIZE', scopes: ['read'] }),
		me: spec({ grant: 'authorization_code', per: 'user', authorizeUrl: 'AUTHORIZE', scopes: ['read'] }) } } as unknown as EngineManifest;
	const store = new Map<string, string>();
	const secrets = { use: async (o: string, n: string) => store.get(`${o}/${n}`) ?? null,
		set: async (o: string, n: string, v: string) => { store.set(`${o}/${n}`, v); }, clear: async (o: string, n: string) => { store.delete(`${o}/${n}`); } };
	const make = async () => {
		const base = await providerUrl;
		const env = (n: string) => ({ API: `${base}/api`, TOKEN: `${base}/token`, CID: 'cid', CSECRET: 'csecret', AUTHORIZE: 'https://provider.example/authorize' } as { [k: string]: string })[n];
		return { env, auth: oauth(m, env, secrets, 'https://acme.example', fetch, () => now) };
	};

	it('client_credentials: fetches once, caches, and refreshes before expiry', async () => {
		const { auth } = await make();
		expect(await auth.token('cc', undefined)).toBe('cc1');
		expect(await auth.token('cc', undefined)).toBe('cc1');
		now += 541_000; // inside the minute before expiry
		expect(await auth.token('cc', undefined)).toBe('cc2');
	});

	it('authorization_code: PKCE consent bound to the member, rotated refresh, revoked consent asks to reconnect', async () => {
		const { auth } = await make();
		const consent = new URL(auth.consent('ws', 'u1'));
		expect(consent.searchParams.get('redirect_uri')).toBe('https://acme.example/__bolt/connections/callback');
		expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
		challenge = consent.searchParams.get('code_challenge')!;
		const state = consent.searchParams.get('state')!;
		await expect(auth.callback(state, 'good', 'u2')).rejects.toThrow(/not yours/); // another member cannot finish it, and the state is spent
		const again = new URL(auth.consent('ws', 'u1'));
		challenge = again.searchParams.get('code_challenge')!;
		expect(await auth.callback(again.searchParams.get('state')!, 'good', 'u1')).toBe('ws');
		const first = JSON.parse(store.get(`workspace/${tokenName('ws')}`)!) as { access: string; refresh: string };
		expect(await auth.token('ws', undefined)).toBe(first.access);
		now += 600_000;
		const second = await auth.token('ws', undefined);
		const rotated = JSON.parse(store.get(`workspace/${tokenName('ws')}`)!) as { access: string; refresh: string };
		expect(second).not.toBe(first.access);
		expect(rotated.refresh).not.toBe(first.refresh);
		now += 600_000;
		refreshable = false;
		await expect(auth.token('ws', undefined)).rejects.toMatchObject({ kind: 'unauthorized', connection: 'ws', reconnect: true });
		expect(store.has(`workspace/${tokenName('ws')}`)).toBe(false);
		await expect(auth.token('me', undefined)).rejects.toMatchObject({ kind: 'unauthorized', reconnect: false }); // per-user, system actor
		await expect(auth.token('me', 'u1')).rejects.toMatchObject({ kind: 'unauthorized', reconnect: true }); // never connected
	});

	it('injects the bearer host-side on a connection call', async () => {
		refreshable = true;
		const { env, auth } = await make();
		let seen: string | null = null;
		const f = (async (_u: URL, init: RequestInit) => { seen = new Headers(init.headers).get('authorization'); return new Response('{}'); }) as unknown as typeof fetch;
		await connections(m, env, f, auth).request('cc', { method: 'GET', path: '/x' }, signal());
		expect(seen).toMatch(/^Bearer cc\d+$/);
	});
});

describe("an automation's ctx.http (§3.3.8)", () => {
	const port = (status: number, body: unknown, seen: unknown[] = []): HttpPort =>
		({ request: async (connection, r, _s, as) => { seen.push({ connection, ...r, as }); return { status, body: body as never }; } });
	const call = (method: string, args: unknown[]) => ({ op: 'facility' as const, facility: 'http' as const, method, args: args as never });

	it('sends the method, path and query as text through the named connection, as the member', async () => {
		const seen: unknown[] = [];
		const r = await connectionCall(port(200, { items: [] }, seen), call('put', ['cal', '/events', { query: { max: 5, all: true }, body: { a: 1 }, output: { kind: 'json' } }]), signal(), 'u1');
		expect(r).toEqual({ ok: true, value: { items: [] } });
		expect(seen).toEqual([{ connection: 'cal', method: 'PUT', path: '/events', query: { max: '5', all: 'true' }, body: { a: 1 }, as: { user: 'u1' } }]);
	});

	it('a 429 is rateLimited, another non-2xx is upstream with its status, a body that is not the output is upstream', async () => {
		expect(await connectionCall(port(429, ''), call('get', ['cal', '/x', { output: { kind: 'json' } }]), signal(), undefined)).toMatchObject({ ok: false, error: { kind: 'rateLimited', status: 429 } });
		expect(await connectionCall(port(403, 'no key'), call('get', ['cal', '/x', { output: { kind: 'json' } }]), signal(), undefined)).toMatchObject({ ok: false, error: { kind: 'upstream', status: 403, message: /403: no key/ } });
		expect(await connectionCall(port(200, 'text'), call('get', ['cal', '/x', { output: { kind: 'object', fields: { n: { kind: 'int' } } } }]), signal(), undefined)).toMatchObject({ ok: false, error: { kind: 'upstream' } });
	});
});

describe('the connection port stays inside its base URL (L-BOLT-334)', () => {
	const m = { connections: { api: { baseUrl: 'API', auth: { bearer: 'KEY' } } } } as unknown as EngineManifest;
	let reads = 0;
	const env = (n: string) => { if (n === 'KEY') reads++; return ({ API: 'https://api.example.test/v3', KEY: 'secret' } as { [k: string]: string })[n]; };

	it('refuses an absolute, protocol-relative, traversing or encoded path before the credential is read or a request made', async () => {
		let calls = 0;
		const port = connections(m, env, (async () => { calls++; return new Response('{}'); }) as unknown as typeof fetch, {} as OAuth);
		for (const path of ['https://attacker.test', '//attacker.test', '../admin', 'a/../../admin', '%2e%2e/admin', 'a/%2Fadmin', 'a/%255cadmin',
			'a\\b', 'a?key=secret', 'a#fragment', 'x:y', '%zz'])
			await expect(port.request('api', { method: 'GET', path }, signal()), path).rejects.toThrow(/leaves the connection's base URL/);
		expect([reads, calls]).toEqual([0, 0]);
	});

	it('keeps a page cursor inside the declared prefix, encoded as a query parameter', async () => {
		let seen = '';
		const port = connections(m, env, (async (u: URL) => { seen = String(u); return new Response('{}'); }) as unknown as typeof fetch, {} as OAuth);
		await port.request('api', { method: 'GET', path: '/calendars/a%40b/events', query: { pageToken: 'a+b/c=' } }, signal());
		expect(seen).toBe('https://api.example.test/v3/calendars/a%40b/events?pageToken=a%2Bb%2Fc%3D');
	});

	it('a host that binds no fetch gets the public guard: a loopback base is refused', async () => {
		const { http } = bindConnections({ connections: { api: { baseUrl: 'API' } } } as unknown as EngineManifest, { publicUrl: 'https://acme.example',
			secrets: { env: (n) => (n === 'API' ? 'http://127.0.0.1:9/v1' : undefined), use: async () => null, set: async () => {}, clear: async () => {} } });
		await expect(http.request('api', { method: 'GET', path: 'x' }, signal())).rejects.toThrow(/HTTPS/);
	});
});

describe('publicFetch: the hardened connector (L-BOLT-366)', () => {
	const pub: Address[] = [{ address: '93.184.216.34', family: 4 }];
	const resolve = async (host: string): Promise<readonly Address[]> => host === 'internal.test' ? [{ address: '10.0.0.5', family: 4 }] : pub;

	it('refuses plain HTTP, a custom port, a private address and a transport header before any socket opens', async () => {
		let sent = 0;
		const f = publicFetch({ resolve, request: async () => { sent++; return { status: 200, contentType: '', body: '' }; } });
		for (const [url, init] of [['http://api.example.test/', {}], ['https://api.example.test:8443/', {}], ['https://internal.test/', {}],
			['https://169.254.169.254/latest', {}], ['https://api.example.test/', { headers: { host: 'x' } }], ['https://api.example.test/', { headers: { 'proxy-authorization': 'x' } }]] as const)
			await expect(f(url, init), url).rejects.toThrow();
		expect(sent).toBe(0);
	});

	it('re-checks each redirect, drops the credential on a cross-origin hop, and continues a 303 to a write as a bodiless GET', async () => {
		const hops: { url: string; headers: { [k: string]: string }; write?: PageWrite }[] = [];
		const f = publicFetch({ resolve, request: async (url, _a, _s, headers = {}, write) => {
			hops.push({ url: String(url), headers: { ...headers }, ...(write === undefined ? {} : { write }) });
			return url.hostname === 'api.example.test' ? { status: 303, location: 'https://cdn.example.test/done', contentType: '', body: '' }
				: { status: 200, contentType: 'application/json', headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
		} });
		const res = await f(new URL('https://api.example.test/x'), { method: 'POST', body: '{}',
			headers: { authorization: 'Bearer t', accept: 'application/json', 'content-type': 'application/json' } });
		expect(await res.json()).toEqual({ ok: true });
		expect(hops).toEqual([
			{ url: 'https://api.example.test/x', headers: { authorization: 'Bearer t', accept: 'application/json', 'content-type': 'application/json' }, write: { method: 'POST', body: '{}' } },
			{ url: 'https://cdn.example.test/done', headers: { accept: 'application/json' } },
		]);
		const toPrivate = publicFetch({ resolve, request: async () => ({ status: 302, location: 'https://internal.test/', contentType: '', body: '' }) });
		await expect(toPrivate('https://api.example.test/')).rejects.toThrow(/private/);
	});

	it('allowLoopback (a dev host) admits this machine\'s own names over HTTP, never a private network (L-BOLT-366)', async () => {
		const loop = async (host: string): Promise<readonly Address[]> => host === 'rebind.localhost' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
		const ok = async () => ({ status: 200, contentType: '', body: 'ok' });
		expect(await (await publicFetch({ resolve: loop, request: ok, allowLoopback: true })('http://crm.localhost:5173/api')).text()).toBe('ok');
		expect(await (await publicFetch({ resolve: loop, request: ok, allowLoopback: true })('http://127.0.0.1:8080/')).text()).toBe('ok');
		await expect(publicFetch({ resolve: loop, request: ok, allowLoopback: true })('http://rebind.localhost/')).rejects.toThrow(/private/);
		await expect(publicFetch({ resolve, request: ok, allowLoopback: true })('http://internal.test/')).rejects.toThrow(/HTTPS/);
		await expect(publicFetch({ resolve: loop, request: ok })('http://crm.localhost:5173/api')).rejects.toThrow(/HTTPS/);
	});

	it('stops after five redirects', async () => {
		const f = publicFetch({ resolve, request: async (url) => ({ status: 307, location: `${url.href}x`, contentType: '', body: '' }) });
		await expect(f('https://api.example.test/')).rejects.toThrow(/five redirects/);
	});
});
