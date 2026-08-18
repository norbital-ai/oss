import { assert, it } from '@effect/vitest';
import { EnvironmentName, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { Effect, Ref } from 'effect';
import { fileURLToPath } from 'node:url';
import { ApplicationStartError, startApplication } from '../src/app.js';
import { ServerConfiguration } from '../src/config.js';
import { DurableEngine, makeLayer } from '../src/durable-engine.js';

it.effect('recovers and closes its adapter exactly once', () =>
	Effect.gen(function* () {
		const recoveries = yield* Ref.make(0);
		const closes = yield* Ref.make(0);
		const testLayer = makeLayer({
			durable: true,
			recover: Ref.updateAndGet(recoveries, (count) => count + 1).pipe(Effect.as(7)),
			close: Ref.update(closes, (count) => count + 1)
		});

		yield* Effect.gen(function* () {
			const engine = yield* DurableEngine;
			assert.strictEqual(yield* engine.recover(), 7);
			assert.strictEqual(yield* engine.recover(), 7);
			yield* engine.stop();
			yield* engine.stop();

			assert.deepStrictEqual(yield* engine.snapshot(), {
				durable: true,
				recovered: true,
				recoveredWorkItems: 7,
				stopped: true
			});
		}).pipe(Effect.provide(testLayer));

		assert.strictEqual(yield* Ref.get(recoveries), 1);
		assert.strictEqual(yield* Ref.get(closes), 1);
	})
);

it.effect('rejects an adapter that lies about the configured durability', () =>
	Effect.gen(function* () {
		const configuration = ServerConfiguration.make({
			host: '127.0.0.1',
			port: 0,
			bundlePath: fileURLToPath(new URL('./fixtures/fixture-bundle.mjs', import.meta.url)),
			scope: {
				tenantId: TenantId.make('durability-test'),
				environment: EnvironmentName.make('test'),
				releaseId: ReleaseId.make('durability-test')
			},
			mode: 'development',
			durableEngine: 'external',
			drainTimeoutMillis: 1_000,
			invocationTimeoutMillis: 1_000,
			requestBodyLimitBytes: 1_024
		});
		const error = yield* Effect.tryPromise({
			try: () =>
				startApplication({
					configuration,
					facilities: { scope: configuration.scope },
					durableEngineLayer: makeLayer({
						durable: false,
						recover: Effect.succeed(0),
						close: Effect.void
					})
				}),
			catch: (cause) =>
				cause instanceof ApplicationStartError
					? cause
					: new ApplicationStartError({
							operation: 'BoltServer.Test.durability',
							message: 'Unexpected durability test failure',
							cause
						})
		}).pipe(Effect.flip);
		assert.strictEqual(error.operation, 'BoltServer.Application.validateDurability');
	})
);
