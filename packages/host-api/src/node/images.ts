/// <reference types="node" />
// Image decoding for same-graph hosts (`ImagesPort`): one worker per call (image-worker.ts), never on the host's
// event loop; the worker is bounded here too, since the host owns its CPU and heap whatever engine asks.
import { Worker } from 'node:worker_threads';
import { Effect, Predicate, Schema } from 'effect';
import {
	FacilityFailure,
	HOST_LIMITS,
	type ImageCrop as CropBox,
	ImageMetadataSchema,
	type ImagePreviewMime,
	type ImagesPort,
	Port
} from '../index.ts';

const failed = (error: unknown) =>
	new FacilityFailure({
		kind: 'upstream',
		message:
			Predicate.isObject(error) && 'message' in error && Predicate.isString(error.message)
				? error.message
				: 'the image worker failed'
	});
const bytesSchema = Schema.declare(
	(value: unknown): value is Uint8Array => value instanceof Uint8Array
);
export const ImagePreviewSize = Schema.Literals([64, 512, 1024]);
export const ImageCrop = Schema.Struct({
	left: Schema.Number,
	top: Schema.Number,
	right: Schema.Number,
	bottom: Schema.Number,
	min_edge: Schema.optionalKey(Schema.Number)
});
const ImagePreviewSchema = Schema.Struct({
	bytes: bytesSchema,
	mime: Schema.String,
	derived: Schema.Boolean
});
const image = <A>(
	bytes: Uint8Array,
	options: {
		maxEdge?: number;
		crop?: CropBox;
		preview?: { maxEdge: typeof ImagePreviewSize.Type; mime: ImagePreviewMime };
	},
	decoder: Schema.Decoder<A>
) =>
	Effect.scoped(
		Effect.gen(function* () {
			if (bytes.byteLength > HOST_LIMITS.storedFileBytes)
				return yield* Effect.fail(
					failed(new Error('the image exceeds the stored file size limit'))
				);
			const worker = yield* Effect.acquireRelease(
				Effect.try({
					try: () => {
						const started = new Worker(
							new URL(
								'./image-worker' + (import.meta.url.endsWith('.ts') ? '.ts' : '.js'),
								import.meta.url
							),
							{
								workerData: { bytes, ...options },
								resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 }
							}
						);
						// an interrupted call stops listening before the worker ends: its failure must not reach the process
						started.on('error', () => {});
						return started;
					},
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
			}).pipe(Port.call('files.image', HOST_LIMITS.callMs.image));
			return yield* Schema.decodeUnknownEffect(decoder)(answer).pipe(
				Effect.mapError(() => failed(new Error('the image worker returned an invalid answer')))
			);
		})
	);

/** The `ImagesPort` for Node hosts: facts, JPEG, crop and preview, each in a memory-capped worker under the image wall. */
export const images_port: ImagesPort = {
	facts: (bytes, signal) => Effect.runPromise(image(bytes, {}, ImageMetadataSchema), { signal }),
	jpeg: (bytes, maxEdge, signal) =>
		Effect.runPromise(image(bytes, { maxEdge }, bytesSchema), { signal }),
	crop: (bytes, crop, signal) => Effect.runPromise(image(bytes, { crop }, bytesSchema), { signal }),
	preview: (bytes, mime, maxEdge, signal) =>
		Effect.runPromise(image(bytes, { preview: { maxEdge, mime } }, ImagePreviewSchema), {
			signal
		})
};
