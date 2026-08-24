import { assert, it } from '@effect/vitest';
import { EnvironmentName, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { Effect, Schedule, Schema } from 'effect';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';
import { ServerConfiguration } from '../src/config.js';
import { startApplication } from '../src/app.js';
import { HealthSnapshot } from '../src/health.js';

const fixturePath = fileURLToPath(new URL('./fixtures/fixture-bundle.mjs', import.meta.url));

const configuration = ServerConfiguration.make({
	host: '127.0.0.1',
	port: 0,
	bundlePath: fixturePath,
	scope: {
		tenantId: TenantId.make('test-tenant'),
		environment: EnvironmentName.make('test'),
		releaseId: ReleaseId.make('test-release')
	},
	mode: 'development',
	drainTimeoutMillis: 1_000,
	invocationTimeoutMillis: 1_000,
	requestBodyLimitBytes: 1024
});

const facilities = { scope: configuration.scope };

// The case that required an explicitly durable engine in production is deleted with the option it
// checked. There is no host-side engine to configure: `bolt-server` owns a timer, and everything
// durable lives in the tenant's own `bolt_task` table, written by the guest in the same transaction
// as the state change that asked for it.
it.effect('runs one exact artifact through static, health and request paths', () =>
	Effect.acquireUseRelease(
		Effect.tryPromise(() => startApplication({ configuration, facilities })),
		(application) =>
			Effect.gen(function* () {
				const base = `http://${application.address.host}:${application.address.port}`;
				const ready = yield* Effect.tryPromise(() => fetch(`${base}/readyz`));
				assert.strictEqual(ready.status, 200);

				/**
				 * A static asset answers at the path it was built under, and `/` is not one of them.
				 *
				 * This asserted `/` served the asset, which is the premise `server.ts` abandoned when it
				 * stopped rewriting `/` to `/index.html`. The page that rewrite existed for stamped its own
				 * tenant, environment and credential onto itself and let the client read them back; a host
				 * states those, so the page is gone and the rewrite with it.
				 */
				const asset = yield* Effect.tryPromise(() => fetch(`${base}/index.html`));
				assert.strictEqual(yield* Effect.tryPromise(() => asset.text()), 'bolt fixture');
				/**
				 * And the half that was never asserted: `/` falls through to the artifact's own request
				 * dispatch, which is where an authored root route lives.
				 *
				 * This is the behaviour the comment in `server.ts` argues for, and nothing proved it — so
				 * restoring the rewrite would have turned this suite green again while undoing the change.
				 * The echoed body is proof the request reached the bundle rather than the asset table: an
				 * asset response would carry the fixture's HTML and no `tenantId`.
				 */
				const root = yield* Effect.tryPromise(() => fetch(`${base}/`));
				assert.deepStrictEqual(yield* Effect.tryPromise(() => root.json()), {
					method: 'GET',
					url: '/',
					authorization: null,
					body: null,
					tenantId: 'test-tenant'
				});

				const response = yield* Effect.tryPromise(() =>
					fetch(`${base}/api/echo`, {
						method: 'POST',
						headers: { authorization: 'Bearer exact-credential' },
						body: 'hello'
					})
				);
				assert.deepStrictEqual(yield* Effect.tryPromise(() => response.json()), {
					method: 'POST',
					url: '/api/echo',
					authorization: 'Bearer exact-credential',
					body: 'hello',
					tenantId: 'test-tenant'
				});
				const command = yield* Effect.tryPromise(() =>
					fetch(`${base}/_bolt/command/test.echo`, {
						method: 'POST',
						headers: {
							authorization: 'Bearer exact-command-credential',
							'content-type': 'application/json'
						},
						body: JSON.stringify({ proof: true })
					})
				);
				assert.deepStrictEqual(yield* Effect.tryPromise(() => command.json()), {
					command: 'test.echo',
					input: { proof: true },
					authorization: 'Bearer exact-command-credential'
				});
			}),
		(application) => Effect.promise(() => application.stop())
	)
);

it.effect('bridges bounded realtime events through WebSocket', () =>
	Effect.acquireUseRelease(
		Effect.tryPromise(() => startApplication({ configuration, facilities })),
		(application) =>
			Effect.tryPromise(
				() =>
					new Promise<void>((resolve, reject) => {
						const socket = new WebSocket(
							`ws://${application.address.host}:${application.address.port}/__bolt/realtime`
						);
						const messages: Array<string> = [];
						socket.once('error', reject);
						socket.once('close', (code, reason) => {
							if (messages.length < 2) {
								reject(new Error(`socket closed early (${code}): ${reason.toString()}`));
							}
						});
						socket.on('message', (data) => {
							messages.push(data.toString());
							if (messages.length === 2) socket.send('hello realtime');
							if (messages.length === 3) {
								try {
									assert.deepStrictEqual(messages, ['open', 'pulled', 'hello realtime']);
									socket.close();
									resolve();
								} catch (cause) {
									reject(cause);
								}
							}
						});
					})
			),
		(application) => Effect.promise(() => application.stop())
	)
);

it.effect('dispatches realtime cancellation before transport shutdown', () =>
	Effect.acquireUseRelease(
		Effect.tryPromise(() => startApplication({ configuration, facilities })),
		(application) =>
			Effect.tryPromise(
				() =>
					new Promise<void>((resolve, reject) => {
						const socket = new WebSocket(
							`ws://${application.address.host}:${application.address.port}/__bolt/realtime`
						);
						const messages: Array<string> = [];
						let stopping = false;
						socket.once('error', reject);
						socket.on('message', (data) => {
							messages.push(data.toString());
							if (messages.length === 2 && !stopping) {
								stopping = true;
								void application.stop().catch(reject);
							}
							if (messages.at(-1) === 'cancelled') {
								try {
									assert.deepStrictEqual(messages, ['open', 'pulled', 'cancelled']);
									resolve();
								} catch (cause) {
									reject(cause);
								}
							}
						});
					})
			),
		(application) => Effect.promise(() => application.stop())
	)
);

it.effect('interrupts exact bundle dispatch when the HTTP client disconnects', () =>
	Effect.acquireUseRelease(
		Effect.tryPromise(() => startApplication({ configuration, facilities })),
		(application) =>
			Effect.gen(function* () {
				const base = `http://${application.address.host}:${application.address.port}`;
				const pending = yield* Effect.sync(() => {
					const request = httpRequest(`${base}/api/cancel`);
					request.on('error', () => undefined);
					request.end();
					return request;
				});

				const awaitInFlight = (expected: number) =>
					Effect.gen(function* () {
						const response = yield* Effect.tryPromise(() => fetch(`${base}/healthz`));
						const snapshot = yield* Schema.decodeUnknownEffect(HealthSnapshot)(
							yield* Effect.tryPromise(() => response.json())
						);
						if (snapshot.inFlight !== expected) return yield* Effect.fail(snapshot.inFlight);
					}).pipe(Effect.retry(Schedule.recurs(100)));

				yield* awaitInFlight(1);
				yield* Effect.sync(() => pending.destroy());
				yield* awaitInFlight(0);
			}),
		(application) => Effect.promise(() => application.stop())
	)
);
