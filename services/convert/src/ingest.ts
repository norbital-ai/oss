// Ingest, never OCR. A document is `{ kind: 'document', html, images }`; a dataset `{ kind: 'data', json, images }`.
// The router picks one reader per format; every document reader builds blocks for the one writer (blocks.ts):
//   docx doc pptx                office_oxide (readers/office.ts)
//   odt odp ppt rtf              LibreOffice into docx or pptx, then office_oxide
//   xlsx xls · ods               Calamine (readers/workbook.ts) · LibreOffice into xlsx, then Calamine
//   pdf                          MuPDF's trace of each page, our layout (readers/pdf.ts); pictures from Poppler
//   html                         parse5 (readers/html.ts), then only the allowed elements survive
//   txt → <pre> · png jpeg gif webp → one <img> · audio → the transcription model, one <section> per segment
//   csv tsv → typed sheets · json → itself, parsed
//   zip tar tgz                  from the disk (readers/archive.ts): the files listed, or one by `entry` streamed out and read as its own type
//   video, CAD, anything else → 415 (no parser); inside an archive, UTF-8 text is read as text
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, Schema } from 'effect';
import officeCrypto from 'officecrypto-tool';
import { escape, Images, write, type Block, type Image } from './blocks.ts';
import { fromDisk, route, type Kind } from './route.ts';
import { find } from './readers/archive.ts';
import { html } from './readers/html.ts';
import { converted, office } from './readers/office.ts';
import { readPdf } from './readers/pdf.ts';
import { named, scratch, tool } from './readers/tools.ts';
import { workbook } from './readers/workbook.ts';
import { parseCsv, sheet, typed, type Sheets } from './sheets.ts';
import type { TranscribeOptions, Transcriber, Usage } from './transcribe.ts';

/** What a file parses to: a document's sanitised HTML, or a dataset's JSON; either with its pictures. */
export type Parsed = { kind: 'document'; html: string; images: Image[] } | { kind: 'data'; json: unknown; images: Image[] };
/** The job's own facts, beside the parse: what it cost, and the transcription model's usage. */
export type Meta = { usage?: Usage; stats: { pages: number | null; bytes: number; cpuMs: number; wallMs: number } };
export type Ingested = Parsed & { meta: Meta };
/**
 * `path` is the file on the volume, for the readers that take it from there. `password` opens a locked PDF or Office
 * file; `entry` is a path inside an archive (on into an archive inside it), read as its own type.
 */
export type IngestRequest = {
	name: string;
	mime: string;
	bytes: Uint8Array;
	path?: string;
	options?: TranscribeOptions & { password?: string; entry?: string };
};
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

/** The Office formats officecrypto-tool opens: ECMA-376 agile and standard encryption, and the binary formats' RC4. */
const OFFICE = /^(xlsx|xls|docx|doc|pptx|ppt)$/;
const locked = (name: string) =>
	new IngestFailed({ message: `${name} is password-protected: read it again with its password` });
const refused = (name: string) => new IngestFailed({ message: `the password does not open ${name}` });
/** A file officecrypto-tool cannot parse as a container (an older binary format) is not one it can open either. */
const encrypted = (bytes: Buffer) => {
	try {
		return officeCrypto.isEncrypted(bytes);
	} catch {
		return false;
	}
};
/**
 * The file as the readers take it: a locked PDF or Office file opened with `password` into a copy of its own, anything
 * else as it is. An error never quotes the command line, which holds the password.
 */
const unlocked = (path: string, ext: string, name: string, password: string | undefined) =>
	Effect.gen(function* () {
		if (ext === 'pdf') {
			if (password === undefined) return path;
			const open = join(yield* scratch, 'input.pdf');
			// ponytail: mutool takes the password only on its command line, which only this container's user can see
			yield* tool('mutool', ['clean', '-D', '-p', password, path, open]).pipe(
				Effect.mapError((error) =>
					/password/i.test(error.message) ? refused(name) : new IngestFailed({ message: `${name} could not be opened` })
				)
			);
			return open;
		}
		if (!OFFICE.test(ext)) return path;
		const bytes = yield* Effect.tryPromise({ try: () => readFile(path), catch: () => new IngestFailed({ message: `${name} could not be read` }) });
		if (!encrypted(bytes)) return path;
		if (password === undefined) return yield* locked(name);
		const open = yield* Effect.tryPromise({ try: () => officeCrypto.decrypt(bytes, { password }), catch: () => refused(name) });
		const copy = join(yield* scratch, `input.${ext}`);
		yield* Effect.tryPromise({ try: () => writeFile(copy, open), catch: () => new IngestFailed({ message: `${name} could not be opened` }) });
		return copy;
	});

const PAGE_DPI = 200;
const pageImage = (path: string, n: number, images: Images) =>
	tool('pdftoppm', ['-f', `${n}`, '-l', `${n}`, '-r', `${PAGE_DPI}`, '-gray', '-jpeg', '-singlefile', path]).pipe(
		Effect.map((stdout): Block[] => [
			{ t: 'section', kind: 'page', n, blocks: [{ t: 'img', src: images.add(stdout, 'image/jpeg'), alt: '' }] }
		])
	);

const isText = (bytes: Uint8Array) => {
	if (bytes.includes(0)) return false;
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
};
const count = (n: number) => n.toLocaleString('en-US');
/** An archive's entry read as bytes (text, an image, a CSV) is at most this large; a document is read from its file. */
export const ENTRY_TEXT_BYTES = 16 * 1024 * 1024;
const entryBytes = (path: string, name: string) =>
	Effect.tryPromise({
		try: async () => {
			const size = (await stat(path)).size;
			if (size > ENTRY_TEXT_BYTES) throw new Error(`${name}: ${count(size)} bytes, over ${ENTRY_TEXT_BYTES / 1024 / 1024} MiB to read`);
			return new Uint8Array(await readFile(path));
		},
		catch: (cause) => new IngestFailed({ message: cause instanceof Error ? cause.message : String(cause) })
	});

export function ingester(o: IngestOptions = {}): Ingester {
	const failed = (cause: unknown) =>
		new IngestFailed({ message: cause instanceof Error ? cause.message : String(cause) });
	const ingest = Effect.fn('Convert.ingest')(function* (given: IngestRequest, entry = false): Effect.fn.Return<Ingested, IngestFailed> {
		const routed = route(given.name, given.mime);
		// an archive's entry lies in a file: a reader that takes bytes reads them, at most `ENTRY_TEXT_BYTES`
		const request =
			entry && given.path !== undefined && (!routed.ok || !fromDisk(routed.reader))
				? { ...given, bytes: yield* entryBytes(given.path, given.name) }
				: given;
		// an archive's entry has no type of its own: UTF-8 text is text, anything else is named by its size
		const r: typeof routed = routed.ok
			? routed
			: entry && isText(request.bytes)
				? { ok: true, ext: 'txt', kind: 'text', reader: 'pre', mime: 'text/plain' }
				: routed;
		if (!r.ok)
			return yield* new IngestFailed({
				message: entry ? `${request.name}: ${count(request.bytes.byteLength)} bytes, binary; ${r.message}` : r.message
			});
		const cpu = process.cpuUsage();
		const t0 = performance.now();
		const images = new Images();
		let usage: Usage | undefined;
		const text = () => Buffer.from(request.bytes).toString('utf8');
		const sync = <A>(f: () => A) => Effect.try({ try: f, catch: failed });
		// the engines tell a format by its extension, and a spooled file has none
		const file = Effect.flatMap(named(request, `input.${r.ext}`), (path) =>
			unlocked(path, r.ext, request.name, request.options?.password)
		);
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
				).pipe(
					// Poppler names a missing user password; the command line it quotes holds no password
					Effect.mapError((error) => (/Incorrect password/.test(error.message) ? locked(request.name) : failed(error)))
				);
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
			case 'archive': {
				const { entry, ...rest } = request.options ?? {};
				// the archive stays on the disk: a listing reads its directory, an entry streams into a file of its own
				const found = yield* Effect.scoped(
					Effect.gen(function* () {
						const archive = yield* named(request, `input.${r.ext}`),
							dir = yield* scratch;
						let n = 0;
						const got = yield* Effect.tryPromise({
							try: () => find(archive, r.ext, entry ?? '', async (name) => join(dir, `${++n}-${name}`)),
							catch: failed
						});
						if ('folder' in got) return got;
						return yield* ingest({ name: got.file.name, mime: '', path: got.file.path, bytes: new Uint8Array(), options: rest }, true);
					})
				).pipe(Effect.mapError((error) => (error instanceof IngestFailed ? error : failed(error))));
				if (!('folder' in found)) return found;
				blocks = [{ t: 'pre', text: found.folder.map((file) => `${file.path}  ${count(file.size)} bytes`).join('\n') }];
				break;
			}
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
	return (request) => ingest(request);
}
