// Image inspection and derivation through the host's `Images` port (the decoders run host-side): bytes past the stored
// file limit never leave the engine, and every call runs under the image wall.
import { Effect } from 'effect';
import {
	FacilityFailure,
	type ImageCrop,
	type ImagePreviewMime,
	type ImagePreviewSize,
	Port,
	type PortFailure
} from '@norbital-ai/host-api';
import { LIMITS } from '../contracts.ts';
import { Images } from '../ports.ts';

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
export const image_facts = (bytes: Uint8Array) => image(bytes, (images) => images.facts(bytes));
export const image_jpeg = (bytes: Uint8Array, maxEdge: number) =>
	image(bytes, (images) => images.jpeg(bytes, maxEdge));
export const imageCrop = (bytes: Uint8Array, box: ImageCrop) =>
	image(bytes, (images) => images.crop(bytes, box));
export const imagePreview = (bytes: Uint8Array, mime: ImagePreviewMime, maxEdge: ImagePreviewSize) =>
	image(bytes, (images) => images.preview(bytes, mime, maxEdge));
