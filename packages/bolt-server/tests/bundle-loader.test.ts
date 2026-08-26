import { assert, it } from '@effect/vitest';
import { EnvironmentName, PROTOCOL_VERSION, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { Effect } from 'effect';
import { fileURLToPath } from 'node:url';
import { BundleLoadError, BundleLoader, makeLayer } from '../src/bundle-loader.js';

/**
 * A bundle path inside the fixtures directory, because the loader now resolves blobs beside it.
 *
 * The module itself is never imported — `importModule` is stubbed — but `assets/<sha256>` is read
 * from disk for real, which is the whole point: the manifest states a digest and the loader has to
 * find bytes that hash to it before anything is allowed to serve them.
 */
const fixtureBundlePath = fileURLToPath(new URL('./fixtures/bundle.mjs', import.meta.url));

const facilities = {
	scope: {
		tenantId: TenantId.make('tenant'),
		environment: EnvironmentName.make('test'),
		releaseId: ReleaseId.make('release')
	}
};

/** `assets/4290f0…` in the fixtures directory holds exactly these twelve bytes. */
const boltFixtureAsset = {
	path: 'index.html',
	contentType: 'text/plain',
	sha256: '4290f01183a1ad0c3b7ba37eb33d0a307d414b04c98acf67307d881192bb118d',
	byteLength: 12
};

const validModule = {
	protocolVersion: PROTOCOL_VERSION,
	manifest: {
		protocolVersion: PROTOCOL_VERSION,
		artifactId: 'loader-fixture',
		artifactVersion: 'one',
		schemaFingerprint: 'schema-one',
		schemaPlan: { fingerprint: 'schema-one', steps: [] },
		requiredFacilities: [],
		browserAssets: [boltFixtureAsset],
		serverAssets: [],
		integrations: []
	},
	dispatch: async () => ({ _tag: 'Success', response: { status: 204, headers: {} } }),
	activate: async () => ({ _tag: 'Activated', registrations: [], nextDueAtEpochMs: null })
};

/** Loads one stubbed module through the real layer and returns whatever the load produced. */
const loadFailure = (manifest: Readonly<Record<string, unknown>>) =>
	Effect.gen(function* () {
		const loader = yield* BundleLoader;
		return yield* Effect.flip(loader.load());
	}).pipe(
		Effect.provide(
			makeLayer({
				bundlePath: fixtureBundlePath,
				facilities,
				importModule: async () => ({ ...validModule, manifest })
			})
		)
	);

it.effect('loads one immutable bundle and refuses access after disposal', () =>
	Effect.gen(function* () {
		let imports = 0;
		const loaderLayer = makeLayer({
			bundlePath: fixtureBundlePath,
			facilities,
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

it.effect('rejects an index whose digest disagrees with the blob on disk', () =>
	Effect.gen(function* () {
		const error = yield* loadFailure({
			...validModule.manifest,
			browserAssets: [{ ...boltFixtureAsset, sha256: 'f'.repeat(64) }]
		});
		assert.strictEqual(error.operation, 'BoltServer.BundleLoader.verifyAssets');
		// A digest naming no file at all is the same class of defect as one naming the wrong bytes:
		// the artifact claims to ship something this directory does not contain.
		assert.include(error.message, 'blob is missing');
	})
);

it.effect('rejects an index whose byte length disagrees with the blob on disk', () =>
	Effect.gen(function* () {
		const error = yield* loadFailure({
			...validModule.manifest,
			browserAssets: [{ ...boltFixtureAsset, byteLength: 11 }]
		});
		assert.strictEqual(error.operation, 'BoltServer.BundleLoader.verifyAssets');
		assert.include(error.message, 'length disagrees');
	})
);

it.effect('rejects two index entries answering to the same path', () =>
	Effect.gen(function* () {
		const error = yield* loadFailure({
			...validModule.manifest,
			browserAssets: [boltFixtureAsset, boltFixtureAsset]
		});
		assert.strictEqual(error.operation, 'BoltServer.BundleLoader.verifyAssets');
		assert.include(error.message, 'duplicate browser asset path');
	})
);

/**
 * The server half is verified too, even though no HTTP route can reach it.
 *
 * The guest asks for these by declared key during an invocation. A missing blob discovered there
 * surfaces inside an isolate, mid-request, as a failure with nothing pointing at the release.
 */
it.effect('verifies server assets it will never serve', () =>
	Effect.gen(function* () {
		const error = yield* loadFailure({
			...validModule.manifest,
			serverAssets: [
				{ ...boltFixtureAsset, path: 'node_modules/gone/gone.wasm', sha256: 'a'.repeat(64) }
			]
		});
		assert.strictEqual(error.operation, 'BoltServer.BundleLoader.verifyAssets');
		assert.include(error.message, 'server asset blob is missing');
	})
);
