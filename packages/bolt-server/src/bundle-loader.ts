import {
	type BoltBundle,
	type FacilityBindings,
	PROTOCOL_VERSION,
	decodeBoltBundleModule,
	missingFacilities
} from '@norbital-ai/bolt-protocol';
import { Context, Effect, Layer, Ref, Schema } from 'effect';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
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

// stupidity:allow AL10 -- service shape stays beside its Context.Service owner in the required 14-file architecture
export interface Interface {
	readonly load: () => Effect.Effect<BoltBundle, BundleLoadError>;
	readonly dispose: () => Effect.Effect<void>;
}

/** Owns one cached, checksum-verified Bolt bundle for the application lifetime; stupidity:allow Q4 -- Effect Context.Service declaration is the canonical Effect v4 service tag. */
export class BundleLoader extends Context.Service<BundleLoader, Interface>()(
	'@norbital-ai/bolt-server/BundleLoader'
) {}

// stupidity:allow AL10 -- layer options stay beside their sole runtime constructor in the required 14-file architecture
export interface LayerOptions {
	readonly bundlePath: string;
	readonly facilities: FacilityBindings;
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

				const assetPaths = new Set<string>();
				for (const asset of bundle.manifest.staticAssets) {
					if (assetPaths.has(asset.path)) {
						return yield* new BundleLoadError({
							operation: 'BoltServer.BundleLoader.verifyAssets',
							bundlePath: absolutePath,
							message: `Bolt bundle contains duplicate static asset path: ${asset.path}`
						});
					}
					assetPaths.add(asset.path);
					const actualSha256 = createHash('sha256').update(asset.bytes).digest('hex');
					if (actualSha256 !== asset.sha256.toLowerCase()) {
						return yield* new BundleLoadError({
							operation: 'BoltServer.BundleLoader.verifyAssets',
							bundlePath: absolutePath,
							message: `Bolt bundle static asset checksum failed: ${asset.path}`
						});
					}
				}

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

/** Names the bundle-loader Layer constructor for host composition tooling. */
export const BundleLoaderLayers = { make: makeLayer };
