import { assert, it } from '@effect/vitest';
import {
	DatabaseRequest,
	EffectId,
	EnvironmentName,
	InvocationId,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { ConfigProvider, Effect, Schema } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApplication } from '../src/app.js';
import { ServerConfiguration } from '../src/config.js';
import { makeDatabaseFromConfig } from '../src/facilities/database.js';
import { HealthSnapshot } from '../src/health.js';

const fixturePath = fileURLToPath(new URL('./fixtures/fixture-bundle.mjs', import.meta.url));

const configuration = ServerConfiguration.make({
	host: '127.0.0.1',
	port: 0,
	bundlePath: fixturePath,
	scope: {
		tenantId: TenantId.make('pglite-host'),
		environment: EnvironmentName.make('test'),
		releaseId: ReleaseId.make('pglite-host')
	},
	mode: 'development',
	drainTimeoutMillis: 1_000,
	invocationTimeoutMillis: 1_000,
	requestBodyLimitBytes: 1024
});

const metadata = {
	invocationId: InvocationId.make('invocation-1'),
	effectId: EffectId.make('effect-1'),
	deadlineEpochMs: Number.MAX_SAFE_INTEGER,
	idempotencyKey: 'pglite-host-1'
};

const signal = new AbortController().signal;
const LOCAL_DATABASE_TEST_TIMEOUT_MILLIS = 30_000;
const withConfiguration = (values: Record<string, string>) =>
	ConfigProvider.layer(ConfigProvider.fromUnknown(values));

/**
 * The embedder a template would call: Effect Config selects PGlite, `makeLocalDatabase` registers
 * `pg_trgm` / `btree_gist` / `vector`, and `startApplication` binds that facility into a listening
 * host. The fixture bundle is the same one `self-host.test.ts` and `server.test.ts` already start —
 * `startApplication` needs a module path, not a compiled workspace, and this one does not invent a
 * second stack.
 */
it.effect(
	'listens on PGlite selected by Effect Config and the fixture host bindings',
	() =>
		Effect.acquireUseRelease(
			Effect.tryPromise(() => mkdtemp(join(tmpdir(), 'bolt-server-pglite-'))),
			(dataDirectory) =>
				Effect.acquireUseRelease(
					makeDatabaseFromConfig().pipe(
						Effect.provide(
							withConfiguration({
								BOLT_SERVER_DATABASE_PROVIDER: 'pglite',
								BOLT_SERVER_DATABASE_DATA_DIRECTORY: dataDirectory
							})
						)
					),
					(database) =>
						Effect.acquireUseRelease(
							Effect.tryPromise(() =>
								startApplication({
									configuration,
									facilities: {
										scope: configuration.scope,
										database: database.binding
									}
								})
							),
							(application) =>
								Effect.gen(function* () {
									const installed = yield* Effect.tryPromise(() =>
										database.binding.call(
											metadata,
											DatabaseRequest.cases.Transaction.make({
												statements: [
													{
														sql: 'create extension if not exists pg_trgm',
														parameters: []
													},
													{
														sql: 'create extension if not exists btree_gist',
														parameters: []
													},
													{
														sql: 'create extension if not exists vector',
														parameters: []
													},
													{
														sql: `select extname from pg_extension where extname in ('btree_gist', 'pg_trgm', 'vector') order by extname`,
														parameters: []
													}
												]
											}),
											signal
										)
									);
									assert.strictEqual(installed._tag, 'Success');
									if (installed._tag !== 'Success') return;
									assert.deepStrictEqual(installed.value.rows, [
										{ extname: 'btree_gist' },
										{ extname: 'pg_trgm' },
										{ extname: 'vector' }
									]);

									const base = `http://${application.address.host}:${application.address.port}`;
									const ready = yield* Effect.tryPromise(() => fetch(`${base}/readyz`));
									assert.strictEqual(ready.status, 200);
									const snapshot = yield* Schema.decodeUnknownEffect(HealthSnapshot)(
										yield* Effect.tryPromise(() => ready.json())
									);
									assert.strictEqual(snapshot.ready, true);
									assert.strictEqual(snapshot.accepting, true);
									assert.notStrictEqual(application.address.port, 0);

									const root = yield* Effect.tryPromise(() => fetch(`${base}/`));
									assert.deepStrictEqual(yield* Effect.tryPromise(() => root.json()), {
										method: 'GET',
										url: '/',
										authorization: null,
										body: null,
										tenantId: 'pglite-host'
									});
								}),
							(application) => Effect.promise(() => application.stop())
						),
					(database) => Effect.promise(database.close)
				),
			(dataDirectory) => Effect.promise(() => rm(dataDirectory, { recursive: true, force: true }))
		),
	LOCAL_DATABASE_TEST_TIMEOUT_MILLIS
);
