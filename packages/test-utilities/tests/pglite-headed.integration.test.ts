import assert from 'node:assert/strict';
import test from 'node:test';
import { EnvironmentName, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import {
	guestUrlForChromium,
	launchChromium,
	MissingChromiumError,
	type HeadedBrowser
} from '@norbital-ai/test-utilities';
import { startApplication, ServerConfiguration, makeDatabaseFromConfig } from '@norbital-ai/bolt-server';
import type { DatabaseProvider } from '@norbital-ai/bolt-server';
import { ConfigProvider, Effect } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Probe: the same Config-selected PGlite a local embedder uses, plus Playwright Chromium as the
 * *test* browser driver. Not Colony, not `Browser.layerObscura`.
 *
 * Obscura's RSS ceiling was an Obscura-specific budget; Chrome-for-Testing holds hundreds of MiB
 * and the transport/lock rows are chased by the headed template suites. This probe only proves
 * the self-host serves a document to a real headed Chromium.
 */
const fixturePath = fileURLToPath(
	new URL('../../bolt-server/tests/fixtures/fixture-bundle.mjs', import.meta.url)
);
const LOCAL_DATABASE_TEST_TIMEOUT_MILLIS = 90_000;

const configuration = ServerConfiguration.make({
	host: '0.0.0.0',
	port: 0,
	bundlePath: fixturePath,
	scope: {
		tenantId: TenantId.make('pglite-headed'),
		environment: EnvironmentName.make('test'),
		releaseId: ReleaseId.make('pglite-headed')
	},
	mode: 'development',
	drainTimeoutMillis: 1_000,
	invocationTimeoutMillis: 1_000,
	requestBodyLimitBytes: 1024
});

const withPgliteEnvironment = (dataDirectory: string) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			BOLT_SERVER_DATABASE_PROVIDER: 'pglite',
			BOLT_SERVER_DATABASE_DATA_DIRECTORY: dataDirectory
		})
	);

test(
	'PGlite local listen is driven by Playwright Chromium',
	{ timeout: LOCAL_DATABASE_TEST_TIMEOUT_MILLIS },
	async () => {
		let browser: HeadedBrowser | undefined;
		try {
			try {
				browser = await launchChromium();
			} catch (error: unknown) {
				if (error instanceof MissingChromiumError) {
					console.warn(`missing_chromium: ${error.message}`);
					return;
				}
				throw error;
			}
			const dataDirectory = await mkdtemp(join(tmpdir(), 'bolt-server-pglite-headed-'));
			let application: Awaited<ReturnType<typeof startApplication>> | undefined;
			let database: DatabaseProvider | undefined;
			try {
				database = await Effect.runPromise(
					makeDatabaseFromConfig().pipe(Effect.provide(withPgliteEnvironment(dataDirectory)))
				);
				application = await startApplication({
					configuration,
					facilities: {
						scope: configuration.scope,
						database: database.binding
					}
				});
				const base = `http://127.0.0.1:${application.address.port}`;
				const ready = await fetch(`${base}/readyz`);
				assert.strictEqual(ready.status, 200);

				assert.strictEqual(browser.source, 'playwright');

				const pageUrl = guestUrlForChromium(
					application.address.host,
					application.address.port,
					'/index.html'
				);
				const page = await browser.openPage(pageUrl);
				const body = await page.evaluate(
					'document.body ? document.body.innerText : document.documentElement.textContent'
				);
				assert.strictEqual(String(body).trim(), 'bolt fixture');
			} finally {
				if (application !== undefined) await application.stop();
				if (database !== undefined) await database.close();
				await rm(dataDirectory, { recursive: true, force: true });
			}
		} finally {
			if (browser !== undefined) await browser.close();
		}
	}
);
