// Plan 12: every file the agent reads is one canonical form, sanitised HTML (one block element per line) and its images,
// made by the host's ingest port (Norbital Convert): parsing only, never OCR, no reader here; audio is Convert's diarised
// transcript, and a spreadsheet, CSV or JSON is `data` (typed cells, no HTML). An image is its own `<img>` and plain text
// its own lines. This module routes a file, renders those two, derives a document's index and an audio transcript from
// its HTML, keeps the shared cache (`ingest/<sha256>/…` in the file store) and windows a stored ingest by line.
import { Effect, Option, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { IngestIndex, Transcript } from '../../decl/runtime/facilities.ts';
import type { Ingested } from '../contracts.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import type { Files } from '../ports.ts';
import { row } from '../system/rows.ts';
import { toBase64 } from '../crypto.ts';
import { size } from './context.ts';

const TEXT = /^(text\/|application\/(json|csv|xml|[\w.-]+\+(json|xml))$)/;
const dataUrl = (f: { mime: string; bytes: Uint8Array }) =>
	`data:${f.mime};base64,${toBase64(f.bytes)}`;

/** One file a tool opened as a chat part: an image as an image, text as text; anything else is read through `ingest`. */
export function filePart(f: { mime: string; bytes: Uint8Array }, name: string): Json {
	if (f.mime.startsWith('image/')) return { type: 'image_url', image_url: { url: dataUrl(f) } };
	if (TEXT.test(f.mime))
		return { type: 'text', text: `${name} (${f.mime}):\n${new TextDecoder().decode(f.bytes)}` };
	return { type: 'text', text: `${name} (${f.mime}): read it with ingest, then read_file windows` };
}
/** What a file with no parser answers (plan 12 rule 7): the agent builds one, never guesses. */
export const unparsed = (name: string, mime: string) =>
	`${name} (${mime || 'unknown type'}): no parser: build a tool for it with your workspace tools (run_js with files: [{ id }] reads its bytes); never guess what it contains.`;

const OOXML = 'application/vnd.openxmlformats-officedocument.';
const CONVERTS: ReadonlySet<string> = new Set([
	'application/pdf',
	'text/html',
	'text/csv',
	'text/tab-separated-values',
	'application/json',
	'application/rtf',
	'text/rtf',
	'application/msword',
	'application/vnd.ms-excel',
	'application/vnd.ms-powerpoint',
	`${OOXML}wordprocessingml.document`,
	`${OOXML}spreadsheetml.sheet`,
	`${OOXML}presentationml.presentation`,
	'application/vnd.oasis.opendocument.text',
	'application/vnd.oasis.opendocument.spreadsheet',
	'application/vnd.oasis.opendocument.presentation'
]);
const BY_EXTENSION: { readonly [ext: string]: Route } = {
	pdf: 'convert',
	html: 'convert',
	htm: 'convert',
	csv: 'convert',
	tsv: 'convert',
	json: 'convert',
	rtf: 'convert',
	doc: 'convert',
	docx: 'convert',
	ppt: 'convert',
	pptx: 'convert',
	xls: 'convert',
	xlsx: 'convert',
	odt: 'convert',
	ods: 'convert',
	odp: 'convert',
	txt: 'text',
	md: 'text',
	mp3: 'audio',
	m4a: 'audio',
	wav: 'audio',
	ogg: 'audio'
};
/** How a file is ingested: Convert (a document; audio as a transcript), here (an image, plain text), or not at all. */
export type Route = 'convert' | 'image' | 'text' | 'audio' | 'unsupported';
/** By media type, then (for an unnamed type) by extension. A video track has no parser; `audio/mp4` (m4a) is audio. */
export function route(mime: string, name: string): Route {
	if (CONVERTS.has(mime)) return 'convert';
	if (mime.startsWith('image/')) return 'image';
	if (mime.startsWith('audio/')) return 'audio';
	if (mime.startsWith('video/')) return 'unsupported';
	if (TEXT.test(mime)) return 'text';
	const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
	return (mime === '' || mime === 'application/octet-stream') && ext !== undefined
		? (BY_EXTENSION[ext] ?? 'unsupported')
		: 'unsupported';
}

const esc = (s: string) =>
	s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
const local = (html: string, bytes: number, images: Ingested['images'] = []): Ingested => ({
	kind: 'document',
	html,
	images,
	meta: { stats: { pages: null, bytes, cpuMs: 0, wallMs: 0 } }
});
/** Plain text as itself: each line one paragraph, so line n of the HTML is line n of the file. */
export const textIngest = (bytes: Uint8Array): Ingested =>
	local(
		new TextDecoder()
			.decode(bytes)
			.split(/\r?\n/)
			.map((line) => `<p>${esc(line)}</p>`)
			.join('\n'),
		bytes.length
	);
/** An image as one reference to itself: the model reads its pixels. */
export function imageIngest(file: { name: string; mime: string; bytes: Uint8Array }): Ingested {
	const name = `image-1.${file.mime.split('/')[1]?.replace(/\W.*$/, '') || 'png'}`;
	return local(`<img src="${name}" alt="${esc(file.name)}">`, file.bytes.length, [
		{ name, mime: file.mime, bytes: file.bytes }
	]);
}

// ── what the HTML holds ──
const attr = (line: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(line)?.[1];
export const plain = (html: string) =>
	html
		.replace(/<[^>]+>/g, '')
		.replace(
			/&(amp|lt|gt|quot);/g,
			(_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[e] ?? ''
		);
const SECTION = /^<section data-(page|slide|speaker)="([^"]*)"/;
/** A document's index from its HTML: lines, page and slide counts, outline with line ranges, tables and image names. */
export function indexOf(html: string): IngestIndex {
	const lines = html.split('\n'),
		spans = blocks(lines),
		outline: { title: string; level: number; from: number; to: number }[] = [];
	let pages = 0,
		slides = 0,
		tables = 0,
		speaker: string | undefined;
	lines.forEach((line, i) => {
		tables += line.match(/<table\b/g)?.length ?? 0;
		const h = /^<h([1-6])>(.*)<\/h\1>$/.exec(line);
		if (h !== null) {
			speaker = undefined;
			outline.push({ title: plain(h[2]!), level: Number(h[1]), from: i + 1, to: lines.length });
			return;
		}
		const s = SECTION.exec(line);
		if (s === null) return;
		const [, kind, value] = s,
			to = spans[i]?.[1] ?? i + 1;
		if (kind === 'page') pages++;
		if (kind === 'slide') slides++;
		// a speaker's consecutive segments are one entry
		const last = outline.at(-1);
		if (kind === 'speaker' && speaker === value && last !== undefined) {
			last.to = to;
			return;
		}
		speaker = kind === 'speaker' ? value : undefined;
		outline.push({
			title:
				kind === 'speaker'
					? `${value} ${/<time>([^<]*)<\/time>/.exec(line)?.[1] ?? ''}`.trim()
					: `${kind === 'page' ? 'Page' : 'Slide'} ${value}`,
			level: 7,
			from: i + 1,
			to
		});
	});
	// a heading runs to the line before the next heading at its level or above
	outline.forEach((o, k) => {
		if (o.level === 7) return;
		const next = outline.find((x, j) => j > k && x.level <= o.level);
		if (next !== undefined) o.to = next.from - 1;
	});
	return {
		lines: lines.length,
		pages,
		slides,
		outline,
		tables,
		images: [...new Set([...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!))]
	};
}
/** An audio ingest's transcript from its speaker sections (none: not a recording); its length is the last segment's end. */
export function transcriptOf(html: string): Transcript | undefined {
	const segments = html.split('\n').flatMap((line) => {
		const speaker = line.startsWith('<section ') ? attr(line, 'data-speaker') : undefined;
		if (speaker === undefined) return [];
		return [
			{
				speaker: plain(speaker),
				start: Number(attr(line, 'data-start') ?? 0),
				end: Number(attr(line, 'data-end') ?? 0),
				text: plain(line.replace(/<time>[^<]*<\/time>/, '')).trim()
			}
		];
	});
	const last = segments.at(-1);
	return last === undefined
		? undefined
		: {
				durationMs: Math.round(last.end * 1000),
				speakers: [...new Set(segments.map((s) => s.speaker))],
				segments
			};
}
const clock = (seconds: number) =>
	[Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, Math.floor(seconds) % 60]
		.map((n) => String(n).padStart(2, '0'))
		.join(':');

// ── the cache: `ingest/<sha256>/…` in the file store, shared by every conversation ──
const Stored = row('sys_file', ['id', 'name', 'mime', 'size', 'key']);
export type StoredFile = typeof Stored.Type;
const IndexJson = Schema.fromJsonString(
	Schema.Struct({
		lines: Schema.Number,
		pages: Schema.Number,
		slides: Schema.Number,
		outline: Schema.Array(
			Schema.Struct({
				title: Schema.String,
				level: Schema.Number,
				from: Schema.Number,
				to: Schema.Number
			})
		),
		tables: Schema.Number,
		images: Schema.Array(Schema.String)
	})
);
/** A stored ingest's files may be large; one read answers at most this many bytes. */
export const INGEST_BYTES = 256 * 1024 * 1024;
const prefix = (sha256: string) => `ingest/${sha256}/`;
/**
 * A stored ingest and every file it holds (paths below `ingest/<sha256>/`): a document's `main` file is its HTML, with
 * its index; a data ingest's is its `data.json`.
 */
export type Stash =
	| { kind: 'document'; main: StoredFile; index: IngestIndex; files: readonly StoredFile[] }
	| { kind: 'data'; main: StoredFile; files: readonly StoredFile[] };
/** A complete earlier ingest of the same bytes (a document's `index.json`, a data ingest's `data.json`, is written last), or none. */
export const cached = Effect.fn('Agents.ingestCached')(function* (
	db: TenantDbShape,
	files: Files['Service'],
	sha256: string
) {
	// ponytail: a prefix scan on sys_file.name; an index on (field, name) when ingests grow
	const rows = yield* db.rows(Stored, {
		text: `SELECT id, name, mime, size, key FROM sys_file WHERE field = 'sys_conversation.outputs' AND starts_with(name, $1) ORDER BY created_at`,
		params: [prefix(sha256)]
	});
	const byPath = new Map(rows.map((r) => [r.name.slice(prefix(sha256).length), r]));
	const all = [...byPath.values()],
		index = byPath.get('index.json'),
		html = all.find((r) => r.mime === 'text/html');
	if (index !== undefined && html !== undefined) {
		const decoded = Schema.decodeUnknownOption(IndexJson)(
			new TextDecoder().decode(yield* files.get(index.key, index.size))
		);
		if (Option.isSome(decoded))
			return { kind: 'document', main: html, index: decoded.value, files: all } satisfies Stash;
	}
	const data = byPath.get('data.json');
	return data === undefined
		? undefined
		: ({ kind: 'data', main: data, files: all } satisfies Stash);
});
/**
 * Stores an ingest under `ingest/<sha256>/`. A document: its HTML, images, a recording's `transcript.json` (for run_js),
 * then its `index.json` (which makes it complete). Data: its images, then `data.json` (the JSON as Convert answered it).
 */
export const stash = Effect.fn('Agents.ingestStash')(function* (
	db: TenantDbShape,
	files: Files['Service'],
	o: { sha256: string; base: string; member: string | null; now: string },
	ingested: Ingested
) {
	const put = Effect.fn('Agents.ingestPut')(function* (
		path: string,
		mime: string,
		bytes: Uint8Array
	) {
		const blob = yield* files.put(bytes, { name: path.split('/').pop() ?? path, mime });
		const file = {
			id: globalThis.crypto.randomUUID(),
			name: `${prefix(o.sha256)}${path}`,
			mime,
			size: bytes.length,
			key: blob.key
		};
		yield* db.write({
			text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at, created_by)
			VALUES ($1, $2, $3, $4, $5, $6, 'sys_conversation.outputs', $7::timestamptz, $8)`,
			params: [file.id, file.name, mime, file.size, blob.key, blob.sha256, o.now, o.member]
		});
		return file;
	});
	const json = (name: string, value: unknown) =>
		put(name, 'application/json', new TextEncoder().encode(JSON.stringify(value)));
	if (ingested.kind === 'data') {
		const images = yield* Effect.forEach(ingested.images, (image) =>
			put(`images/${image.name}`, image.mime, image.bytes)
		);
		const data = yield* json('data.json', ingested.json);
		return { kind: 'data', main: data, files: [...images, data] } satisfies Stash;
	}
	const html = yield* put(`${o.base}.html`, 'text/html', new TextEncoder().encode(ingested.html));
	const images = yield* Effect.forEach(ingested.images, (image) =>
		put(`images/${image.name}`, image.mime, image.bytes)
	);
	const heard = transcriptOf(ingested.html);
	const transcript = heard === undefined ? [] : [yield* json('transcript.json', heard)];
	const index = indexOf(ingested.html);
	const indexFile = yield* json('index.json', index);
	return {
		kind: 'document',
		main: html,
		index,
		files: [html, ...images, ...transcript, indexFile]
	} satisfies Stash;
});
/** An output entry's file list: each stored file by its path below the ingest, the reference a file field takes. */
export const entryFiles = (files: readonly StoredFile[]): Json =>
	files.map((f) => ({
		id: f.id,
		name: f.name.replace(/^ingest\/[^/]+\//, ''),
		mime: f.mime,
		size: f.size
	}));

// ── windows ──
/** One answer's lines: within the ~64 KB tool bound with room for its envelope. */
export const WINDOW_BYTES = 56 * 1024;
/** Images a window shows at most. */
export const WINDOW_IMAGES = 8;
const OPENS = /<(table|section)\b/gi,
	CLOSES = /<\/(table|section)>/gi;
/** Each line's outermost `<table>` or `<section>` as its [first, last] line (1-based), or undefined outside one. */
export function blocks(lines: readonly string[]): ([number, number] | undefined)[] {
	const out: ([number, number] | undefined)[] = new Array(lines.length).fill(undefined);
	let depth = 0,
		start = 0;
	lines.forEach((line, i) => {
		const opens = line.match(OPENS)?.length ?? 0;
		if (depth === 0 && opens === 0) return;
		if (depth === 0) start = i + 1;
		depth = Math.max(0, depth + opens - (line.match(CLOSES)?.length ?? 0));
		if (depth === 0) for (let k = start; k <= i + 1; k++) out[k - 1] = [start, i + 1];
	});
	// an element never closed runs to the end
	if (depth > 0) for (let k = start; k <= lines.length; k++) out[k - 1] = [start, lines.length];
	return out;
}
/**
 * Lines `from`–`to` within `bytes`, never cutting a table or section: a window starting inside one starts at its open,
 * one ending inside it runs to its close, and one that has no room for it stops before it. Only a lone block larger
 * than the bound is cut (the rest follows from `next`).
 */
export function window(html: string, from = 1, to = Number.MAX_SAFE_INTEGER, bytes = WINDOW_BYTES) {
	const all = html.split('\n'),
		spans = blocks(all),
		last = Math.min(all.length, Math.max(1, Math.trunc(to) || all.length));
	let first = Math.min(all.length, Math.max(1, Math.trunc(from) || 1));
	first = spans[first - 1]?.[0] ?? first;
	const lines: string[] = [];
	let used = 0,
		n = first;
	const cost = (k: number) => size(`${k}: ${all[k - 1]}`);
	while (n <= last) {
		const span = spans[n - 1];
		const end = span !== undefined && span[0] === n ? span[1] : n;
		let block = 0;
		for (let k = n; k <= end; k++) block += cost(k);
		if (used + block > bytes) {
			if (lines.length > 0) break;
			// a lone block over the bound: as much of it as fits
			for (let k = n; k <= end && (lines.length === 0 || used + cost(k) <= bytes); k++) {
				lines.push(`${k}: ${all[k - 1]}`);
				used += cost(k);
			}
			break;
		}
		for (let k = n; k <= end; k++) lines.push(`${k}: ${all[k - 1]}`);
		used += block;
		n = end + 1;
	}
	const end = first + lines.length - 1;
	return {
		total: all.length,
		from: first,
		to: end,
		lines,
		...(end < all.length ? { next: end + 1 } : {})
	};
}
/** The lines holding `text` (case-insensitive), in `workspace_search`'s line shape: a line inside a table or section names it whole. */
export function grep(html: string, text: string, limit: number) {
	const all = html.split('\n'),
		spans = blocks(all),
		want = text.toLowerCase(),
		hits: { from: number; to: number; text: string }[] = [];
	let total = 0;
	all.forEach((line, i) => {
		if (!line.toLowerCase().includes(want) || ++total > limit) return;
		const span = spans[i] ?? [i + 1, i + 1];
		hits.push({ from: span[0], to: span[1], text: line.trim().slice(0, 300) });
	});
	return { total, hits };
}
/** The images a window's lines reference (`<img src="name">`), in order, each once. */
export const imagesIn = (lines: readonly string[], names: readonly string[]) => {
	const known = new Set(names);
	return [
		...new Set(
			lines.flatMap((l) => [...l.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!))
		)
	].filter((name) => known.has(name));
};

// ── the steering message ──
const n = (v: number) => v.toLocaleString('en-US');
const plural = (v: number, one: string) => `${n(v)} ${one}${v === 1 ? '' : 's'}`;
/** The finished document's counts in one line: its length (a recording's time and speakers), lines, images and tables. */
export function summary(index: IngestIndex, transcript: Transcript | undefined): string {
	return [
		transcript !== undefined
			? `${clock(transcript.durationMs / 1000)} · ${plural(transcript.speakers.length, 'speaker')}`
			: index.pages > 0
				? `${n(index.pages)} pages`
				: index.slides > 0
					? `${n(index.slides)} slides`
					: undefined,
		`${n(index.lines)} lines`,
		index.images.length === 0 ? undefined : `${n(index.images.length)} images`,
		index.tables === 0 ? undefined : `${n(index.tables)} tables`
	]
		.filter((p) => p !== undefined)
		.join(' · ');
}
const Sheets = Schema.Struct({
	sheets: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			columns: Schema.Array(Schema.String),
			rows: Schema.Array(Schema.Array(Schema.Json)),
			images: Schema.optionalKey(
				Schema.Array(Schema.Struct({ name: Schema.String, row: Schema.Number, col: Schema.Number }))
			)
		})
	)
});
/** A data ingest at a glance: per sheet its name, columns, row count, first rows and image anchors; other JSON, its start. */
export function dataSummary(json: Json): Json {
	const data = Schema.decodeUnknownOption(Sheets)(json);
	if (Option.isNone(data)) {
		const text = JSON.stringify(json);
		return { json: text.length > 2000 ? `${text.slice(0, 2000)}…` : text, bytes: text.length };
	}
	return data.value.sheets.map((sheet) => ({
		name: sheet.name,
		columns: sheet.columns,
		rows: sheet.rows.length,
		first: sheet.rows.slice(0, 5),
		...(sheet.images === undefined || sheet.images.length === 0 ? {} : { images: sheet.images })
	}));
}
/** A data ingest in one line: its sheets with their row counts, or a JSON value's size. */
export function dataLine(json: Json): string {
	const data = Schema.decodeUnknownOption(Sheets)(json);
	return Option.isNone(data)
		? `a JSON value (${n(JSON.stringify(json).length)} bytes)`
		: data.value.sheets.map((s) => `${s.name} (${plural(s.rows.length, 'row')})`).join(' · ');
}
/** The outline as a map with line ranges: top sections, their next level in parentheses, within about 1.5 KB. */
export function outlineMap(index: IngestIndex): string {
	if (index.outline.length === 0) return `L1–${n(index.lines)}`;
	const top = Math.min(...index.outline.map((o) => o.level));
	const range = (o: { from: number; to: number }) => `L${n(o.from)}–${n(o.to)}`;
	const parts: string[] = [];
	let length = 0;
	for (const [i, o] of index.outline.entries()) {
		if (o.level !== top) continue;
		const next = index.outline.findIndex((x, k) => k > i && x.level === top);
		const subs = index.outline
			.slice(i + 1, next === -1 ? undefined : next)
			.filter((x) => x.level === top + 1)
			.map((x) => `${x.title} ${range(x)}`);
		const part = `${range(o)} ${o.title}${subs.length === 0 ? '' : ` (${subs.join(', ')})`}`;
		if (length + part.length > 1500) {
			parts.push('…');
			break;
		}
		parts.push(part);
		length += part.length + 3;
	}
	return parts.join(' · ');
}
