// PDF parsing and page rendering stay in an isolated native worker. Its process scope owns the parser.
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
/** Pages as a model sees a scan: 200 DPI, at most 2400 px on the long edge, JPEG. */
const RENDER = { dpi: 200, maxEdge: 2400, quality: 85 } as const;
/**
 * pdfjs's Node canvas factory (its optional `@napi-rs/canvas`): a canvas that encodes itself, and its 2D context. pdfjs
 * types the factory as `object`, so this guard is the one place its shape is claimed.
 */
type NodeCanvasFactory = {
	create(
		width: number,
		height: number
	): {
		canvas: { toBuffer(mime: 'image/jpeg', quality: number): Uint8Array };
		context: CanvasRenderingContext2D;
	};
};
const isNodeCanvasFactory = (factory: object): factory is NodeCanvasFactory =>
	'create' in factory && typeof factory.create === 'function';
const Input = Schema.Union([
	Schema.Uint8Array,
	Schema.Struct({ bytes: Schema.Uint8Array, render: Schema.Int })
]);
const parse = Effect.scoped(
	Effect.gen(function* () {
		const input = yield* Schema.decodeUnknownEffect(Input)(workerData).pipe(
			Effect.mapError(failed)
		);
		const bytes = input instanceof Uint8Array ? input : input.bytes;
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
		if (!(input instanceof Uint8Array)) {
			const factory = document.canvasFactory;
			if (!isNodeCanvasFactory(factory))
				return yield* Effect.fail(new PdfFailure({ message: 'No canvas to render pages on.' }));
			const images: Uint8Array[] = [];
			for (let number = 1; number <= Math.min(document.numPages, input.render); number++)
				images.push(
					yield* Effect.acquireUseRelease(
						Effect.tryPromise({ try: () => document.getPage(number), catch: failed }),
						(page) =>
							Effect.tryPromise({
								try: async () => {
									const unit = page.getViewport({ scale: 1 });
									const viewport = page.getViewport({
										scale: Math.min(
											RENDER.dpi / 72,
											RENDER.maxEdge / Math.max(unit.width, unit.height)
										)
									});
									const { canvas, context } = factory.create(
										Math.ceil(viewport.width),
										Math.ceil(viewport.height)
									);
									await page.render({ canvas: null, canvasContext: context, viewport }).promise;
									return new Uint8Array(canvas.toBuffer('image/jpeg', RENDER.quality));
								},
								catch: failed
							}),
						(page) =>
							Effect.sync(() => {
								page.cleanup();
							})
					)
				);
			port.postMessage({ pages: images, pageCount: document.numPages });
			return;
		}
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
