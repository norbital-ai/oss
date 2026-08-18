import { assert, it } from '@effect/vitest';
import { EnvironmentName, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { Effect } from 'effect';
import { fileURLToPath } from 'node:url';
import { ApplicationStartError, startApplication } from '../src/app.js';
import { ServerConfiguration } from '../src/config.js';

const configuration = ServerConfiguration.make({
	host: '127.0.0.1',
	port: 0,
	bundlePath: fileURLToPath(new URL('./fixtures/fixture-bundle.mjs', import.meta.url)),
	scope: {
		tenantId: TenantId.make('server-test'),
		environment: EnvironmentName.make('test'),
		releaseId: ReleaseId.make('server-test')
	},
	mode: 'development',
	durableEngine: 'memory',
	drainTimeoutMillis: 1_000,
	invocationTimeoutMillis: 1_000,
	requestBodyLimitBytes: 1_024
});

it.effect('returns a typed 400 response for malformed command JSON', () =>
	Effect.acquireUseRelease(
		Effect.tryPromise({
			try: () => startApplication({ configuration, facilities: { scope: configuration.scope } }),
			catch: (cause) =>
				cause instanceof ApplicationStartError
					? cause
					: new ApplicationStartError({
							operation: 'BoltServer.Test.start',
							message: 'Server test failed to start',
							cause
						})
		}),
		(application) =>
			Effect.gen(function* () {
				const response = yield* Effect.tryPromise(() =>
					fetch(
						`http://${application.address.host}:${application.address.port}/_bolt/command/test.echo`,
						{ method: 'POST', body: '{not-json' }
					)
				);
				assert.strictEqual(response.status, 400);
				assert.deepStrictEqual(yield* Effect.tryPromise(() => response.json()), {
					_tag: 'BoltServer.CommandInputError',
					code: 'malformed_json',
					message: 'Bolt command body is not valid JSON'
				});
			}),
		(application) => Effect.promise(() => application.stop())
	)
);

it.effect('maps typed Bolt authentication and tenant failures to HTTP status', () =>
	Effect.acquireUseRelease(
		Effect.tryPromise(() =>
			startApplication({ configuration, facilities: { scope: configuration.scope } })
		),
		(application) =>
			Effect.gen(function* () {
				const base = `http://${application.address.host}:${application.address.port}`;
				const unauthenticated = yield* Effect.tryPromise(() =>
					fetch(`${base}/_bolt/command/test.unauthenticated`, {
						method: 'POST',
						body: 'null'
					})
				);
				assert.strictEqual(unauthenticated.status, 401);
				assert.deepStrictEqual(yield* Effect.tryPromise(() => unauthenticated.json()), {
					code: 'unauthorized',
					message: 'Missing command credential',
					retryable: false,
					outcome: 'known',
					httpStatus: 401
				});

				const forbidden = yield* Effect.tryPromise(() =>
					fetch(`${base}/_bolt/command/test.forbidden`, {
						method: 'POST',
						body: 'null'
					})
				);
				assert.strictEqual(forbidden.status, 403);
				assert.deepStrictEqual(yield* Effect.tryPromise(() => forbidden.json()), {
					code: 'tenant_mismatch',
					message: 'Authenticated subject is outside the invocation tenant',
					retryable: false,
					outcome: 'known',
					httpStatus: 403
				});
			}),
		(application) => Effect.promise(() => application.stop())
	)
);
