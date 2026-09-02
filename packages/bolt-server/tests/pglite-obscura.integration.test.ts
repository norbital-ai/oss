import { assert, it } from '@effect/vitest';
import { EnvironmentName, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { ConfigProvider, Effect } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApplication } from '../src/app.js';
import { ServerConfiguration } from '../src/config.js';
import { makeDatabaseFromConfig } from '../src/facilities/database.js';
import { isObscuraSkip, OBSCURA_IMAGE, openObscuraDriver } from './helpers/obscura-driver.js';

/**
 * Probe: the same Config-selected PGlite a local embedder uses, plus Obscura as the *test*
 * browser driver (CDP). Not Colony, not Playwright Chrome, not `Browser.layerObscura`.
 *
 * Chrome-for-Testing / headed Playwright typically holds hundreds of MiB. Obscura's compose
 * cap is 2 GiB; this process stays in the tens of MiB after a navigation.
 */
const fixturePath = fileURLToPath(new URL('./fixtures/fixture-bundle.mjs', import.meta.url));
const LOCAL_DATABASE_TEST_TIMEOUT_MILLIS = 90_000;
const OBSCURA_RSS_CEILING_BYTES = 64 * 1024 * 1024;

const configuration = ServerConfiguration.make({
	host: '127.0.0.1',
	port: 0,
	bundlePath: fixturePath,
	scope: {
		tenantId: TenantId.make('pglite-obscura'),
		environment: EnvironmentName.make('test'),
		releaseId: ReleaseId.make('pglite-obscura')
	},
	mode: 'development',
	drainTimeoutMillis: 1_000,
	invocationTimeoutMillis: 1_000,
	requestBodyLimitBytes: 1024
});

const withConfiguration = (values: Record<string, string>) =>
	ConfigProvider.layer(ConfigProvider.fromUnknown(values));

const guestUrlForObscura = (host: string, port: number, path: string): string => {
	const bound = host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0';
	return `http://${bound ? 'host.docker.internal' : host}:${port}${path}`;
};

it.effect(
	'PGlite local listen is driven by Obscura CDP, not Chrome',
	() =>
		Effect.gen(function* () {
			const driver = yield* Effect.tryPromise(() => openObscuraDriver());
			if (isObscuraSkip(driver)) {
				console.warn(`missing_obscura: ${driver.reason}`);
				return;
			}

			yield* Effect.acquireUseRelease(
				Effect.tryPromise(() => mkdtemp(join(tmpdir(), 'bolt-server-pglite-obscura-'))),
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
										const base = `http://${application.address.host}:${application.address.port}`;
										const ready = yield* Effect.tryPromise(() => fetch(`${base}/readyz`));
										assert.strictEqual(ready.status, 200);

										const version = yield* Effect.tryPromise(() => driver.version());
										assert.strictEqual(version.protocolVersion, '1.3');
										assert.ok(version.product.length > 0);
										assert.notMatch(driver.endpoint, /chrome|playwright/i);
										if (driver.startedContainer)
											assert.strictEqual(driver.image, OBSCURA_IMAGE);

										const pageUrl = guestUrlForObscura(
											application.address.host,
											application.address.port,
											'/index.html'
										);
										const body = yield* Effect.tryPromise(() => driver.readText(pageUrl));
										assert.strictEqual(body.trim(), 'bolt fixture');

										const rss = yield* Effect.tryPromise(() => driver.rssBytes());
										if (rss !== undefined) {
											assert.ok(
												rss < OBSCURA_RSS_CEILING_BYTES,
												`Obscura RSS ${rss} exceeded ${OBSCURA_RSS_CEILING_BYTES}`
											);
										}
									}),
								(application) => Effect.promise(() => application.stop())
							),
						(database) => Effect.promise(database.close)
					),
				(dataDirectory) => Effect.promise(() => rm(dataDirectory, { recursive: true, force: true }))
			).pipe(Effect.ensuring(Effect.promise(() => driver.stop())));
		}),
	LOCAL_DATABASE_TEST_TIMEOUT_MILLIS
);
