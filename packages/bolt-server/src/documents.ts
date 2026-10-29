import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { Effect, Schema } from 'effect';
import { FacilityFailure } from '@norbital-ai/bolt/errors';
const failure = (error: unknown) =>
	new FacilityFailure({
		kind: 'upstream',
		message: error instanceof Error ? error.message : String(error)
	});
const Extracted = Schema.Struct({
	body: Schema.NonEmptyString,
	pageCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
});
/** The Office worker's structured-clone response; the parent decodes every packet. */
export const OfficeResult = Schema.TaggedUnion({
	Extracted: { body: Extracted.fields.body },
	Failed: { message: Schema.String }
});
/** One answer from a scoped parser worker (`office` or `pdf`); ending the scope terminates it. */
const inWorker = (kind: 'office' | 'pdf', workerData: unknown) =>
	Effect.gen(function* () {
		const worker = yield* Effect.acquireRelease(
			Effect.try({
				try: () =>
					new Worker(
						new URL(
							`./${kind}-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
							import.meta.url
						),
						{ workerData, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } }
					),
				catch: failure
			}),
			(worker) =>
				Effect.tryPromise({ try: () => worker.terminate(), catch: failure }).pipe(
					Effect.tapCause(Effect.logWarning),
					Effect.ignore
				)
		);
		return yield* Effect.callback<unknown, FacilityFailure>((resume) => {
			const message = (value: unknown) => resume(Effect.succeed(value));
			const error = (cause: unknown) => resume(Effect.fail(failure(cause)));
			const exit = () => error(new Error('Document extraction ended without a complete result.'));
			worker.once('message', message);
			worker.once('error', error);
			worker.once('exit', exit);
			return Effect.sync(() => {
				worker.off('message', message);
				worker.off('error', error);
				worker.off('exit', exit);
			});
		});
	});
const Rendered = Schema.Struct({ pages: Schema.Array(Schema.Uint8Array), pageCount: Schema.Int });
/**
 * A PDF's first `pages` pages as JPEG images at 200 DPI (at most 2400 px on the long edge): what a model reads a scan
 * or handwriting from. A provider's own PDF handling may OCR it to text the model never checks against the page.
 */
export const renderDocumentPages = Effect.fn('server.renderDocumentPages')(function* (
	bytes: Uint8Array,
	pages: number
) {
	if (bytes.byteLength === 0 || bytes.byteLength > 20 * 1024 * 1024)
		return yield* Effect.fail(
			failure(new Error('Documents must contain between 1 byte and 20 MiB.'))
		);
	return yield* Effect.scoped(
		inWorker('pdf', { bytes, render: pages }).pipe(
			Effect.flatMap((result) =>
				Schema.decodeUnknownEffect(Rendered)(result).pipe(Effect.mapError(failure))
			)
		)
	).pipe(
		Effect.timeoutOrElse({
			duration: '30 seconds',
			orElse: () =>
				Effect.fail(
					new FacilityFailure({
						kind: 'timeout',
						message: 'Rendering the pages exceeded 30 seconds.'
					})
				)
		})
	);
});
/** Parser CPU and memory are bounded in a scoped worker; cancelling a request terminates it. */
export const extractDocumentText = Effect.fn('server.extractDocumentText')(function* (
	bytes: Uint8Array,
	contentType: string
) {
	if (bytes.byteLength === 0 || bytes.byteLength > 20 * 1024 * 1024)
		return yield* Effect.fail(
			failure(new Error('Documents must contain between 1 byte and 20 MiB.'))
		);
	const sha256 = createHash('sha256').update(bytes).digest('hex'),
		mime = (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
	const office = [
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
	].includes(mime);
	if (mime !== 'application/pdf' && !office)
		return yield* Effect.try({
			try: () => {
				if (!/^(text\/[\w.+-]+|application\/(csv|json|(?:[\w.-]+\+)?xml))$/.test(mime))
					throw new Error('Supported documents are PDF, DOCX, XLSX, text, CSV, JSON and XML.');
				const charset = /charset\s*=\s*["']?([\w-]+)/i;
				const declared =
					contentType.match(charset)?.[1] ??
					(mime === 'text/html'
						? Buffer.from(bytes.subarray(0, 1024))
								.toString('latin1')
								.match(/<meta\b[^>]*>/gi)
								?.map((tag) => tag.match(charset)?.[1])
								.find((value) => value !== undefined)
						: undefined);
				const body = new TextDecoder(declared ?? 'utf-8', { fatal: true }).decode(bytes);
				if (body.includes('\u0000')) throw new Error('Document contains binary data.');
				if (bytes.byteLength > 2 * 1024 * 1024)
					throw new Error('Document text exceeds the 2 MiB limit.');
				return { body, sha256 };
			},
			catch: failure
		});
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const result = yield* inWorker(office ? 'office' : 'pdf', office ? { bytes, mime } : bytes);
			const decoded: typeof Extracted.Type = office
				? yield* Effect.gen(function* () {
						const packet = yield* Schema.decodeUnknownEffect(OfficeResult)(result).pipe(
							Effect.mapError(failure)
						);
						if (packet._tag === 'Failed')
							return yield* Effect.fail(
								new FacilityFailure({ kind: 'upstream', message: packet.message })
							);
						return { body: packet.body };
					})
				: yield* Schema.decodeUnknownEffect(Extracted)(result).pipe(Effect.mapError(failure));
			return { ...decoded, sha256 };
		})
	).pipe(
		Effect.timeoutOrElse({
			duration: '10 seconds',
			orElse: () =>
				Effect.fail(
					new FacilityFailure({
						kind: 'timeout',
						message: 'Document extraction exceeded ten seconds.'
					})
				)
		})
	);
});
