// Ingest, never OCR. A document is `{ kind: 'document', html, images }`; a dataset `{ kind: 'data', json, images }`.
// The router picks one reader per format; every document reader builds blocks for the one writer (blocks.ts).
//   html                         parse5, then only the allowed elements survive
//   docx pptx odt odp            their XML (office.ts): merged and nested cells kept
//   pdf                          pdf.js (pdf.ts): text, tables and pictures from the page's own structure
//   doc ppt rtf                  Kreuzberg's structured result (@kreuzberg/node, OCR never asked for)
//   txt → <pre> · png jpeg gif webp → one <img> · audio → the transcription model, one <section> per segment
//   xlsx ods (office.ts) · xls (Kreuzberg's grids) · csv tsv → typed sheets · json → itself, parsed
//   video, CAD, anything else → 415 (no parser)
import { extractBytes, type ExtractionConfig } from '@kreuzberg/node';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { Effect, Schema, Semaphore } from 'effect';
import { escape, Images, inline, write, type Block, type Cell, type Image } from './blocks.ts';
import { docx, odf, ods, pptx, xlsx } from './office.ts';
import { readPdf } from './pdf.ts';
import { parseCsv, sheet, typed, type Merge, type Sheet, type Sheets, type Value } from './sheets.ts';
import type { TranscribeOptions, Transcriber, Usage } from './transcribe.ts';

export type Kind = 'pdf' | 'document' | 'slides' | 'sheets' | 'text' | 'image' | 'audio';
/** What a file parses to: a document's sanitised HTML, or a dataset's JSON; either with its pictures. */
export type Parsed = { kind: 'document'; html: string; images: Image[] } | { kind: 'data'; json: unknown; images: Image[] };
/** The job's own facts, beside the parse: what it cost, and the transcription model's usage. */
export type Meta = { usage?: Usage; stats: { pages: number | null; bytes: number; cpuMs: number; wallMs: number } };
export type Ingested = Parsed & { meta: Meta };
export type IngestRequest = { name: string; mime: string; bytes: Uint8Array; options?: TranscribeOptions };
export class IngestFailed extends Schema.TaggedError<IngestFailed>()('IngestFailed', {
	message: Schema.String
}) {}
export type Ingester = (request: IngestRequest) => Effect.Effect<Ingested, IngestFailed>;

type Reader = 'html' | 'docx' | 'xlsx' | 'pptx' | 'odf' | 'ods' | 'pdf' | 'kreuzberg' | 'xls' | 'pre' | 'csv' | 'json' | 'image' | 'audio';
const FORMATS: Record<string, { mime: string; kind: Kind; reader: Reader }> = {
	pdf: { mime: 'application/pdf', kind: 'pdf', reader: 'pdf' },
	doc: { mime: 'application/msword', kind: 'document', reader: 'kreuzberg' },
	rtf: { mime: 'application/rtf', kind: 'document', reader: 'kreuzberg' },
	docx: {
		mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		kind: 'document',
		reader: 'docx'
	},
	odt: { mime: 'application/vnd.oasis.opendocument.text', kind: 'document', reader: 'odf' },
	html: { mime: 'text/html', kind: 'document', reader: 'html' },
	ppt: { mime: 'application/vnd.ms-powerpoint', kind: 'slides', reader: 'kreuzberg' },
	pptx: {
		mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		kind: 'slides',
		reader: 'pptx'
	},
	odp: { mime: 'application/vnd.oasis.opendocument.presentation', kind: 'slides', reader: 'odf' },
	xls: { mime: 'application/vnd.ms-excel', kind: 'sheets', reader: 'xls' },
	xlsx: {
		mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		kind: 'sheets',
		reader: 'xlsx'
	},
	ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', kind: 'sheets', reader: 'ods' },
	csv: { mime: 'text/csv', kind: 'sheets', reader: 'csv' },
	tsv: { mime: 'text/tab-separated-values', kind: 'sheets', reader: 'csv' },
	json: { mime: 'application/json', kind: 'sheets', reader: 'json' },
	txt: { mime: 'text/plain', kind: 'text', reader: 'pre' },
	png: { mime: 'image/png', kind: 'image', reader: 'image' },
	jpg: { mime: 'image/jpeg', kind: 'image', reader: 'image' },
	gif: { mime: 'image/gif', kind: 'image', reader: 'image' },
	webp: { mime: 'image/webp', kind: 'image', reader: 'image' }
};
const ALIAS: Record<string, string> = {
	htm: 'html',
	jpeg: 'jpg',
	md: 'txt',
	text: 'txt',
	'text/rtf': 'rtf',
	'application/xhtml+xml': 'html',
	'text/markdown': 'txt',
	'image/jpg': 'jpg'
};
const BY_MIME = new Map(Object.entries(FORMATS).map(([ext, f]) => [f.mime, ext]));
const AUDIO = /^(mp3|m4a|wav|ogg|oga|opus|flac|aac|weba|webm|mp4)$/;
/** Containers whose audio track the transcriber can read (mp4, m4a, webm, ogg); other video containers are refused. */
const CONTAINER = /^(mp4|m4a|webm|ogg)$/;
const NO_PARSER = 'no parser: build a tool for it with your workspace tools';

export type Route =
	| { ok: true; ext: string; kind: Kind; reader: Reader; mime: string }
	| { ok: false; message: string };
/** The format of a file by its mime type, then its name's extension; never a guess at contents. */
export function route(name: string, mime: string): Route {
	const type = mime.split(';')[0]!.trim().toLowerCase();
	const dot = name.lastIndexOf('.');
	const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
	const media = /^(audio|video)\/([\w.+-]+)$/.exec(type);
	if (type.startsWith('audio/') || (AUDIO.test(ext) && (type === '' || type === 'application/octet-stream' || media)))
		return media?.[1] === 'video' && !CONTAINER.test(media[2] === 'quicktime' ? 'mov' : media[2]!)
			? { ok: false, message: NO_PARSER }
			: { ok: true, ext, kind: 'audio', reader: 'audio', mime: type };
	const found =
		BY_MIME.get(type) ??
		ALIAS[type] ??
		(type === '' || type === 'application/octet-stream' ? (ALIAS[ext] ?? ext) : undefined);
	const format = found === undefined ? undefined : FORMATS[found];
	if (!format || type.startsWith('video/'))
		return { ok: false, message: NO_PARSER };
	return { ok: true, ext: found!, ...format };
}

// ---------- html ----------
type Node5 = DefaultTreeAdapterMap['childNode'];
const DROP = new Set([
	'script', 'style', 'template', 'noscript', 'head', 'iframe', 'object', 'embed', 'svg', 'math', 'canvas',
	'button', 'input', 'select', 'textarea', 'option', 'video', 'audio', 'map'
]);
const INLINE: Record<string, 'strong' | 'em' | 'code' | 'time' | undefined> = {
	strong: 'strong', b: 'strong', em: 'em', i: 'em', code: 'code', kbd: 'code', samp: 'code', tt: 'code', time: 'time'
};
const PHRASING = new Set(['a', 'span', 'abbr', 'cite', 'dfn', 'mark', 'q', 's', 'small', 'sub', 'sup', 'u', 'font', 'label', 'var', 'del', 'ins', 'bdi', 'bdo', 'data', 'nobr', 'wbr', 'big', 'strike']);
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i;
const attr = (n: Node5, name: string) =>
	'attrs' in n ? n.attrs.find((a) => a.name === name)?.value : undefined;
const span = (v: string | undefined) => {
	const n = Number(v);
	return Number.isInteger(n) && n > 1 ? Math.min(n, 1000) : 1;
};

export function html(source: string, images: Images): Block[] {
	const flow = (nodes: readonly Node5[]): Block[] => {
		const out: Block[] = [];
		let buffer = '';
		const flush = () => {
			const h = buffer.trim();
			if (h) out.push({ t: 'p', html: h });
			buffer = '';
		};
		const phrase = (n: Node5): string => {
			if (n.nodeName === '#text' && 'value' in n) return escape(n.value.replace(/\s+/g, ' '));
			if (!('tagName' in n) || DROP.has(n.tagName)) return '';
			if (n.tagName === 'br') return '<br>';
			const inner = n.childNodes.map(phrase).join('');
			const tag = INLINE[n.tagName];
			return tag === 'time'
				? inner.trim()
					? `<time>${inner}</time>`
					: ''
				: inline(inner, { strong: tag === 'strong', em: tag === 'em', code: tag === 'code' });
		};
		for (const n of nodes) {
			if (n.nodeName === '#text' || ('tagName' in n && (n.tagName in INLINE || PHRASING.has(n.tagName) || n.tagName === 'br'))) {
				buffer += phrase(n);
				continue;
			}
			if (!('tagName' in n) || DROP.has(n.tagName)) continue;
			const tag = n.tagName;
			const heading = /^h([1-6])$/.exec(tag);
			if (heading) {
				flush();
				const h = n.childNodes.map(phrase).join('').trim();
				if (h) out.push({ t: 'h', level: Number(heading[1]), html: h });
			} else if (tag === 'p') {
				flush();
				buffer = n.childNodes.map(phrase).join('');
				flush();
			} else if (tag === 'pre') {
				flush();
				const t = text(n);
				if (t.trim()) out.push({ t: 'pre', text: t });
			} else if (tag === 'ul' || tag === 'ol') {
				flush();
				const items = n.childNodes
					.filter((li) => 'tagName' in li && li.tagName === 'li')
					.map((li) => ('childNodes' in li ? flow(li.childNodes) : []))
					.filter((b) => b.length > 0);
				if (items.length) out.push({ t: 'list', ordered: tag === 'ol', items });
			} else if (tag === 'table') {
				flush();
				const rows: Cell[][] = [];
				const collect = (x: Node5) => {
					if (!('tagName' in x)) return;
					if (x.tagName === 'tr')
						rows.push(
							x.childNodes
								.filter((c) => 'tagName' in c && (c.tagName === 'td' || c.tagName === 'th'))
								.map((c) => ({
									header: 'tagName' in c && c.tagName === 'th',
									colspan: span(attr(c, 'colspan')),
									rowspan: span(attr(c, 'rowspan')),
									blocks: 'childNodes' in c ? flow(c.childNodes) : []
								}))
						);
					else if (x.tagName !== 'table' || x === n) x.childNodes.forEach(collect);
				};
				collect(n);
				if (rows.some((r) => r.length > 0)) out.push({ t: 'table', rows });
			} else if (tag === 'img') {
				const m = DATA_IMAGE.exec(attr(n, 'src') ?? '');
				if (m) {
					flush();
					out.push({
						t: 'img',
						src: images.add(Buffer.from(m[2]!, 'base64'), m[1]!.toLowerCase()),
						alt: attr(n, 'alt') ?? ''
					});
				}
			} else {
				flush();
				out.push(...flow(n.childNodes));
			}
		}
		flush();
		return out;
	};
	const text = (n: Node5): string =>
		n.nodeName === '#text' && 'value' in n ? n.value : 'childNodes' in n ? n.childNodes.map(text).join('') : '';
	return flow(parse(source).childNodes);
}

// ---------- csv, tsv ----------
/** One sheet named after the file, its values typed from their text. */
export const csv = (source: string, name: string): Sheets => ({
	sheets: [sheet(name.replace(/\.[^.]*$/, ''), parseCsv(source).map((r) => r.map(typed)))]
});

// ---------- Kreuzberg: doc xls ppt rtf ----------
const Grid = Schema.Struct({
	cells: Schema.Array(
		Schema.Struct({
			content: Schema.String,
			row: Schema.Number,
			col: Schema.Number,
			row_span: Schema.Number,
			col_span: Schema.Number,
			is_header: Schema.Boolean
		})
	)
});
const KNode = Schema.Struct({
	content: Schema.Struct({
		node_type: Schema.String,
		text: Schema.optionalKey(Schema.String),
		level: Schema.optionalKey(Schema.Number),
		ordered: Schema.optionalKey(Schema.Boolean),
		number: Schema.optionalKey(Schema.Number),
		title: Schema.optionalKey(Schema.NullOr(Schema.String)),
		image_index: Schema.optionalKey(Schema.NullOr(Schema.Number)),
		grid: Schema.optionalKey(Grid)
	}),
	children: Schema.optionalKey(Schema.Array(Schema.Number)),
	parent: Schema.optionalKey(Schema.Number),
	page: Schema.optionalKey(Schema.Number),
	content_layer: Schema.optionalKey(Schema.String),
	annotations: Schema.optionalKey(
		Schema.Array(Schema.Struct({ start: Schema.Number, end: Schema.Number, kind: Schema.Unknown }))
	)
});
const KResult = Schema.Struct({
	document: Schema.NullOr(Schema.Struct({ nodes: Schema.Array(KNode) })),
	images: Schema.Array(
		Schema.Struct({
			data: Schema.Uint8Array,
			format: Schema.String,
			imageIndex: Schema.Number,
			pageNumber: Schema.optionalKey(Schema.Number)
		})
	)
});
type KNode = typeof KNode.Type;
type KResult = typeof KResult.Type;

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const Mark = Schema.Union([
	Schema.Literals(['bold', 'italic', 'code']),
	Schema.Struct({ annotation_type: Schema.Literals(['bold', 'italic', 'code']) })
]);
const mark = (kind: unknown) => {
	if (!Schema.is(Mark)(kind)) return undefined;
	const k = typeof kind === 'string' ? kind : kind.annotation_type;
	return k === 'bold' ? 'strong' : k === 'italic' ? 'em' : 'code';
};
/** A node's text with its bold, italic and code spans (offsets are UTF-8 bytes). */
function rich(node: KNode): string {
	const bytes = Buffer.from(node.content.text ?? '');
	const spans = (node.annotations ?? []).flatMap((a) => {
		const f = mark(a.kind);
		return f && a.end > a.start ? [{ f, start: a.start, end: Math.min(a.end, bytes.length) }] : [];
	});
	const points = [...new Set([0, bytes.length, ...spans.flatMap((a) => [a.start, a.end])])].sort((a, b) => a - b);
	let out = '';
	for (let i = 0; i + 1 < points.length; i++) {
		const [s, e] = [points[i]!, points[i + 1]!];
		const on = new Set(spans.filter((a) => a.start <= s && a.end >= e).map((a) => a.f));
		out += inline(escape(bytes.subarray(s, e).toString('utf8')).replace(/\r?\n/g, '<br>'), {
			strong: on.has('strong'),
			em: on.has('em'),
			code: on.has('code')
		});
	}
	return out.replace(/\t/g, ' ').trim();
}

/** Kreuzberg's document tree as blocks: one section per slide (a document is one flow), images where they stand. */
export function structure(result: KResult, kind: Kind, images: Images): Block[] {
	const placed = new Set<number>();
	const nodes = result.document?.nodes ?? [];
	const image = (index: number): Block[] => {
		const img = result.images.find((i) => i.imageIndex === index);
		const mime = img && IMAGE_MIME[img.format.toLowerCase()];
		if (!img || !mime || placed.has(index)) return [];
		placed.add(index);
		return [{ t: 'img', src: images.add(img.data, mime), alt: '' }];
	};
	const table = (grid: typeof Grid.Type): Block => {
		const rows: Cell[][] = [];
		for (const c of grid.cells) {
			(rows[c.row] ??= []).push({
				header: c.is_header,
				colspan: Math.max(1, c.col_span),
				rowspan: Math.max(1, c.row_span),
				blocks: c.content.trim() ? [{ t: 'p', html: escape(c.content.trim()).replace(/\r?\n/g, '<br>') }] : []
			});
		}
		return { t: 'table', rows: Array.from(rows, (r) => r ?? []) };
	};
	const block = (i: number): Block[] => {
		const n = nodes[i];
		if (!n || n.content_layer === 'furniture') return [];
		const c = n.content;
		const inner = () => (n.children ?? []).flatMap(block);
		switch (c.node_type) {
			case 'title':
			case 'heading': {
				const h = rich(n);
				return h ? [{ t: 'h', level: c.node_type === 'title' ? 1 : (c.level ?? 2), html: h }] : [];
			}
			case 'paragraph':
			case 'footnote':
			case 'formula':
			case 'list_item': {
				const p = rich(n);
				return p ? [{ t: 'p', html: c.node_type === 'formula' ? `<code>${p}</code>` : p }] : [];
			}
			case 'code':
				return c.text ? [{ t: 'pre', text: c.text }] : [];
			case 'list': {
				const items = (n.children ?? []).map(block).filter((b) => b.length > 0);
				return items.length ? [{ t: 'list', ordered: c.ordered ?? false, items }] : [];
			}
			case 'table':
				return c.grid ? [table(c.grid)] : [];
			case 'image':
				return c.image_index == null ? [] : image(c.image_index);
			case 'slide':
				return c.title ? [{ t: 'h', level: 2, html: escape(c.title) }, ...inner()] : inner();
			case 'page_break':
				return [];
			default:
				return inner();
		}
	};
	// Top-level nodes grouped by slide or sheet, in order.
	const groups = new Map<number, number[]>();
	let current = 1;
	nodes.forEach((n, i) => {
		if (n.parent !== undefined) return;
		current = n.page ?? (n.content.node_type === 'slide' ? n.content.number : undefined) ?? current;
		groups.set(current, [...(groups.get(current) ?? []), i]);
	});
	const sections = [...groups.keys()]
		.sort((a, b) => a - b)
		.map((n): Block & { t: 'section' } => {
			const inner = (groups.get(n) ?? []).flatMap(block);
			for (const img of result.images) if ((img.pageNumber ?? 1) === n && !placed.has(img.imageIndex)) inner.push(...image(img.imageIndex));
			return { t: 'section', kind: 'slide', n, blocks: inner };
		});
	return kind === 'document' ? sections.flatMap((b) => b.blocks) : sections;
}

/**
 * A legacy xls's sheets from Kreuzberg's grids: its cells come as text, so their types are read back from it (a date
 * stays the text Kreuzberg wrote).
 */
function sheetsOf(result: KResult): Sheets {
	const sheets: Sheet[] = [];
	let name: string | undefined;
	for (const { content: c } of result.document?.nodes ?? []) {
		if (c.node_type === 'heading') name = c.text;
		if (!c.grid) continue;
		const rows: Value[][] = [];
		const merges: Merge[] = [];
		for (const cell of c.grid.cells) {
			(rows[cell.row] ??= [])[cell.col] = typed(cell.content);
			if (cell.row_span > 1 || cell.col_span > 1) merges.push({ row: cell.row, col: cell.col, rows: cell.row_span, cols: cell.col_span });
		}
		sheets.push(sheet(name ?? `Sheet ${sheets.length + 1}`, Array.from(rows, (r) => Array.from(r ?? [], (x) => x ?? null)), merges));
		name = undefined;
	}
	return { sheets };
}

/**
 * Every Kreuzberg call's config. The published binding has OCR compiled in; Kreuzberg runs it only when a call sets `ocr`,
 * `forceOcr` or `forceOcrPages`, so no call sets any of them (`forceOcr: false` says so), nor its layout model.
 */
export const kreuzbergConfig = {
	useCache: false,
	forceOcr: false,
	includeDocumentStructure: true,
	outputFormat: 'markdown',
	images: { extractImages: true, maxImageDimension: 2000 }
} satisfies ExtractionConfig;

export type IngestOptions = {
	/** Kreuzberg reads at once on this replica: each holds its file in memory. */
	lanes: number;
	/** Audio's transcription model; absent, audio is refused before it is queued. */
	transcribe?: Transcriber;
};

export function ingester(o: IngestOptions): Ingester {
	const reads = Semaphore.makeUnsafe(o.lanes);
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
		const kreuzberg = reads.withPermits(1)(
			Effect.tryPromise({ try: () => extractBytes(request.bytes, r.mime, kreuzbergConfig), catch: failed }).pipe(
				Effect.flatMap((raw) => Schema.decodeUnknownEffect(KResult)(raw).pipe(Effect.mapError(failed)))
			)
		);
		let blocks: Block[] = [];
		let json: unknown;
		switch (r.reader) {
			case 'html':
				blocks = yield* sync(() => html(text(), images));
				break;
			case 'docx':
				blocks = yield* sync(() => docx(request.bytes, images));
				break;
			case 'pptx':
				blocks = yield* sync(() => pptx(request.bytes, images));
				break;
			case 'odf':
				blocks = yield* sync(() => odf(request.bytes, images));
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
			case 'pdf':
				blocks = yield* readPdf(request.bytes, images).pipe(Effect.mapError(failed));
				break;
			case 'kreuzberg':
				blocks = structure(yield* kreuzberg, r.kind, images);
				break;
			case 'xlsx':
				json = yield* sync(() => xlsx(request.bytes, images));
				break;
			case 'ods':
				json = yield* sync(() => ods(request.bytes, images));
				break;
			case 'xls':
				json = sheetsOf(yield* kreuzberg);
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
