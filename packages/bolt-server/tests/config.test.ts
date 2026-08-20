import { assert, it } from '@effect/vitest';
import { ConfigProvider, Effect } from 'effect';
import { loadConfiguration } from '../src/config.js';

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
			drainTimeoutMillis: 10_000,
			invocationTimeoutMillis: 30_000,
			requestBodyLimitBytes: 1_048_576
		});
	}).pipe(Effect.provide(withConfiguration({ BOLT_SERVER_BUNDLE: '/tmp/example-bolt.mjs' })))
);

// The case that asserted production refuses a non-durable engine is deleted with the option it
// checked. `BOLT_SERVER_DURABLE_ENGINE` selected between an in-memory command recorder and an
// external adapter that was never written, and neither ever ran anything: a bolt-server's durable
// state is the tenant's own `bolt_task` table, which is not a thing this host configures.
