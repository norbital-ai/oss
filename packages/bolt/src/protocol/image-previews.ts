import { Cache, Context, Data, Effect, Layer, Option, Schema, Semaphore } from 'effect';
import { LIMITS, type ImagePreview, type ImagePreviewSize } from '../engine/contracts.ts';
import { Files, Images } from '../engine/ports.ts';
import type { PortFailure } from '../engine/port.ts';
import { imagePreview, ImagePreviewMime } from '../engine/files/image.ts';

class PreviewKey extends Data.Class<{
	key: string;
	mime: string;
	edge: ImagePreviewSize;
}> {}

/** Authorized callers only: the file route checks the current record/conversation access before every lookup. */
export class ImagePreviews extends Context.Service<
	ImagePreviews,
	{
		readonly get: (
			key: string,
			mime: string,
			edge: ImagePreviewSize
		) => Effect.Effect<ImagePreview, PortFailure>;
	}
>()('bolt/ImagePreviews') {}

/** Per activation: at most four 2 MiB derivatives, and one source fetch/decoder at a time. */
export const ImagePreviewsLive = Layer.effect(
	ImagePreviews,
	Effect.gen(function* () {
		const files = yield* Files;
		const images = yield* Images;
		const conversion = yield* Semaphore.make(1);
		const lookup = Effect.fn('ImagePreviews.derive')(function* (request: PreviewKey) {
			const bytes = yield* files.get(request.key, LIMITS.storedFileBytes);
			const mime = Schema.decodeUnknownOption(ImagePreviewMime)(request.mime);
			return Option.isSome(mime)
				? yield* imagePreview(bytes, mime.value, request.edge).pipe(
						Effect.provideService(Images, images)
					)
				: { bytes, mime: request.mime, derived: false };
		});
		const cache = yield* Cache.make({ capacity: 4, lookup });
		yield* Effect.addFinalizer(() => Cache.invalidateAll(cache));
		return ImagePreviews.of({
			get: Effect.fn('ImagePreviews.get')(function* (
				key: string,
				mime: string,
				edge: ImagePreviewSize
			) {
				const request = new PreviewKey({ key, mime, edge });
				const hit = yield* Cache.getOption(cache, request);
				if (Option.isSome(hit)) return hit.value;
				return yield* Semaphore.withPermit(conversion)(
					Effect.gen(function* () {
						const shared = yield* Cache.getOption(cache, request);
						if (Option.isSome(shared)) return shared.value;
						const image = yield* lookup(request);
						// Populate explicitly: originals, failures and larger valid previews never enter the cache.
						if (image.derived && image.bytes.byteLength <= 2 * 1024 * 1024)
							yield* Cache.set(cache, request, image);
						return image;
					})
				);
			})
		});
	})
);
