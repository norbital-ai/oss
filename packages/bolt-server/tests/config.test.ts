import { assert, it } from '@effect/vitest';
import { ConfigProvider, Effect } from 'effect';
import { ConfigurationError, loadConfiguration } from '../src/config.js';

const withConfiguration = (values: Record<string, string>) =>
	ConfigProvider.layer(ConfigProvider.fromUnknown(values));

it.effect('loads deterministic development defaults', () =>
	Effect.gen(function* () {
		const configuration = yield* loadConfiguration();
		assert.deepStrictEqual(configuration, {
			host: '127.0.0.1',
			port: 3100,
			bundlePath: '/tmp/example-bolt.mjs',
			scope: {
				tenantId: 'local',
				environment: 'development',
				releaseId: 'local'
			},
			mode: 'development',
			durableEngine: 'memory',
			drainTimeoutMillis: 10_000,
			invocationTimeoutMillis: 30_000,
			requestBodyLimitBytes: 1_048_576
		});
	}).pipe(Effect.provide(withConfiguration({ BOLT_SERVER_BUNDLE: '/tmp/example-bolt.mjs' })))
);

it.effect('rejects a non-durable production engine', () =>
	Effect.gen(function* () {
		const error = yield* Effect.flip(loadConfiguration());
		assert.instanceOf(error, ConfigurationError);
		assert.strictEqual(error.operation, 'BoltServer.Configuration.validateDurability');
	}).pipe(
		Effect.provide(
			withConfiguration({
				BOLT_SERVER_BUNDLE: '/tmp/example-bolt.mjs',
				BOLT_SERVER_MODE: 'production',
				BOLT_SERVER_DURABLE_ENGINE: 'memory'
			})
		)
	)
);
