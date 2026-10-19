// Shared host image inspection and derivation, with scoped worker ownership.
import { Effect, Predicate, Schema } from 'effect';
import { Worker } from 'node:worker_threads';
import { FacilityFailure } from '../../decl/errors.ts';
import { LIMITS } from '../contracts.ts';
import { Port } from '../port.ts';

const ImageFactsSchema = Schema.Struct({
	format: Schema.Literals(['jpeg', 'png', 'heic']),
	width: Schema.Number,
	height: Schema.Number,
	pdq: Schema.String,
	exif: Schema.Struct({
		takenAt: Schema.optionalKey(Schema.String),
		gps: Schema.optionalKey(Schema.Struct({ lat: Schema.Number, lng: Schema.Number })),
		software: Schema.optionalKey(Schema.String),
		make: Schema.optionalKey(Schema.String),
		model: Schema.optionalKey(Schema.String)
	})
});
export type ImageFacts = typeof ImageFactsSchema.Type;
const failed = (error: unknown) => {
	const message =
		Predicate.isObject(error) && 'message' in error && Predicate.isString(error.message)
			? error.message
			: 'the image worker failed';
	return new FacilityFailure({
		kind: 'upstream',
		message
	});
};
const bytesSchema = Schema.declare(
	(value: unknown): value is Uint8Array => value instanceof Uint8Array
);
export const ImagePreviewSize = Schema.Literals([64, 512, 1024]);
export type ImagePreviewSize = typeof ImagePreviewSize.Type;
export const ImagePreviewMime = Schema.Literals([
	'image/jpeg',
	'image/png',
	'image/heic',
	'image/heif'
]);
export type ImagePreviewMime = typeof ImagePreviewMime.Type;
const ImagePreviewSchema = Schema.Struct({
	bytes: bytesSchema,
	mime: Schema.String,
	derived: Schema.Boolean
});
export type ImagePreview = typeof ImagePreviewSchema.Type;
const image = <A>(
	bytes: Uint8Array,
	options: { maxEdge?: number; preview?: { maxEdge: ImagePreviewSize; mime: ImagePreviewMime } },
	decoder: Schema.Decoder<A>
) =>
	Effect.scoped(
		Effect.gen(function* () {
			if (bytes.byteLength > LIMITS.storedFileBytes)
				return yield* Effect.fail(
					failed(new Error('the image exceeds the stored file size limit'))
				);
			const worker = yield* Effect.acquireRelease(
				Effect.try({
					try: () =>
						new Worker(
							new URL(
								'./image-worker' + (import.meta.url.endsWith('.ts') ? '.ts' : '.js'),
								import.meta.url
							),
							{
								workerData: { bytes, ...options },
								resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 }
							}
						),
					catch: failed
				}),
				(worker) =>
					Effect.tryPromise({ try: () => worker.terminate(), catch: failed }).pipe(
						Effect.tapCause(Effect.logWarning),
						Effect.orDie
					)
			);
			const answer = yield* Effect.callback<unknown, FacilityFailure>((resume) => {
				const message = (value: unknown) => resume(Effect.succeed(value));
				const error = (cause: Error) => resume(Effect.fail(failed(cause)));
				const exit = () =>
					resume(Effect.fail(failed(new Error('the image worker ended without an answer'))));
				worker.once('message', message);
				worker.once('error', error);
				worker.once('exit', exit);
				return Effect.sync(() => {
					worker.off('message', message);
					worker.off('error', error);
					worker.off('exit', exit);
				});
			}).pipe(Port.call('files.image', LIMITS.callMs.image));
			return yield* Schema.decodeUnknownEffect(decoder)(answer).pipe(
				Effect.mapError(() => failed(new Error('the image worker returned an invalid answer')))
			);
		})
	);
export const imageFacts = (bytes: Uint8Array) => image(bytes, {}, ImageFactsSchema);
export const imageJpeg = (bytes: Uint8Array, maxEdge: number) =>
	image(bytes, { maxEdge }, bytesSchema);
export const imagePreview = (
	bytes: Uint8Array,
	mime: ImagePreviewMime,
	maxEdge: ImagePreviewSize
) => image(bytes, { preview: { maxEdge, mime } }, ImagePreviewSchema);
