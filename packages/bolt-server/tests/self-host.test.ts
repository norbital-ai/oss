import { assert, it } from '@effect/vitest';
import { EnvironmentName, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { Effect, Schedule, Schema } from 'effect';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';
import { ServerConfiguration } from '../src/config.js';
import { ApplicationStartError, startApplication } from '../src/app.js';
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
	durableEngine: 'memory',
	drainTimeoutMillis: 1_000,
	invocationTimeoutMillis: 1_000,
	requestBodyLimitBytes: 1024
});

const facilities = { scope: configuration.scope };

it.effect('requires an explicitly durable engine in production', () =>
	Effect.gen(function* () {
		let finalizations = 0;
		const production = ServerConfiguration.make({
			...configuration,
			mode: 'production',
			durableEngine: 'external'
		});
		const error = yield* Effect.tryPromise({
			try: () =>
				startApplication({
					configuration: production,
					facilities,
					finalizeFacilities: async () => {
						finalizations += 1;
					}
				}),
			catch: (cause) =>
				cause instanceof ApplicationStartError
					? cause
					: new ApplicationStartError({
							operation: 'BoltServer.Test.productionDurability',
							message: 'Unexpected production start failure',
							cause
						})
		}).pipe(Effect.flip);
		assert.instanceOf(error, ApplicationStartError);
		assert.strictEqual(error.operation, 'BoltServer.Application.validateDurability');
		assert.strictEqual(finalizations, 1);
	})
);

it.effect('runs one exact artifact through static, health and request paths', () =>
	Effect.acquireUseRelease(
		Effect.tryPromise(() => startApplication({ configuration, facilities })),
		(application) =>
			Effect.gen(function* () {
				const base = `http://${application.address.host}:${application.address.port}`;
				const ready = yield* Effect.tryPromise(() => fetch(`${base}/readyz`));
				assert.strictEqual(ready.status, 200);

				const asset = yield* Effect.tryPromise(() => fetch(`${base}/`));
				assert.strictEqual(yield* Effect.tryPromise(() => asset.text()), 'bolt fixture');

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

it.effect('bridges bounded realtime pull and cancellation through SSE', () =>
	Effect.acquireUseRelease(
		Effect.tryPromise(() => startApplication({ configuration, facilities })),
		(application) =>
			Effect.gen(function* () {
				const base = `http://${application.address.host}:${application.address.port}`;
				const open = yield* Effect.tryPromise(() => fetch(`${base}/__bolt/realtime/sse`));
				assert.strictEqual(open.headers.get('content-type'), 'text/event-stream; charset=utf-8');
				const connectionId = open.headers.get('x-bolt-connection-id');
				assert.notStrictEqual(connectionId, null);
				const decodeFrame = (source: string) => {
					const data = source
						.split('\n')
						.find((line) => line.startsWith('data: '))
						?.slice('data: '.length);
					if (data === undefined) throw new Error('SSE response has no data frame');
					return Schema.decodeUnknownSync(
						Schema.Struct({ cursor: Schema.String, kind: Schema.String, bytes: Schema.String })
					)(JSON.parse(data));
				};
				const opened = decodeFrame(yield* Effect.tryPromise(() => open.text()));
				assert.strictEqual(Buffer.from(opened.bytes, 'base64').toString(), 'open');

				const pull = yield* Effect.tryPromise(() =>
					fetch(
						`${base}/__bolt/realtime/sse?connectionId=${encodeURIComponent(connectionId ?? '')}&afterCursor=${encodeURIComponent(opened.cursor)}`
					)
				);
				const pulled = decodeFrame(yield* Effect.tryPromise(() => pull.text()));
				assert.strictEqual(Buffer.from(pulled.bytes, 'base64').toString(), 'pulled');

				const cancel = yield* Effect.tryPromise(() =>
					fetch(
						`${base}/__bolt/realtime/sse?connectionId=${encodeURIComponent(connectionId ?? '')}`,
						{ method: 'DELETE' }
					)
				);
				const cancelled = decodeFrame(yield* Effect.tryPromise(() => cancel.text()));
				assert.strictEqual(Buffer.from(cancelled.bytes, 'base64').toString(), 'cancelled');
			}),
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
