// The http driver's request (§2.6) and an instance's `ctx.request` answer: the path confined under the definition's base
// URL before any credential is read, auth from the instance's sealed credential or its OAuth token (refreshed and written
// back), the public network guard by default, and a 429 / non-2xx / wrong body answered as their facility errors. One
// guarantee per test.
import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, describe, expect, it } from '@effect/vitest';
import type { IntegrationSpec } from '../src/decl/runtime/integration.ts';
import type { Json } from '../src/decl/values.ts';
import { httpRequest, type HttpInstance } from '../src/engine/integrations/http.ts';
import { Deferred, Effect, Fiber, FiberSet, Result } from 'effect';
import { TestClock } from 'effect/testing';
import { Port } from '../src/engine/port.ts';
import { Drivers, Http } from '../src/engine/ports.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { manifest } from './catalogue-fixture.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { BoltError } from '../src/protocol/errors.ts';
import { instanceRequest } from '../src/engine/integrations/instances.ts';
import { httpPort, publicFetch, type Address, type PageWrite } from '../src/node/net.ts';
const servers: HttpServer[] = [];
afterAll(() => {
	for (const s of servers) s.close();
});
async function serve(
	handle: (
		url: URL,
		body: Buffer
	) => {
		status: number;
		json?: unknown;
	}
): Promise<string> {
	const s = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req
			.on('data', (c: Buffer) => chunks.push(c))
			.on('end', () => {
				const r = handle(new URL(req.url!, 'http://x'), Buffer.concat(chunks));
				res
					.writeHead(r.status, { 'content-type': 'application/json' })
					.end(JSON.stringify(r.json ?? {}));
			});
	});
	servers.push(s);
	await new Promise<void>((ok) => s.listen(0, '127.0.0.1', () => ok()));
	const a = s.address();
	return `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
}
const def = (
	http: NonNullable<IntegrationSpec['http']>,
	configuration?: NonNullable<IntegrationSpec['configuration']>,
	oauth?: IntegrationSpec['oauth']
): IntegrationSpec => ({
	description: 'An API',
	driver: 'http',
	credential: { key: { kind: 'text' } },
	...(configuration === undefined ? {} : { configuration }),
	...(oauth === undefined ? {} : { oauth }),
	http
});
const seen =
	(
		calls: {
			url: string;
			headers: Headers;
		}[]
	): typeof fetch =>
	async (u, init = {}) => {
		calls.push({ url: String(u), headers: new Headers(init.headers) });
		return new Response('{"ok":true}');
	};
/** One request through `fetcher` standing in for the host's http port. */
const request = (
	spec: IntegrationSpec,
	instance: HttpInstance,
	op: Json,
	fetcher: typeof fetch,
	secrets?: Readonly<Record<string, string>>
) =>
	httpRequest(spec, instance, op, secrets === undefined ? {} : { secrets }).pipe(
		Effect.provide(
			Http.fromAbi({
				fetch: async (r, _options, signal) => {
					const response = await fetcher(r.url, {
						method: r.method,
						headers: Object.fromEntries(r.headers),
						...(r.body === undefined ? {} : { body: new TextDecoder().decode(r.body) }),
						signal
					});
					return {
						status: response.status,
						headers: [...response.headers],
						body: new Uint8Array(await response.arrayBuffer())
					};
				}
			})
		)
	);
describe('the http driver stays inside its base URL (L-BOLT-334)', () => {
	const api = def({ baseUrl: 'https://api.example.test/v3', auth: { bearer: 'key' } });
	let reads = 0;
	class CountingCredentials extends Map<string, Json> {
		override get(name: string) {
			if (name === 'credential') reads++;
			return super.get(name);
		}
	}
	const credentials = new CountingCredentials([['credential', { key: 'secret' }]]);
	it.effect(
		'refuses an absolute, protocol-relative, traversing or encoded path before the credential is read or a request made',
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
				const calls: {
					url: string;
					headers: Headers;
				}[] = [];
				for (const path of [
					'https://attacker.test',
					'//attacker.test',
					'../admin',
					'a/../../admin',
					'%2e%2e/admin',
					'a/%2Fadmin',
					'a/%255cadmin',
					'a\\b',
					'a?key=secret',
					'a#fragment',
					'x:y',
					'%zz'
				])
					yield* Effect.flip(
						request(api, { configuration: {}, credentials }, { method: 'GET', path }, seen(calls))
					).pipe(
						Effect.tap((error) =>
							Effect.sync(() =>
								expect(() => {
									throw error;
								}, path).toThrow(/leaves the integration's base URL/)
							)
						)
					);
				expect([reads, calls.length]).toEqual([0, 0]);
			})
	);
	it.effect(
		'keeps a page cursor inside the declared prefix, encoded as a query parameter, the bearer injected host-side',
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
				const calls: {
					url: string;
					headers: Headers;
				}[] = [];
				expect(
					yield* request(
						api,
						{ configuration: {}, credentials },
						{ method: 'GET', path: '/calendars/a%40b/events', query: { pageToken: 'a+b/c=' } },
						seen(calls)
					)
				).toEqual({ status: 200, body: { ok: true } });
				expect(calls.map((c) => [c.url, c.headers.get('authorization')])).toEqual([
					[
						'https://api.example.test/v3/calendars/a%40b/events?pageToken=a%2Bb%2Fc%3D',
						'Bearer secret'
					]
				]);
			})
	);
	it.effect(
		'takes its base URL from a configuration field, and a header credential under its declared name',
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
				const calls: {
					url: string;
					headers: Headers;
				}[] = [];
				const routes = def(
					{ baseUrl: 'base', auth: { header: { name: 'X-Goog-Api-Key', value: 'key' } } },
					{ base: { kind: 'text' } }
				);
				yield* request(
					routes,
					{
						configuration: { base: 'https://routes.example.test/' },
						credentials: new Map([['credential', { key: 'k1' }]])
					},
					{ method: 'POST', path: 'distanceMatrix/v2:computeRouteMatrix', body: {} },
					seen(calls)
				);
				expect(
					calls.map((c) => [c.url, c.headers.get('x-goog-api-key'), c.headers.get('content-type')])
				).toEqual([
					[
						'https://routes.example.test/distanceMatrix/v2:computeRouteMatrix',
						'k1',
						'application/json'
					]
				]);
				yield* Effect.flip(
					request(
						routes,
						{ configuration: {}, credentials: new Map() },
						{ method: 'GET', path: 'x' },
						seen(calls)
					)
				).pipe(
					Effect.tap((error) =>
						Effect.sync(() => expect(error).toMatchObject({ code: 'unavailable' }))
					)
				);
			})
	);
	it.effect("the host's http port keeps the public guard: a loopback base is refused", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
			yield* Effect.flip(
				httpRequest(
					def({ baseUrl: 'base' }, { base: { kind: 'text' } }),
					{ configuration: { base: 'http://127.0.0.1:9/v1' }, credentials: new Map() },
					{ method: 'GET', path: 'x' }
				).pipe(Effect.provide(Http.fromAbi(httpPort)))
			).pipe(
				Effect.tap((error) =>
					Effect.sync(() =>
						expect(() => {
							throw error;
						}).toThrow(/HTTPS/)
					)
				)
			);
		})
	);
});
describe('an http instance on OAuth: its token refreshed before expiry and written back', () => {
	let now = Date.parse('2026-09-25T00:00:00Z'),
		refreshable = true;
	const token = serve((url, body) => {
		const p = new URLSearchParams(body.toString());
		if (
			url.pathname !== '/token' ||
			p.get('client_id') !== 'cid' ||
			p.get('client_secret') !== 'csecret'
		)
			return { status: 401, json: { error: 'invalid_client' } };
		return p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'r1' && refreshable
			? { status: 200, json: { access_token: 'a2', expires_in: 600 } }
			: { status: 400, json: { error: 'invalid_grant' } };
	});
	const oauthDef = () =>
		Effect.gen(function* () {
			return def({ baseUrl: 'https://api.example.test/' }, undefined, {
				client: 'CID',
				secret: 'CSECRET',
				authorize: 'https://provider.example/authorize',
				token: `${yield* Port.attempt('test', () => token)}/token`
			});
		});
	const secrets = { CID: 'cid', CSECRET: 'csecret' };
	it.effect(
		'uses a live token, refreshes an expiring one through the token endpoint (keeping the refresh token), and asks to pair again when refused',
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
				const calls: {
						url: string;
						headers: Headers;
					}[] = [],
					writes: [string, Json | null][] = [];
				const f: typeof fetch = async (u, init = {}) =>
					String(u).endsWith('/token') ? fetch(u, init) : seen(calls)(u, init);
				const inst = (stored: Json) => ({
					configuration: {},
					credentials: new Map([['token', stored]]),
					write: (c: ReadonlyMap<string, Json | null>) =>
						Effect.sync(() => {
							writes.push(...c);
						})
				});
				const d = yield* oauthDef();
				yield* request(
					d,
					inst({ access: 'a1', refresh: 'r1', exp: now + 600000 }),
					{ method: 'GET', path: 'me' },
					f,
					secrets
				);
				yield* request(
					d,
					inst({ access: 'a1', refresh: 'r1', exp: now + 30000 }),
					{ method: 'GET', path: 'me' },
					f,
					secrets
				);
				expect(calls.map((c) => c.headers.get('authorization'))).toEqual([
					'Bearer a1',
					'Bearer a2'
				]);
				expect(writes).toEqual([['token', { access: 'a2', refresh: 'r1', exp: now + 600000 }]]);
				refreshable = false;
				now += 1;
				yield* TestClock.setTime(now);
				yield* Effect.flip(
					request(
						d,
						inst({ access: 'a1', refresh: 'r1', exp: now }),
						{ method: 'GET', path: 'me' },
						f,
						secrets
					)
				).pipe(
					Effect.tap((error) =>
						Effect.sync(() => expect(error).toMatchObject({ code: 'unavailable' }))
					)
				);
				expect(writes.at(-1)).toEqual(['token', null]);
			})
	);
});
describe('a token endpoint that fails, or a refresh that loses a race', () => {
	const def0 = def({ baseUrl: 'https://api.example.test/' }, undefined, {
		client: 'CID',
		secret: 'CSECRET',
		authorize: 'https://provider.example/authorize',
		token: 'https://provider.example/token'
	});
	const secrets = { CID: 'cid', CSECRET: 'csecret' };
	const now = Date.parse('2026-09-25T00:00:00Z');
	const expiring: Json = { access: 'a1', refresh: 'r1', exp: now };
	/** The token endpoint answers `answer`; the API answers 200 and records the bearer it saw. */
	const call = (
		answer: Response,
		write: (c: ReadonlyMap<string, Json | null>) => Effect.Effect<void, BoltError>,
		calls: {
			url: string;
			headers: Headers;
		}[] = []
	) =>
		Effect.gen(function* () {
			const f: typeof fetch = async (u, init = {}) =>
				String(u).endsWith('/token') ? answer : seen(calls)(u, init);
			return yield* request(
				def0,
				{ configuration: {}, credentials: new Map([['token', expiring]]), write },
				{ method: 'GET', path: 'me' },
				f,
				secrets
			);
		});
	it.effect('an outage, a throttle or an error other than a refused grant keeps the token', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
			const writes: [string, Json | null][] = [];
			const write = (c: ReadonlyMap<string, Json | null>) =>
				Effect.sync(() => {
					writes.push(...c);
				});
			yield* Effect.flip(
				call(Response.json({ error: 'temporarily_unavailable' }, { status: 503 }), write)
			).pipe(
				Effect.tap((error) => Effect.sync(() => expect(error).toMatchObject({ code: 'upstream' })))
			);
			yield* Effect.flip(call(Response.json({}, { status: 429 }), write)).pipe(
				Effect.tap((error) =>
					Effect.sync(() => expect(error).toMatchObject({ code: 'rateLimited' }))
				)
			);
			yield* Effect.flip(
				call(Response.json({ error: 'invalid_request' }, { status: 400 }), write)
			).pipe(
				Effect.tap((error) => Effect.sync(() => expect(error).toMatchObject({ code: 'upstream' })))
			);
			yield* Effect.flip(call(new Response('<html>gateway</html>', { status: 502 }), write)).pipe(
				Effect.tap((error) => Effect.sync(() => expect(error).toMatchObject({ code: 'upstream' })))
			);
			expect(writes).toEqual([]);
			yield* Effect.flip(
				call(Response.json({ error: 'invalid_client' }, { status: 401 }), write)
			).pipe(
				Effect.tap((error) =>
					Effect.sync(() => expect(error).toMatchObject({ code: 'unavailable' }))
				)
			);
			expect(writes).toEqual([['token', null]]);
		})
	);
	it.effect(
		"a refused grant whose delete is fenced (another request refreshed meanwhile) keeps that request's token; a fenced store of a fresh token still serves its request",
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
				const fencedWrite = () =>
					Effect.fail(BoltError.make('fenced', 'facility', 'another link took the instance'));
				yield* Effect.flip(
					call(Response.json({ error: 'invalid_grant' }, { status: 400 }), fencedWrite)
				).pipe(
					Effect.tap((error) =>
						Effect.sync(() => expect(error).toMatchObject({ code: 'upstream' }))
					)
				);
				const calls: {
					url: string;
					headers: Headers;
				}[] = [];
				expect(
					yield* call(Response.json({ access_token: 'a2', expires_in: 600 }), fencedWrite, calls)
				).toEqual({ status: 200, body: { ok: true } });
				expect(calls.map((c) => c.headers.get('authorization'))).toEqual(['Bearer a2']);
			})
	);
});
describe("an instance's ctx.request answer (§2.6)", () => {
	const m: EngineManifest = {
		...manifest,
		integrations: {
			api: { description: 'An API', driver: 'http', http: { baseUrl: 'https://api.example.test/' } }
		}
	};
	const db = (active = true) =>
		TenantDb.typed({
			read: () =>
				Effect.succeed([
					{
						rows: [
							{
								id: 'api',
								integration: 'api',
								owner: null,
								active,
								configuration: {},
								status: null
							}
						],
						affected: 0
					}
				]),
			write: () => Effect.succeed({ rows: [], affected: 0 }),
			session: () =>
				Effect.fail(DbError.make('0A000', 'this fixture does not support leased sessions')),
			transaction: () => Effect.fail(DbError.make('XX000', 'this test opens no transaction'))
		});
	const absent: Drivers['Service'] = {
		available: false,
		send: () => Port.unavailable('link'),
		typing: () => Port.unavailable('link'),
		request: () => Port.unavailable('link'),
		read: () => Port.unavailable('link'),
		changed: () => Port.unavailable('link')
	};
	const links = (status: number, body: Json, sent: Json[] = []): Drivers['Service'] => ({
		...absent,
		available: true,
		request: (_i, op) =>
			Effect.sync(() => {
				sent.push(op);
				return { status, body };
			})
	});
	it.effect('sends the op without its output through the instance link, and answers the body', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
			const sent: Json[] = [];
			expect(
				yield* instanceRequest(
					{ manifest: m, db: db(), links: links(200, { items: [] }, sent) },
					'api',
					{
						method: 'PUT',
						path: '/events',
						query: { max: 5 },
						body: { a: 1 },
						output: { kind: 'json' }
					}
				)
			).toEqual({ ok: true, value: { items: [] } });
			expect(sent).toEqual([{ method: 'PUT', path: '/events', query: { max: 5 }, body: { a: 1 } }]);
		})
	);
	it.effect('refuses a malformed nested output declaration before invoking the instance link', () =>
		Effect.gen(function* () {
			const sent: Json[] = [];
			const result = yield* instanceRequest(
				{ manifest: m, db: db(), links: links(200, {}, sent) },
				'api',
				{
					method: 'GET',
					path: '/events',
					output: { kind: 'object', fields: { total: { kind: 'decimal' } } }
				}
			);
			expect(result).toMatchObject({ ok: false, error: { kind: 'bolt', code: 'invalidInput' } });
			expect(sent).toEqual([]);
		})
	);
	it.effect(
		'a 429 is rateLimited, permanent 4xx is invalid, and retryable statuses or a body outside the output are upstream',
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
				const call = (status: number, body: Json, output: Json) =>
					instanceRequest({ manifest: m, db: db(), links: links(status, body) }, 'api', {
						method: 'GET',
						path: 'x',
						output
					});
				expect(yield* call(429, '', { kind: 'json' })).toMatchObject({
					ok: false,
					error: { kind: 'rateLimited', status: 429 }
				});
				expect(yield* call(403, 'no key', { kind: 'json' })).toMatchObject({
					ok: false,
					error: { kind: 'invalid', status: 403, message: expect.stringMatching(/403: no key/) }
				});
				for (const status of [408, 503])
					expect(yield* call(status, 'try later', { kind: 'json' })).toMatchObject({
						ok: false,
						error: { kind: 'upstream', status, message: expect.stringContaining('try later') }
					});
				expect(
					yield* call(200, 'text', { kind: 'object', fields: { n: { kind: 'int' } } })
				).toMatchObject({ ok: false, error: { kind: 'upstream' } });
			})
	);
	it.effect(
		'a paused instance, a host without links and a malformed op are refused before any I/O',
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
				const sent: Json[] = [];
				expect(
					yield* instanceRequest(
						{ manifest: m, db: db(false), links: links(200, {}, sent) },
						'api',
						{ method: 'GET', path: 'x' }
					)
				).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
				expect(
					yield* instanceRequest({ manifest: m, db: db(), links: absent }, 'api', {
						method: 'GET',
						path: 'x'
					})
				).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
				expect(
					yield* instanceRequest({ manifest: m, db: db(), links: links(200, {}, sent) }, 'api', {
						method: 'FETCH',
						path: 'x'
					})
				).toMatchObject({ ok: false, error: { kind: 'bolt', code: 'invalidInput' } });
				expect(sent).toEqual([]);
			})
	);
});
describe('publicFetch: the hardened connector (L-BOLT-366)', () => {
	const pub: Address[] = [{ address: '93.184.216.34', family: 4 }];
	const resolve = async (host: string): Promise<readonly Address[]> =>
		host === 'internal.test' ? [{ address: '10.0.0.5', family: 4 }] : pub;
	it.effect('an aborted provider fetch interrupts its scoped request before rejecting', () =>
		Effect.gen(function* () {
			const run = yield* FiberSet.makeRuntimePromise<never>();
			const started = yield* Deferred.make<void>();
			const stopped = yield* Deferred.make<void>();
			const f = publicFetch(run, {
				resolve,
				request: () =>
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.onInterrupt(() => Deferred.succeed(stopped, undefined))
					)
			});
			const controller = new AbortController();
			const pending = yield* Port.attempt('test', () =>
				f('https://api.example.test/', { signal: controller.signal })
			).pipe(Effect.result, Effect.forkChild);
			yield* Deferred.await(started);
			controller.abort();
			expect(Result.isFailure(yield* Fiber.join(pending))).toBe(true);
			expect(yield* Deferred.isDone(stopped)).toBe(true);
		})
	);
	it.effect(
		'refuses plain HTTP, a custom port, a private address and a transport header before any socket opens',
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
				let sent = 0;
				const run = yield* FiberSet.makeRuntimePromise<never>();
				const f = publicFetch(run, {
					resolve,
					request: () =>
						Effect.sync(() => {
							sent++;
							return { status: 200, contentType: '', body: '' };
						})
				});
				for (const [url, init] of [
					['http://api.example.test/', {}],
					['https://api.example.test:8443/', {}],
					['https://internal.test/', {}],
					['https://169.254.169.254/latest', {}],
					['https://api.example.test/', { headers: { host: 'x' } }],
					['https://api.example.test/', { headers: { 'proxy-authorization': 'x' } }]
				] as const)
					yield* Effect.flip(Port.attempt('test', () => f(url, init))).pipe(
						Effect.tap((error) =>
							Effect.sync(() =>
								expect(() => {
									throw error;
								}, url).toThrow()
							)
						)
					);
				yield* Effect.flip(
					Port.attempt('test', () => f('https://api.example.test/', { headers: { host: 'x' } }))
				).pipe(
					Effect.tap((error) =>
						Effect.sync(() =>
							expect(() => {
								throw error;
							}).toThrow('An http request cannot set transport headers.')
						)
					)
				);
				expect(sent).toBe(0);
			})
	);
	it.effect(
		're-checks each redirect, drops the credential on a cross-origin hop, and continues a 303 to a write as a bodiless GET',
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
				const run = yield* FiberSet.makeRuntimePromise<never>();
				const hops: {
					url: string;
					headers: {
						[k: string]: string;
					};
					write?: PageWrite;
				}[] = [];
				const f = publicFetch(run, {
					resolve,
					request: (url, _a, headers = {}, write) =>
						Effect.sync(() => {
							hops.push({
								url: String(url),
								headers: { ...headers },
								...(write === undefined ? {} : { write })
							});
							return url.hostname === 'api.example.test'
								? {
										status: 303,
										location: 'https://cdn.example.test/done',
										contentType: '',
										body: ''
									}
								: {
										status: 200,
										contentType: 'application/json',
										headers: { 'content-type': 'application/json' },
										body: '{"ok":true}'
									};
						})
				});
				const res = yield* Port.attempt('test', () =>
					f(new URL('https://api.example.test/x'), {
						method: 'POST',
						body: '{}',
						headers: {
							authorization: 'Bearer t',
							accept: 'application/json',
							'content-type': 'application/json'
						}
					})
				);
				expect(yield* Port.attempt('test', () => res.json())).toEqual({ ok: true });
				expect(hops).toEqual([
					{
						url: 'https://api.example.test/x',
						headers: {
							authorization: 'Bearer t',
							accept: 'application/json',
							'content-type': 'application/json'
						},
						write: { method: 'POST', body: new TextEncoder().encode('{}') }
					},
					{ url: 'https://cdn.example.test/done', headers: { accept: 'application/json' } }
				]);
				const toPrivate = publicFetch(run, {
					resolve,
					request: () =>
						Effect.succeed({
							status: 302,
							location: 'https://internal.test/',
							contentType: '',
							body: ''
						})
				});
				yield* Effect.flip(Port.attempt('test', () => toPrivate('https://api.example.test/'))).pipe(
					Effect.tap((error) =>
						Effect.sync(() =>
							expect(() => {
								throw error;
							}).toThrow(/private/)
						)
					)
				);
			})
	);
	it.effect(
		"allowLoopback (a dev host) admits this machine's own names over HTTP, never a private network (L-BOLT-366)",
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
				const run = yield* FiberSet.makeRuntimePromise<never>();
				const loop = async (host: string): Promise<readonly Address[]> =>
					host === 'rebind.localhost'
						? [{ address: '10.0.0.5', family: 4 }]
						: [{ address: '127.0.0.1', family: 4 }];
				const ok = () => Effect.succeed({ status: 200, contentType: '', body: 'ok' });
				const first = yield* Port.attempt('test', () =>
					publicFetch(run, { resolve: loop, request: ok, allowLoopback: true })(
						'http://crm.localhost:5173/api'
					)
				);
				expect(yield* Port.attempt('test', () => first.text())).toBe('ok');
				const second = yield* Port.attempt('test', () =>
					publicFetch(run, { resolve: loop, request: ok, allowLoopback: true })(
						'http://127.0.0.1:8080/'
					)
				);
				expect(yield* Port.attempt('test', () => second.text())).toBe('ok');
				yield* Effect.flip(
					Port.attempt('test', () =>
						publicFetch(run, { resolve: loop, request: ok, allowLoopback: true })(
							'http://rebind.localhost/'
						)
					)
				).pipe(
					Effect.tap((error) =>
						Effect.sync(() =>
							expect(() => {
								throw error;
							}).toThrow(/private/)
						)
					)
				);
				yield* Effect.flip(
					Port.attempt('test', () =>
						publicFetch(run, { resolve, request: ok, allowLoopback: true })('http://internal.test/')
					)
				).pipe(
					Effect.tap((error) =>
						Effect.sync(() =>
							expect(() => {
								throw error;
							}).toThrow(/HTTPS/)
						)
					)
				);
				yield* Effect.flip(
					Port.attempt('test', () =>
						publicFetch(run, { resolve: loop, request: ok })('http://crm.localhost:5173/api')
					)
				).pipe(
					Effect.tap((error) =>
						Effect.sync(() =>
							expect(() => {
								throw error;
							}).toThrow(/HTTPS/)
						)
					)
				);
			})
	);
	it.effect('stops after five redirects', () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
			const run = yield* FiberSet.makeRuntimePromise<never>();
			const f = publicFetch(run, {
				resolve,
				request: (url) =>
					Effect.succeed({ status: 307, location: `${url.href}x`, contentType: '', body: '' })
			});
			yield* Effect.flip(Port.attempt('test', () => f('https://api.example.test/'))).pipe(
				Effect.tap((error) =>
					Effect.sync(() =>
						expect(() => {
							throw error;
						}).toThrow(/exceeded 5 redirects/)
					)
				)
			);
		})
	);
});
