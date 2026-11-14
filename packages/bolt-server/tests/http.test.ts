// The http driver's request: the path confined under the definition's base URL before any credential is read, auth
// from the instance's sealed credential or its OAuth token (refreshed and written back), the public network guard by
// default, and a 429 / non-2xx / wrong body answered as their facility errors. One guarantee per test.
import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { Json } from 'effect/Schema';
import { TestClock } from 'effect/testing';
import { Fenced, Port, type IntegrationDefinition } from '@norbital-ai/host-api';
import { http_port } from '@norbital-ai/host-api/node';
import { http_request, type HttpInstance } from '../src/http.ts';
const servers: HttpServer[] = [];
afterAll(() => {
	for (const s of servers) s.close();
});
/** A local endpoint answering each request with `handle`'s status and JSON body. */
async function serve(handle: (url: URL, body: Buffer) => { status: number; json?: unknown }): Promise<string> {
	const s = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req
			.on('data', (c: Buffer) => chunks.push(c))
			.on('end', () => {
				const r = handle(new URL(req.url ?? '/', 'http://x'), Buffer.concat(chunks));
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
	http: NonNullable<IntegrationDefinition['http']>,
	configuration?: NonNullable<IntegrationDefinition['configuration']>,
	oauth?: IntegrationDefinition['oauth']
): IntegrationDefinition => ({
	description: 'An API',
	driver: 'http',
	credential: { key: {} },
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
	spec: IntegrationDefinition,
	instance: HttpInstance,
	op: Json,
	fetcher: typeof fetch,
	secrets?: Readonly<Record<string, string>>
) =>
	http_request(
		spec,
		instance,
		op,
		{
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
		},
		secrets === undefined ? {} : { secrets }
	);
describe('the http driver stays inside its base URL', () => {
	const api = def({ base_url: 'https://api.example.test/v3', auth: { bearer: 'key' } });
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
					{ base_url: 'base', auth: { header: { name: 'X-Goog-Api-Key', value: 'key' } } },
					{ base: {} }
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
						Effect.sync(() => expect(error).toMatchObject({ _tag: 'Unavailable' }))
					)
				);
			})
	);
	it.effect("the host's http port keeps the public guard: a loopback base is refused", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
			yield* Effect.flip(
				http_request(
					def({ base_url: 'base' }, { base: {} }),
					{ configuration: { base: 'http://127.0.0.1:9/v1' }, credentials: new Map() },
					{ method: 'GET', path: 'x' },
					http_port
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
			return def({ base_url: 'https://api.example.test/' }, undefined, {
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
						Effect.sync(() => expect(error).toMatchObject({ _tag: 'Unavailable' }))
					)
				);
				expect(writes.at(-1)).toEqual(['token', null]);
			})
	);
});
describe('a token endpoint that fails, or a refresh that loses a race', () => {
	const def0 = def({ base_url: 'https://api.example.test/' }, undefined, {
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
		write: HttpInstance['write'],
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
				Effect.tap((error) => Effect.sync(() => expect(error).toMatchObject({ kind: 'upstream' })))
			);
			yield* Effect.flip(call(Response.json({}, { status: 429 }), write)).pipe(
				Effect.tap((error) =>
					Effect.sync(() => expect(error).toMatchObject({ kind: 'rate_limited' }))
				)
			);
			yield* Effect.flip(
				call(Response.json({ error: 'invalid_request' }, { status: 400 }), write)
			).pipe(
				Effect.tap((error) => Effect.sync(() => expect(error).toMatchObject({ kind: 'upstream' })))
			);
			yield* Effect.flip(call(new Response('<html>gateway</html>', { status: 502 }), write)).pipe(
				Effect.tap((error) => Effect.sync(() => expect(error).toMatchObject({ kind: 'upstream' })))
			);
			expect(writes).toEqual([]);
			yield* Effect.flip(
				call(Response.json({ error: 'invalid_client' }, { status: 401 }), write)
			).pipe(
				Effect.tap((error) =>
					Effect.sync(() => expect(error).toMatchObject({ _tag: 'Unavailable' }))
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
					Effect.fail(new Fenced({ instance: 'api', message: 'another link took the instance' }));
				yield* Effect.flip(
					call(Response.json({ error: 'invalid_grant' }, { status: 400 }), fencedWrite)
				).pipe(
					Effect.tap((error) =>
						Effect.sync(() => expect(error).toMatchObject({ kind: 'upstream' }))
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
