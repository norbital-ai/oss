// Image inspection and derivation through the host's `Images` port (the decoders run host-side): bytes past the stored
// file limit never leave the engine, and every call runs under the image wall.
import { Effect, Schema } from 'effect';
import { FacilityFailure } from '../../decl/errors.ts';
import {
	LIMITS,
	type ImagePreviewMime as PreviewMime,
	type ImagePreviewSize
} from '../contracts.ts';
import { Images } from '../ports.ts';
import { Port, type PortFailure } from '../port.ts';

export const ImagePreviewMime = Schema.Literals([
	'image/jpeg',
	'image/png',
	'image/heic',
	'image/heif'
]);

const image = <A>(
	bytes: Uint8Array,
	call: (images: Images['Service']) => Effect.Effect<A, PortFailure>
) =>
	Effect.gen(function* () {
		if (bytes.byteLength > LIMITS.storedFileBytes)
			return yield* Effect.fail(
				new FacilityFailure({
					kind: 'upstream',
					message: 'the image exceeds the stored file size limit'
				})
			);
		return yield* call(yield* Images);
	}).pipe(Port.call('files.image', LIMITS.callMs.image));
export const imageFacts = (bytes: Uint8Array) => image(bytes, (images) => images.facts(bytes));
export const imageJpeg = (bytes: Uint8Array, maxEdge: number) =>
	image(bytes, (images) => images.jpeg(bytes, maxEdge));
export const imagePreview = (bytes: Uint8Array, mime: PreviewMime, maxEdge: ImagePreviewSize) =>
	image(bytes, (images) => images.preview(bytes, mime, maxEdge));
