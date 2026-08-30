import { assert, it } from '@effect/vitest';
import { EnvironmentName, InvocationScope, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { ConfigProvider, Effect, Redacted } from 'effect';
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
			scope: InvocationScope.make({
				tenantId: TenantId.make('local'),
				environment: EnvironmentName.make('development'),
				releaseId: ReleaseId.make('local')
			}),
			mode: 'development',
			drainTimeoutMillis: 10_000,
			invocationTimeoutMillis: 30_000,
			requestBodyLimitBytes: 1_048_576
		});
	}).pipe(Effect.provide(withConfiguration({ BOLT_SERVER_BUNDLE: '/tmp/example-bolt.mjs' })))
);

/**
 * The gateway secret is absent above and present here, and both are ordinary states.
 *
 * A host that configures none still starts and serves; what it cannot do is prove itself to its own
 * bundle, so its scheduled work refuses with a message naming the variable. The key is the same one
 * the bundle reads on the other side of that call, deliberately: a host key and a guest key that
 * could be configured apart would fail as a signature mismatch rather than as a missing value.
 */
it.effect('reads the gateway secret the scheduler signs with', () =>
	Effect.gen(function* () {
		const configuration = yield* loadConfiguration();
		const secret = configuration.gatewaySecret;
		assert.isDefined(secret);
		assert.strictEqual(secret === undefined ? undefined : Redacted.value(secret), 'gateway-secret');
	}).pipe(
		Effect.provide(
			withConfiguration({
				BOLT_SERVER_BUNDLE: '/tmp/example-bolt.mjs',
				COLONY_GATEWAY_SECRET: 'gateway-secret'
			})
		)
	)
);

// The case that asserted production refuses a non-durable engine is deleted with the option it
// checked. `BOLT_SERVER_DURABLE_ENGINE` selected between an in-memory command recorder and an
// external adapter that was never written, and neither ever ran anything: a bolt-server's durable
// state is the tenant's own `bolt_task` table, which is not a thing this host configures.
