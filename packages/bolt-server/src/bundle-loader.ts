import {
	ARTIFACT_ASSET_DIRECTORY,
	type AssetIndexEntry,
	type BoltBundle,
	type FacilityBindings,
	PROTOCOL_VERSION,
	decodeBoltBundleModule,
	missingFacilities
} from '@norbital-ai/bolt-protocol';
import { Context, Effect, Layer, Ref, Schema } from 'effect';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Identifies the immutable artifact validation phase that rejected a bundle. */
export class BundleLoadError extends Schema.TaggedError<BundleLoadError>()(
	'BoltServer.BundleLoadError',
	{
		operation: Schema.String,
		bundlePath: Schema.String,
		message: Schema.NonEmptyString,
		cause: Schema.optionalKey(Schema.Defect()),
		missingFacilities: Schema.optionalKey(Schema.Array(Schema.String))
	}
) {}

/** The service shape: one cached, checksum-verified bundle for the application lifetime. */
interface Interface {
	readonly load: () => Effect.Effect<BoltBundle, BundleLoadError>;
	readonly dispose: () => Effect.Effect<void>;
}

/** Owns one cached, checksum-verified Bolt bundle for the application lifetime. */
export class BundleLoader extends Context.Service<BundleLoader, Interface>()(
	'@norbital-ai/bolt-server/BundleLoader'
) {}

/** Layer construction options; `importModule` is the host's own module-loading edge. */
export interface LayerOptions {
	readonly bundlePath: string;
	readonly facilities: FacilityBindings;
	// repository-health:allow EFF2 -- ECMAScript dynamic import is a Promise-only host module-loading boundary.
	readonly importModule?: (url: string) => Promise<unknown>;
}

/** Builds the bundle-loader Layer without importing Bolt semantic internals. */
export const makeLayer = ({
	bundlePath,
	facilities,
	importModule = (url) => import(url)
}: LayerOptions) =>
	Layer.effect(
		BundleLoader,
		Effect.gen(function* () {
			const disposed = yield* Ref.make(false);
			const absolutePath = resolve(bundlePath);
			const moduleUrl = pathToFileURL(absolutePath).href;

			const uncachedLoad = Effect.fn('BoltServer.BundleLoader.loadUncached')(function* () {
				if (yield* Ref.get(disposed)) {
					return yield* new BundleLoadError({
						operation: 'BoltServer.BundleLoader.load',
						bundlePath: absolutePath,
						message: 'Bolt bundle loader is disposed'
					});
				}

				const imported = yield* Effect.tryPromise({
					try: () => importModule(moduleUrl),
					catch: (cause) =>
						new BundleLoadError({
							operation: 'BoltServer.BundleLoader.import',
							bundlePath: absolutePath,
							message: 'Unable to import Bolt bundle',
							cause
						})
				});

				const bundle = yield* decodeBoltBundleModule(imported).pipe(
					Effect.mapError(
						(cause) =>
							new BundleLoadError({
								operation: 'BoltServer.BundleLoader.verify',
								bundlePath: absolutePath,
								message: cause.message,
								cause
							})
					)
				);

				if (
					bundle.protocolVersion !== PROTOCOL_VERSION ||
					bundle.manifest.protocolVersion !== PROTOCOL_VERSION
				) {
					return yield* new BundleLoadError({
						operation: 'BoltServer.BundleLoader.verifyProtocol',
						bundlePath: absolutePath,
						message: 'Bolt bundle protocol version is unsupported'
					});
				}

				const missing = missingFacilities(bundle.manifest, facilities);
				if (missing.length > 0) {
					return yield* new BundleLoadError({
						operation: 'BoltServer.BundleLoader.verifyFacilities',
						bundlePath: absolutePath,
						message: 'Bolt bundle requires unavailable facilities',
						missingFacilities: [...missing]
					});
				}

				/**
				 * Every indexed asset is verified against the blob it names, once, before anything serves.
				 *
				 * The bytes used to ride inside the manifest, so this loop hashed what it had already been
				 * handed. They now sit in `assets/<sha256>` beside the bundle, which means the checksum has
				 * work to do that it did not have before: it is what closes the gap between "the artifact
				 * says it ships this file" and "this directory happens to contain a file by that name".
				 *
				 * Both halves are checked. A `serverAssets` entry is never served over HTTP, but the guest
				 * will ask for it by key at some point during an invocation, and a missing or corrupt blob
				 * discovered there surfaces inside an isolate, mid-request, as an unexplained failure.
				 */
				const assetDirectory = join(dirname(absolutePath), ARTIFACT_ASSET_DIRECTORY);
				const verify = Effect.fn('BoltServer.BundleLoader.verifyAssetSet')(function* (
					half: string,
					assets: ReadonlyArray<AssetIndexEntry>
				) {
					const seen = new Set<string>();
					for (const asset of assets) {
						if (seen.has(asset.path)) {
							return yield* new BundleLoadError({
								operation: 'BoltServer.BundleLoader.verifyAssets',
								bundlePath: absolutePath,
								message: `Bolt bundle contains duplicate ${half} asset path: ${asset.path}`
							});
						}
						seen.add(asset.path);
						const blob = join(assetDirectory, asset.sha256);
						const bytes = yield* Effect.tryPromise({
							try: () => readFile(blob),
							catch: (cause) =>
								new BundleLoadError({
									operation: 'BoltServer.BundleLoader.verifyAssets',
									bundlePath: absolutePath,
									message: `Bolt bundle ${half} asset blob is missing: ${asset.path} (${asset.sha256})`,
									cause
								})
						});
						const actualSha256 = createHash('sha256').update(bytes).digest('hex');
						if (actualSha256 !== asset.sha256.toLowerCase()) {
							return yield* new BundleLoadError({
								operation: 'BoltServer.BundleLoader.verifyAssets',
								bundlePath: absolutePath,
								message: `Bolt bundle ${half} asset checksum failed: ${asset.path}`
							});
						}
						if (bytes.byteLength !== asset.byteLength) {
							return yield* new BundleLoadError({
								operation: 'BoltServer.BundleLoader.verifyAssets',
								bundlePath: absolutePath,
								message: `Bolt bundle ${half} asset length disagrees with its index: ${asset.path}`
							});
						}
					}
				});
				yield* verify('browser', bundle.manifest.browserAssets);
				yield* verify('server', bundle.manifest.serverAssets);

				return bundle;
			});

			const cachedLoad = yield* Effect.cached(uncachedLoad());
			const load = Effect.fn('BoltServer.BundleLoader.load')(function* () {
				if (yield* Ref.get(disposed)) {
					return yield* new BundleLoadError({
						operation: 'BoltServer.BundleLoader.load',
						bundlePath: absolutePath,
						message: 'Bolt bundle loader is disposed'
					});
				}
				return yield* cachedLoad;
			});
			const dispose = Effect.fn('BoltServer.BundleLoader.dispose')(function* () {
				yield* Ref.set(disposed, true);
			});

			return BundleLoader.of({ load, dispose });
		})
	);
