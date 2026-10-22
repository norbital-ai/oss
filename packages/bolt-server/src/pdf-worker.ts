// PDF parsing stays in an isolated native worker. Its process scope owns the parser.
import { Effect, Schema } from 'effect';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import { parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
class PdfFailure extends Schema.TaggedError<PdfFailure>()('PdfFailure', {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect())
}) {}
const failed = (cause: unknown) =>
	new PdfFailure({ message: cause instanceof Error ? cause.message : String(cause), cause });
const parse = Effect.scoped(
	Effect.gen(function* () {
		const bytes = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(workerData).pipe(
			Effect.mapError(failed)
		);
		const port = parentPort;
		if (port === null)
			return yield* Effect.fail(new PdfFailure({ message: 'Document worker required.' }));
		const packageRoot = new URL('./', import.meta.resolve('pdfjs-dist/package.json'));
		const loading = yield* Effect.acquireRelease(
			Effect.try({
				try: () =>
					getDocument({
						data: bytes,
						stopAtErrors: true,
						useWorkerFetch: false,
						useWasm: false,
						verbosity: 0,
						cMapUrl: fileURLToPath(new URL('cmaps/', packageRoot)),
						cMapPacked: true,
						standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', packageRoot))
					}),
				catch: failed
			}),
			(loading) =>
				Effect.tryPromise({ try: () => loading.destroy(), catch: failed }).pipe(
					Effect.tapCause(Effect.logWarning),
					Effect.ignore
				)
		);
		const document = yield* Effect.tryPromise({ try: () => loading.promise, catch: failed });
		if (document.numPages > 200)
			return yield* Effect.fail(
				new PdfFailure({ message: 'PDF exceeds the 200-page extraction limit.' })
			);
		const pages: string[] = [];
		let textBytes = 0;
		for (let number = 1; number <= document.numPages; number++) {
			const text = yield* Effect.acquireUseRelease(
				Effect.tryPromise({ try: () => document.getPage(number), catch: failed }),
				(page) =>
					Effect.tryPromise({ try: () => page.getTextContent(), catch: failed }).pipe(
						Effect.map((content) =>
							content.items
								.map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : ''))
								.join('')
								.trim()
						)
					),
				(page) =>
					Effect.sync(() => {
						page.cleanup();
					})
			);
			// a scanned page keeps its place; the readable pages are still evidence
			const section = `[Page ${number}]\n${text === '' ? '(no extractable text: a scanned page)' : text}`;
			textBytes += Buffer.byteLength(section, 'utf8') + 2;
			if (textBytes > 2 * 1024 * 1024)
				return yield* Effect.fail(
					new PdfFailure({ message: 'PDF text exceeds the 2 MiB extraction limit.' })
				);
			pages.push(section);
		}
		port.postMessage({ body: pages.join('\n\n'), pageCount: document.numPages });
	})
);
NodeRuntime.runMain(parse);
