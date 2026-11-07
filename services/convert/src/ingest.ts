// Ingest, never OCR. A document is `{ kind: 'document', html, images }`; a dataset `{ kind: 'data', json, images }`.
// The router picks one reader per format; every document reader builds blocks for the one writer (blocks.ts):
//   docx doc pptx                office_oxide (readers/office.ts)
//   odt odp ppt rtf              LibreOffice into docx or pptx, then office_oxide
//   xlsx xls · ods               Calamine (readers/workbook.ts) · LibreOffice into xlsx, then Calamine
//   pdf                          MuPDF's trace of each page, our layout (readers/pdf.ts); pictures from Poppler
//   html                         parse5 (readers/html.ts), then only the allowed elements survive
//   txt → <pre> · png jpeg gif webp → one <img> · audio → the transcription model, one <section> per segment
//   csv tsv → typed sheets · json → itself, parsed
//   video, CAD, anything else → 415 (no parser)
import { Effect, Schema } from 'effect';
import { escape, Images, write, type Block, type Image } from './blocks.ts';
import { route, type Kind } from './route.ts';
import { html } from './readers/html.ts';
import { converted, office } from './readers/office.ts';
import { readPdf } from './readers/pdf.ts';
import { named, tool } from './readers/tools.ts';
import { workbook } from './readers/workbook.ts';
import { parseCsv, sheet, typed, type Sheets } from './sheets.ts';
import type { TranscribeOptions, Transcriber, Usage } from './transcribe.ts';

/** What a file parses to: a document's sanitised HTML, or a dataset's JSON; either with its pictures. */
export type Parsed = { kind: 'document'; html: string; images: Image[] } | { kind: 'data'; json: unknown; images: Image[] };
/** The job's own facts, beside the parse: what it cost, and the transcription model's usage. */
export type Meta = { usage?: Usage; stats: { pages: number | null; bytes: number; cpuMs: number; wallMs: number } };
export type Ingested = Parsed & { meta: Meta };
/** `path` is the file on the volume, for the readers that take it from there. */
export type IngestRequest = { name: string; mime: string; bytes: Uint8Array; path?: string; options?: TranscribeOptions };
export class IngestFailed extends Schema.TaggedError<IngestFailed>()('IngestFailed', {
	message: Schema.String
}) {}
export type Ingester = (request: IngestRequest) => Effect.Effect<Ingested, IngestFailed>;

// ---------- csv, tsv ----------
/** One sheet named after the file, its values typed from their text. */
export const csv = (source: string, name: string): Sheets => ({
	sheets: [sheet(name.replace(/\.[^.]*$/, ''), parseCsv(source).map((r) => r.map(typed)))]
});

export type IngestOptions = {
	/** Audio's transcription model; absent, audio is refused before it is queued. */
	transcribe?: Transcriber;
};

const PAGE_DPI = 200;
const pageImage = (path: string, n: number, images: Images) =>
	tool('pdftoppm', ['-f', `${n}`, '-l', `${n}`, '-r', `${PAGE_DPI}`, '-gray', '-jpeg', '-singlefile', path]).pipe(
		Effect.map((stdout): Block[] => [
			{ t: 'section', kind: 'page', n, blocks: [{ t: 'img', src: images.add(stdout, 'image/jpeg'), alt: '' }] }
		])
	);

export function ingester(o: IngestOptions = {}): Ingester {
	const failed = (cause: unknown) =>
		new IngestFailed({ message: cause instanceof Error ? cause.message : String(cause) });
	return Effect.fn('Convert.ingest')(function* (request: IngestRequest) {
		const r = route(request.name, request.mime);
		if (!r.ok) return yield* new IngestFailed({ message: r.message });
		const cpu = process.cpuUsage();
		const t0 = performance.now();
		const images = new Images();
		let usage: Usage | undefined;
		const text = () => Buffer.from(request.bytes).toString('utf8');
		const sync = <A>(f: () => A) => Effect.try({ try: f, catch: failed });
		// the engines tell a format by its extension, and a spooled file has none
		const file = named(request, `input.${r.ext}`);
		const standard = (to: string) => Effect.flatMap(file, (path) => converted(path, to));
		let blocks: Block[] = [];
		let json: unknown;
		switch (r.reader) {
			case 'html':
				blocks = yield* sync(() => html(text(), images));
				break;
			case 'office':
				blocks = yield* Effect.scoped(
					Effect.flatMap(file, (path) => office(path, r.kind === 'slides', images))
				).pipe(Effect.mapError(failed));
				break;
			case 'libreoffice':
				if (r.ext === 'ods')
					json = yield* Effect.scoped(
						Effect.flatMap(standard('xlsx'), (path) => workbook(path, images))
					).pipe(Effect.mapError(failed));
				else
					blocks = yield* Effect.scoped(
						Effect.flatMap(standard(r.kind === 'slides' ? 'pptx' : 'docx'), (path) =>
							office(path, r.kind === 'slides', images)
						)
					).pipe(Effect.mapError(failed));
				break;
			case 'pre':
				blocks = [{ t: 'pre', text: text() }];
				break;
			case 'image':
				blocks = [{ t: 'img', src: images.add(request.bytes, r.mime), alt: request.name }];
				break;
			case 'audio': {
				if (!o.transcribe) return yield* new IngestFailed({ message: 'this converter has no transcription model' });
				const heard = yield* o.transcribe(request.bytes, request.options ?? {}).pipe(Effect.mapError(failed));
				usage = heard.usage;
				blocks = heard.transcript.segments.map((s) => ({ t: 'turn', speaker: s.speaker, start: s.start, end: s.end, html: escape(s.text) }));
				break;
			}
			case 'pdf': {
				const { page, pictures } = request.options ?? {};
				blocks = yield* Effect.scoped(
					Effect.flatMap(file, (path) =>
						page === undefined ? readPdf(path, images, pictures !== false) : pageImage(path, page, images)
					)
				).pipe(Effect.mapError(failed));
				break;
			}
			case 'workbook':
				json = yield* Effect.scoped(Effect.flatMap(file, (path) => workbook(path, images))).pipe(
					Effect.mapError(failed)
				);
				break;
			case 'csv':
				json = yield* sync(() => csv(text(), request.name));
				break;
			case 'json':
				json = yield* sync((): unknown => JSON.parse(text()));
				break;
		}
		const used = process.cpuUsage(cpu);
		const sections = blocks.filter((b) => b.t === 'section').length;
		const sheets = Schema.is(Schema.Struct({ sheets: Schema.Array(Schema.Unknown) }))(json) && r.reader !== 'json' ? json.sheets.length : 0;
		const parsed: Parsed = r.kind === 'sheets' ? { kind: 'data', json, images: images.list } : { kind: 'document', html: write(blocks), images: images.list };
		return {
			...parsed,
			meta: {
				...(usage ? { usage } : {}),
				stats: {
					pages: sections || sheets || null,
					bytes: request.bytes.byteLength,
					cpuMs: Math.round((used.user + used.system) / 1000),
					wallMs: Math.round(performance.now() - t0)
				}
			}
		};
	});
}
