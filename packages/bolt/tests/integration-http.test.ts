// An instance's `ctx.request` answer through its link, and `public_fetch`, the hardened connector providers use.
import { describe, expect, it } from '@effect/vitest';
import type { Json } from '../src/decl/values.ts';
import { Deferred, Effect, Fiber, FiberSet, Result } from 'effect';
import { TestClock } from 'effect/testing';
import { DbError, Port } from '@norbital-ai/host-api';
import { Drivers } from '../src/engine/ports.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { manifest } from './catalogue-fixture.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { instanceRequest } from '../src/engine/integrations/instances.ts';
import { public_fetch, type Address, type PageWrite } from '@norbital-ai/host-api/node';
describe("an instance's ctx.request answer", () => {
	const m: EngineManifest = {
		...manifest,
		integrations: {
			api: { description: 'An API', driver: 'http', http: { base_url: 'https://api.example.test/' } }
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
	it.effect('paces consecutive requests using the configured count and window', () =>
		Effect.gen(function* () {
			for (const [rate, spacing] of [['2/s', 500], ['5/10s', 2_000]] as const) {
				yield* TestClock.setTime(Date.parse('2026-09-25T00:00:00Z'));
				const paced: EngineManifest = { ...m, integrations: { api: {
					description: 'A paced API', driver: 'http', http: { base_url: 'https://api.example.test/' }, rate
				} } };
				const sent: Json[] = [], database = db();
				const call = () => instanceRequest({ manifest: paced, db: database, links: links(200, {}, sent) }, 'api', {
					method: 'GET', path: '/paced', output: { kind: 'json' }
				});
				expect(yield* call()).toEqual({ ok: true, value: {} });
				const second = yield* call().pipe(Effect.forkChild);
				yield* TestClock.adjust(spacing - 1);
				expect(sent).toHaveLength(1);
				yield* TestClock.adjust(1);
				expect(yield* Fiber.join(second)).toEqual({ ok: true, value: {} });
				expect(sent).toHaveLength(2);
			}
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
			expect(result).toMatchObject({ ok: false, error: { kind: 'bolt', code: 'invalid_input' } });
			expect(sent).toEqual([]);
		})
	);
	it.effect(
		'a 429 is rate_limited, permanent 4xx is invalid, and retryable statuses or a body outside the output are upstream',
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
					error: { kind: 'rate_limited', status: 429 }
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
				).toMatchObject({ ok: false, error: { kind: 'bolt', code: 'invalid_input' } });
				expect(sent).toEqual([]);
			})
	);
});
describe('public_fetch: the hardened connector', () => {
	const pub: Address[] = [{ address: '93.184.216.34', family: 4 }];
	const resolve = async (host: string): Promise<readonly Address[]> =>
		host === 'internal.test' ? [{ address: '10.0.0.5', family: 4 }] : pub;
	it.effect('an aborted provider fetch interrupts its scoped request before rejecting', () =>
		Effect.gen(function* () {
			const run = yield* FiberSet.makeRuntimePromise<never>();
			const started = yield* Deferred.make<void>();
			const stopped = yield* Deferred.make<void>();
			const f = public_fetch(run, {
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
				const f = public_fetch(run, {
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
				const f = public_fetch(run, {
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
				const toPrivate = public_fetch(run, {
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
		"allowLoopback (a dev host) admits this machine's own names over HTTP, never a private network",
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
					public_fetch(run, { resolve: loop, request: ok, allowLoopback: true })(
						'http://crm.localhost:5173/api'
					)
				);
				expect(yield* Port.attempt('test', () => first.text())).toBe('ok');
				const second = yield* Port.attempt('test', () =>
					public_fetch(run, { resolve: loop, request: ok, allowLoopback: true })(
						'http://127.0.0.1:8080/'
					)
				);
				expect(yield* Port.attempt('test', () => second.text())).toBe('ok');
				yield* Effect.flip(
					Port.attempt('test', () =>
						public_fetch(run, { resolve: loop, request: ok, allowLoopback: true })(
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
						public_fetch(run, { resolve, request: ok, allowLoopback: true })('http://internal.test/')
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
						public_fetch(run, { resolve: loop, request: ok })('http://crm.localhost:5173/api')
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
			const f = public_fetch(run, {
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
