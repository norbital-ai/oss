// Ingest: the router, the one writer and its sanitiser, tables with merged and nested cells, and no OCR text.
// Fixtures are small files written by python-docx, openpyxl, python-pptx and reportlab, and LibreOffice for the
// odt, ods, odp, doc and xls copies of the same tables.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, test } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { __resetBindingForTests, __setBindingForTests } from '@kreuzberg/node';
import { ingester, route } from '../src/ingest.ts';
import { service } from '../src/server.ts';
import { type Converter } from '../src/convert.ts';

const ingest = ingester({ lanes: 2 });
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
/** A document's result (a dataset fails the test). */
const run = async (name: string, mime: string, bytes: Uint8Array) => {
	const out = await Effect.runPromise(ingest({ name, mime, bytes }));
	if (out.kind !== 'document') throw new Error(`${name} is no document`);
	return out;
};
const text = (s: string) => new TextEncoder().encode(s);

/** The wire result: the parse (a document's `html` or a dataset's `json`, and `images`) and the job's `meta`. */
const Images = Schema.Array(Schema.Struct({ name: Schema.String, mime: Schema.String, bytes: Schema.String }));
const Meta = Schema.Struct({
	usage: Schema.optionalKey(Schema.Unknown),
	stats: Schema.Struct({ pages: Schema.NullOr(Schema.Number), bytes: Schema.Number, cpuMs: Schema.Number, wallMs: Schema.Number })
});
const Result = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('document'), html: Schema.String, images: Images, meta: Meta }),
	Schema.Struct({ kind: Schema.Literal('data'), json: Schema.Unknown, images: Images, meta: Meta })
]);
const tableCount = (html: string) => html.split('\n').filter((l) => l === '<table>').length;

/** Every tag is an allowed one with only its allowed attributes, and every line holds at most one block. */
function allowed(html: string) {
	const CELL = ['colspan', 'rowspan'];
	const ATTRS: Record<string, string[]> = { td: CELL, th: CELL, img: ['src', 'alt'] };
	const TAGS = /^(h[1-6]|p|ul|ol|li|table|thead|tbody|tr|th|td|pre|code|br|strong|em|time|img|section)$/;
	for (const m of html.matchAll(/<\/?([a-z0-9]+)([^>]*)>/g)) {
		assert.match(m[1]!, TAGS, m[0]);
		const names = [...m[2]!.matchAll(/([a-z-]+)="/g)].map((a) => a[1]!);
		const ok = m[1] === 'section' ? names.every((n) => /^data-(page|slide|speaker|start|end)$/.test(n)) : names.every((n) => ATTRS[m[1]!]?.includes(n));
		assert.ok(ok, m[0]);
	}
	let inPre = false;
	for (const line of html.split('\n')) {
		if (line === '<pre>') inPre = true;
		else if (line === '</pre>') inPre = false;
		else if (!inPre) assert.ok((line.match(/<(h[1-6]|p|li|tr|td|th|table|section|ul|ol|thead|tbody|img)[ >]/g) ?? []).length <= 1, line);
	}
}

test('routes by mime type, then by extension; audio, video, CAD and unknown formats get an explicit answer', () => {
	const ext = (name: string, mime: string) => {
		const r = route(name, mime);
		return r.ok ? `${r.ext}:${r.kind}` : r.message;
	};
	assert.equal(ext('a.pdf', 'application/pdf'), 'pdf:pdf');
	assert.equal(ext('a', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx:document');
	assert.equal(ext('a', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'xlsx:sheets');
	assert.equal(ext('a', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'), 'pptx:slides');
	assert.equal(ext('a', 'application/vnd.oasis.opendocument.text'), 'odt:document');
	assert.equal(ext('a', 'application/vnd.oasis.opendocument.spreadsheet'), 'ods:sheets');
	assert.equal(ext('a', 'application/vnd.oasis.opendocument.presentation'), 'odp:slides');
	assert.equal(ext('a', 'application/msword'), 'doc:document');
	assert.equal(ext('a', 'application/vnd.ms-excel'), 'xls:sheets');
	assert.equal(ext('a', 'application/vnd.ms-powerpoint'), 'ppt:slides');
	assert.equal(ext('a', 'text/rtf'), 'rtf:document');
	assert.equal(ext('a', 'text/html; charset=utf-8'), 'html:document');
	assert.equal(ext('a', 'text/plain'), 'txt:text');
	assert.equal(ext('a', 'text/csv'), 'csv:sheets');
	assert.equal(ext('a.tsv', 'text/tab-separated-values'), 'tsv:sheets');
	assert.equal(ext('a', 'application/json'), 'json:sheets');
	assert.equal(ext('a', 'image/jpeg'), 'jpg:image');
	assert.equal(ext('scan.PNG', 'application/octet-stream'), 'png:image');
	assert.equal(ext('rates.xls', ''), 'xls:sheets');
	assert.equal(ext('a.mp3', 'audio/mpeg'), 'mp3:audio');
	assert.equal(ext('meeting.m4a', 'application/octet-stream'), 'm4a:audio');
	assert.equal(ext('note.webm', 'audio/webm'), 'webm:audio');
	assert.equal(ext('a.mp4', 'video/mp4'), 'mp4:audio'); // probed for a video track before it is queued
	const none = 'no parser: build a tool for it with your workspace tools';
	assert.equal(ext('a.mov', 'video/quicktime'), none);
	assert.equal(ext('a.mkv', 'video/x-matroska'), none);
	assert.equal(ext('site.dwg', 'image/vnd.dwg'), none);
	assert.equal(ext('site.dxf', 'application/octet-stream'), none);
	assert.equal(ext('a.zip', 'application/zip'), none);
	assert.equal(ext('a.pdf', 'application/x-unknown'), none);
});

test('the sanitiser keeps only allowed elements and attributes and drops empty wrappers', async () => {
	const out = await run(
		'page.html',
		'text/html',
		text(`<html><head><title>T</title><style>p{color:red}</style><script>alert(1)</script></head>
<body class="x"><div><div><h2 style="color:red" onclick="x()">Scope <font color="red">and</font> terms</h2></div>
<p class="lead">Read <b>this</b> and <i>that</i> <span></span><strong> </strong><a href="javascript:x()">link</a>.<br>Next</p>
<span></span><div></div><p></p><iframe src="https://x"></iframe><img src="https://tracker/x.gif">
<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" alt="dot">
<ul><li>one</li><li><p>two</p><p>more</p></li></ul><pre>a  b
  c</pre><p>At <time datetime="2026">noon</time> &amp; <script>x</script>&lt;tag&gt;</p></div></body></html>`)
	);
	allowed(out.html);
	assert.deepEqual(out.html.split('\n'), [
		'<h2>Scope and terms</h2>',
		'<p>Read <strong>this</strong> and <em>that</em>  link.<br>Next</p>',
		'<img src="image-1.png" alt="dot">',
		'<ul>',
		'<li>one</li>',
		'<li>',
		'<p>two</p>',
		'<p>more</p>',
		'</li>',
		'</ul>',
		'<pre>',
		'a  b',
		'  c',
		'</pre>',
		'<p>At <time>noon</time> &amp; &lt;tag&gt;</p>'
	]);
	assert.deepEqual(out.images.map((i) => [i.name, i.mime]), [['image-1.png', 'image/png']]);
	assert.deepEqual(Object.keys(out), ['kind', 'html', 'images', 'meta']);
});

const MERGED = [
	'<tr>',
	/<t[dh] rowspan="2">Item<\/t[dh]>/,
	/<t[dh] colspan="2">Quantity<\/t[dh]>/,
	'</tr>',
	'<tr>',
	/<t[dh]>Ordered<\/t[dh]>/,
	/<t[dh]>Shipped<\/t[dh]>/,
	'</tr>'
];
const NESTED = ['<td>North</td>', '<td>', '<table>', '<tbody>', '<tr>', '<td>n1</td>', '<td>n2</td>', '</tr>'];
/** The lines of `html` contain `expected` as consecutive lines. */
function holds(html: string, expected: (string | RegExp)[]) {
	const lines = html.split('\n');
	const at = lines.findIndex((_, i) => expected.every((e, j) => (typeof e === 'string' ? lines[i + j] === e : e.test(lines[i + j] ?? ''))));
	assert.ok(at >= 0, `missing ${expected.join(' ')} in\n${html}`);
}

test('tables keep merged cells and nested tables: docx, odt, html', async () => {
	const html = `<table><tr><th rowspan="2">Item</th><th colspan="2">Quantity</th></tr><tr><th>Ordered</th><th>Shipped</th></tr>
<tr><td>Cable</td><td>10</td><td>8</td></tr></table><table><tr><td>Zone</td><td>Detail</td></tr>
<tr><td>North</td><td><table><tr><td>n1</td><td>n2</td></tr></table></td></tr></table>`;
	for (const [name, mime, bytes] of [
		['tables.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fixture('tables.docx')],
		['tables.odt', 'application/vnd.oasis.opendocument.text', fixture('tables.odt')],
		['tables.html', 'text/html', text(html)]
	] as const) {
		const out = await run(name, mime, bytes);
		allowed(out.html);
		holds(out.html, MERGED);
		holds(out.html, NESTED);
		assert.equal(tableCount(out.html), 3, name);
	}
});

test('slides keep merged cells, one section each: pptx, odp; sheets are data, not HTML', async () => {
	for (const [name, mime, tag] of [
		['tables.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'slide'],
		['tables.odp', 'application/vnd.oasis.opendocument.presentation', 'slide']
	] as const) {
		const out = await run(name, mime, fixture(name));
		allowed(out.html);
		holds(out.html, MERGED);
		assert.equal(out.html.split('\n')[0], `<section data-${tag}="1">`, name);
		assert.equal(out.html.split('\n').at(-1), '</section>');
		assert.equal(out.meta.stats.pages, 1);
	}
	for (const [name, mime] of [
		['tables.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
		['tables.ods', 'application/vnd.oasis.opendocument.spreadsheet']
	] as const) {
		const out = await Effect.runPromise(ingest({ name, mime, bytes: fixture(name) }));
		assert.deepEqual([out.kind, Object.keys(out)], ['data', ['kind', 'json', 'images', 'meta']], name);
		assert.equal(out.meta.stats.pages, 1);
	}
});

test('txt is its text in <pre>, an image one <img> returned in images', async () => {
	const txt = await run('notes.txt', 'text/plain', text('line <1>\n  line 2\n'));
	assert.equal(txt.html, '<pre>\nline &lt;1&gt;\n  line 2\n</pre>');
	assert.equal(txt.meta.stats.pages, null);
	const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
	const image = await run('dot.png', 'image/png', png);
	assert.equal(image.html, '<img src="image-1.png" alt="dot.png">');
	assert.deepEqual(image.images, [{ name: 'image-1.png', mime: 'image/png', bytes: png.toString('base64') }]);
});

test('a scanned page is only its image: no text, no OCR', async () => {
	const scan = await run('scan.pdf', 'application/pdf', fixture('scan.pdf'));
	assert.deepEqual(scan.html.split('\n'), ['<section data-page="1">', '<img src="image-1.png" alt="">', '</section>']);
	assert.equal(scan.images[0]?.mime, 'image/png');
	assert.equal(scan.meta.stats.pages, 1);
	const ruled = await run('ruled.pdf', 'application/pdf', fixture('ruled.pdf'));
	allowed(ruled.html);
	assert.match(ruled.html, /R-006/);
	assert.equal(ruled.meta.stats.pages, 1);
});

test('a PDF never reaches Kreuzberg; no Kreuzberg call ever sets an OCR option or the layout model', async () => {
	const seen: unknown[] = [];
	__setBindingForTests({
		extractBytes: (_bytes: Uint8Array, _mime: string, config: unknown) => {
			seen.push(config);
			return Promise.reject(new Error('spy'));
		}
	});
	try {
		await run('ruled.pdf', 'application/pdf', fixture('ruled.pdf'));
		for (const [name, mime] of [
			['a.doc', 'application/msword'],
			['a.xls', 'application/vnd.ms-excel'],
			['a.ppt', 'application/vnd.ms-powerpoint'],
			['a.rtf', 'application/rtf']
		] as const)
			await Effect.runPromise(Effect.flip(ingest({ name, mime, bytes: text('x') })));
	} finally {
		__resetBindingForTests();
	}
	assert.equal(seen.length, 4);
	for (const config of seen) {
		assert.ok(typeof config === 'object' && config !== null);
		assert.ok(!('ocr' in config) && !('forceOcrPages' in config) && !('layout' in config), JSON.stringify(config));
		assert.ok('forceOcr' in config && config.forceOcr === false);
	}
});

test('legacy doc and xls read natively', async () => {
	const doc = await run('tables.doc', 'application/msword', fixture('tables.doc'));
	allowed(doc.html);
	assert.match(doc.html, /Merged cells follow/);
	const xls = await Effect.runPromise(ingest({ name: 'tables.xls', mime: 'application/vnd.ms-excel', bytes: fixture('tables.xls') }));
	assert.equal(xls.kind, 'data');
	assert.match(JSON.stringify(xls), /"Shipped"/);
});

// ---------- over HTTP ----------
const dir = mkdtempSync(join(tmpdir(), 'convert-ingest-'));
const running: { stop: () => Promise<void> }[] = [];
afterAll(() => Promise.all(running.map((s) => s.stop())));
const never: Converter = () => Effect.die('not a conversion');
async function start() {
	const svc = service({ keys: ['k1'], database: join(dir, `db-${running.length}.db`), pollMs: 20, convert: never, ingest, maxIngestBytes: 4096 });
	running.push(svc);
	await new Promise<void>((r) => svc.server.listen(0, r));
	const address = svc.server.address();
	if (address === null || typeof address === 'string') throw new Error('no TCP address');
	return (path: string, body: object | string) =>
		fetch(`http://localhost:${address.port}${path}`, {
			method: body === '' ? 'GET' : 'POST',
			headers: { authorization: 'Bearer k1', 'content-type': 'application/json' },
			...(body === '' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
		});
}

test('POST /v1/ingest streams the job, then the ingest; unsupported files are refused before queueing', async () => {
	const call = await start();
	const res = await call('/v1/ingest', { name: 'notes.txt', mime: 'text/plain', bytes: Buffer.from('hello').toString('base64') });
	assert.equal(res.headers.get('content-type'), 'text/event-stream');
	const events = (await res.text()).split('\n\n').filter((e) => e.startsWith('event: '));
	assert.deepEqual([...new Set(events.map((e) => e.split('\n')[0]))], ['event: job', 'event: result']);
	assert.match(events.at(-2)!, /"state":"succeeded","to":"ingest"/);
	const result = Schema.decodeUnknownSync(Schema.fromJsonString(Result))(events.at(-1)!.split('data: ')[1]);
	assert.deepEqual(result.kind === 'document' && result.html, '<pre>\nhello\n</pre>');
	assert.equal(result.meta.stats.bytes, 5);

	for (const [name, mime, status, message] of [
		['clip.mov', 'video/quicktime', 415, 'no parser: build a tool for it with your workspace tools'],
		['site.dwg', 'image/vnd.dwg', 415, 'no parser: build a tool for it with your workspace tools'],
		['call.mp3', 'audio/mpeg', 503, 'this converter has no transcription model']
	] as const) {
		const refused = await call('/v1/ingest', { name, mime, bytes: 'AAAA' });
		assert.equal(refused.status, status);
		assert.deepEqual(await refused.json(), { error: status === 415 ? 'unsupported' : 'unavailable', message });
	}
	assert.equal((await call('/v1/ingest', { name: 'x.txt', mime: 'text/plain' })).status, 400);
	assert.equal((await call('/v1/ingest', { name: 'x.txt', mime: 'text/plain', bytes: 'A'.repeat(5000) })).status, 413);
});

test('POST /v1/jobs takes an ingest too: 202, then the result as JSON', async () => {
	const call = await start();
	const job = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String, to: Schema.String }))(
		await (await call('/v1/jobs', { op: 'ingest', name: 'a.csv', mime: 'text/csv', bytes: Buffer.from('a,b').toString('base64') })).json()
	);
	assert.equal(job.to, 'ingest');
	await (await call(`/v1/jobs/${job.id}/events`, '')).text();
	const out = await call(`/v1/jobs/${job.id}/result`, '');
	assert.equal(out.headers.get('content-type'), 'application/json');
	const result = Schema.decodeUnknownSync(Result)(await out.json());
	assert.deepEqual(result.kind === 'data' && result.json, { sheets: [{ name: 'a', columns: ['A', 'B'], rows: [['a', 'b']] }] });
});
