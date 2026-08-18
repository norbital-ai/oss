import { assert, it } from '@effect/vitest';
import { EnvironmentName, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { Effect } from 'effect';
import { BundleLoadError, BundleLoader, makeLayer } from '../src/bundle-loader.js';

const validModule = {
	protocolVersion: 1,
	manifest: {
		protocolVersion: 1,
		artifactId: 'loader-fixture',
		artifactVersion: 'one',
		schemaFingerprint: 'schema-one',
		requiredFacilities: [],
		staticAssets: [
			{
				path: 'index.html',
				contentType: 'text/plain',
				sha256: '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
				bytes: new TextEncoder().encode('x')
			}
		],
		integrations: []
	},
	dispatch: async () => ({ _tag: 'Success', response: { status: 204, headers: {} } }),
	activate: async () => ({ _tag: 'Activated', registrations: [] })
};

it.effect('loads one immutable bundle and refuses access after disposal', () =>
	Effect.gen(function* () {
		let imports = 0;
		const loaderLayer = makeLayer({
			bundlePath: '/virtual/fixture.mjs',
			facilities: {
				scope: {
					tenantId: TenantId.make('tenant'),
					environment: EnvironmentName.make('test'),
					releaseId: ReleaseId.make('release')
				}
			},
			importModule: async () => {
				imports += 1;
				return validModule;
			}
		});

		yield* Effect.gen(function* () {
			const loader = yield* BundleLoader;
			assert.strictEqual((yield* loader.load()).manifest.artifactId, 'loader-fixture');
			assert.strictEqual((yield* loader.load()).manifest.artifactId, 'loader-fixture');
			assert.strictEqual(imports, 1);
			yield* loader.dispose();
			assert.instanceOf(yield* Effect.flip(loader.load()), BundleLoadError);
		}).pipe(Effect.provide(loaderLayer));
	})
);

it.effect('rejects corrupt static asset bytes before serving', () =>
	Effect.gen(function* () {
		const loaderLayer = makeLayer({
			bundlePath: '/virtual/corrupt.mjs',
			facilities: {
				scope: {
					tenantId: TenantId.make('tenant'),
					environment: EnvironmentName.make('test'),
					releaseId: ReleaseId.make('release')
				}
			},
			importModule: async () => ({
				...validModule,
				manifest: {
					...validModule.manifest,
					staticAssets: [
						{ ...validModule.manifest.staticAssets[0], sha256: 'not-the-real-checksum' }
					]
				}
			})
		});

		const error = yield* Effect.gen(function* () {
			const loader = yield* BundleLoader;
			return yield* Effect.flip(loader.load());
		}).pipe(Effect.provide(loaderLayer));
		assert.strictEqual(error.operation, 'BoltServer.BundleLoader.verifyAssets');
	})
);
