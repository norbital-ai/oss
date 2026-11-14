// Ingest: the router, the one writer and its sanitiser, tables with merged and nested cells, and no OCR text.
// Fixtures are small files written by python-docx, openpyxl, python-pptx and reportlab, and LibreOffice for the
// odt, ods, odp, doc and xls copies of the same tables.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { afterAll, onTestFinished, test } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { ingester, type Ingested } from '../src/ingest.ts';
import { readTo } from '../src/job.ts';
import { ARCHIVE } from '../src/readers/archive.ts';
import { route } from '../src/route.ts';
import { service } from '../src/server.ts';
import { type Converter } from '../src/convert.ts';

setFlagsFromString('--expose-gc');
const ingest = ingester();
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

test('routes by mime type, then by extension; audio, video containers, CAD and unknown formats get an explicit answer', () => {
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
	assert.equal(ext('a.mp4', 'video/mp4'), 'mp4:audio'); // its audio track is transcribed
	const none = 'no parser for this format';
	assert.equal(ext('a.mov', 'video/quicktime'), none);
	assert.equal(ext('a.mkv', 'video/x-matroska'), none);
	assert.equal(ext('site.dwg', 'image/vnd.dwg'), none);
	assert.equal(ext('site.dxf', 'application/octet-stream'), none);
	assert.equal(ext('a.zip', 'application/zip'), 'zip:archive');
	assert.equal(ext('src.tar.gz', 'application/octet-stream'), 'tgz:archive');
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

test('legacy doc and xls read natively', async () => {
	const doc = await run('tables.doc', 'application/msword', fixture('tables.doc'));
	allowed(doc.html);
	assert.match(doc.html, /Merged cells follow/);
	const xls = await Effect.runPromise(ingest({ name: 'tables.xls', mime: 'application/vnd.ms-excel', bytes: fixture('tables.xls') }));
	assert.equal(xls.kind, 'data');
	assert.match(JSON.stringify(xls), /"Shipped"/);
});

/** A locked fixture read as its open twin is, with its password; without it, or with a wrong one, a refusal naming it. */
const opensLike = async (name: string, open: string, mime: string) => {
	const read = (file: string, password?: string) =>
		ingest({ name: file, mime, bytes: fixture(file), ...(password === undefined ? {} : { options: { password } }) });
	const why = async (password?: string) => (await Effect.runPromise(Effect.flip(read(name, password)))).message;
	assert.equal(await why(), `${name} is password-protected: read it again with its password`);
	assert.equal(await why('wrong'), `the password does not open ${name}`);
	const parse = (out: Ingested) => (out.kind === 'data' ? out.json : out.html);
	assert.deepEqual(parse(await Effect.runPromise(read(name, 'convert'))), parse(await Effect.runPromise(read(open))), name);
};
/** A zip of `files`, deflated, as any zip tool writes one. */
const zip = (files: Record<string, Uint8Array>) => {
	const u16 = (n: number) => Buffer.from([n & 255, (n >> 8) & 255]);
	const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
	const locals: Buffer[] = [], central: Buffer[] = [];
	let at = 0;
	for (const [path, bytes] of Object.entries(files)) {
		const name = Buffer.from(path), packed = deflateRawSync(bytes), crc = crc32(bytes);
		const common = [u16(8), u16(0), u16(0), u32(crc), u32(packed.length), u32(bytes.length), u16(name.length), u16(0)];
		const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x800), ...common, name, packed]);
		central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x800), ...common, u16(0), u16(0), u16(0), u32(0), u32(at), name]));
		locals.push(local);
		at += local.length;
	}
	const directory = Buffer.concat(central);
	const n = Object.keys(files).length;
	return new Uint8Array(Buffer.concat([...locals, directory, u32(0x06054b50), u16(0), u16(0), u16(n), u16(n), u32(directory.length), u32(at), u16(0)]));
};
/** A gzipped tar of one file. */
const tgz = (path: string, bytes: Uint8Array) => {
	const header = Buffer.alloc(512);
	header.write(path, 0);
	header.write('0000644\0', 100);
	header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
	header.write('0', 156);
	header.write('ustar\0', 257);
	return new Uint8Array(gzipSync(Buffer.concat([header, Buffer.from(bytes), Buffer.alloc(512 - (bytes.length % 512)), Buffer.alloc(1024)])));
};

test('an archive lists its files; an entry, on into an inner archive, reads as its own type; text without a known type is text', async () => {
	const archive = zip({
		'repo/README.md': text('# Ops portal'),
		'repo/src/app.ts': text('export const a = 1;'),
		'repo/bin.dat': new Uint8Array([0, 1, 2, 3]),
		'repo/inner.tgz': tgz('notes/todo.txt', text('ship it'))
	});
	const read = (entry?: string) =>
		Effect.runPromise(Effect.result(ingest({ name: 'repo.zip', mime: 'application/zip', bytes: archive, ...(entry === undefined ? {} : { options: { entry } }) })));
	const html = async (entry?: string) => {
		const got = await read(entry);
		if (got._tag !== 'Success' || got.success.kind !== 'document') throw new Error(`no document at ${entry}`);
		return got.success.html;
	};
	const listing = (...lines: string[]) => ['<pre>', ...lines, '</pre>'].join('\n');
	assert.equal(await html(), listing('repo/README.md  12 bytes', 'repo/src/app.ts  19 bytes', 'repo/bin.dat  4 bytes', `repo/inner.tgz  ${tgz('notes/todo.txt', text('ship it')).length} bytes`));
	assert.equal(await html('repo/src'), listing('repo/src/app.ts  19 bytes'));
	assert.equal(await html('repo/src/app.ts'), '<pre>\nexport const a = 1;\n</pre>');
	assert.equal(await html('repo/inner.tgz/notes/todo.txt'), '<pre>\nship it\n</pre>');
	assert.equal(await html('repo/inner.tgz'), listing('notes/todo.txt  7 bytes'));
	const binary = await read('repo/bin.dat');
	assert.ok(binary._tag === 'Failure' && binary.failure.message === 'bin.dat: 4 bytes, binary; no parser for this format');
	const missing = await read('repo/nope.ts');
	assert.ok(missing._tag === 'Failure' && missing.failure.message === "the archive has no 'repo/nope.ts'");
});

test('an archive is bounded: a bomb is refused by its ratio, a lying size stops at what it stated', async () => {
	const fail = async (bytes: Uint8Array, entry: string) => {
		const got = await Effect.runPromise(Effect.result(ingest({ name: 'b.zip', mime: 'application/zip', bytes, options: { entry } })));
		return got._tag === 'Failure' ? got.failure.message : 'read';
	};
	assert.equal(await fail(zip({ 'zeros.txt': new Uint8Array(64 * 1024 * 1024) }), 'zeros.txt'), `zeros.txt inflates over ${ARCHIVE.ratio} times: refused as a zip bomb`);
	// the directory says 10 bytes: the inflate stops there, whatever the data holds
	const lying = zip({ 'a.txt': text('x'.repeat(5000)) });
	const view = Buffer.from(lying.buffer, lying.byteOffset, lying.byteLength);
	view.writeUInt32LE(10, view.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
	assert.equal(await fail(new Uint8Array(view), 'a.txt'), 'a.txt unpacks past 10 bytes');
});

test('a listing reads only the directory: an entry whose data is damaged still lists, and fails only when read', async () => {
	const archive = zip({ 'ok.txt': text('fine'), 'bad.txt': text('y'.repeat(300)) });
	const view = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
	// garble bad.txt's deflate stream (its local header is the second one)
	const local = view.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 4);
	view.fill(0xff, local + 30 + 'bad.txt'.length, local + 30 + 'bad.txt'.length + 4);
	const read = (entry?: string) =>
		Effect.runPromise(Effect.result(ingest({ name: 'a.zip', mime: 'application/zip', bytes: new Uint8Array(view), ...(entry === undefined ? {} : { options: { entry } }) })));
	const listed = await read();
	assert.ok(listed._tag === 'Success' && listed.success.kind === 'document' && listed.success.html.includes('bad.txt  300 bytes'));
	const bad = await read('bad.txt');
	assert.ok(bad._tag === 'Failure' && bad.failure.message === 'bad.txt is damaged');
});

test('a large archive is read from the disk: memory stays flat whatever its size', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'convert-big-')),
		path = join(dir, 'big.zip');
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	// a 200 MiB stored entry, then a small one, written a chunk at a time
	const fd = openSync(path, 'w'),
		chunk = randomBytes(1024 * 1024),
		entries: { name: Buffer; crc: number; size: number; at: number }[] = [];
	let at = 0;
	const u16 = (n: number) => Buffer.from([n & 255, (n >> 8) & 255]);
	const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
	const put = (b: Buffer) => { writeSync(fd, b); at += b.length; };
	for (const [file, parts] of [['big.bin', 200], ['small.txt', 0]] as const) {
		const name = Buffer.from(file), body = parts === 0 ? Buffer.from('small but read') : undefined;
		let crc = 0, size = 0;
		for (let i = 0; i < parts; i++) (crc = crc32(chunk, crc)), (size += chunk.length);
		if (body) (crc = crc32(body)), (size = body.length);
		entries.push({ name, crc, size, at });
		put(Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(name.length), u16(0), name]));
		if (body) put(body);
		else for (let i = 0; i < parts; i++) put(chunk);
	}
	const directory = Buffer.concat(entries.map((e) => Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(e.crc), u32(e.size), u32(e.size), u16(e.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.at), e.name])));
	put(Buffer.concat([directory, u32(0x06054b50), u16(0), u16(0), u16(2), u16(2), u32(directory.length), u32(at), u16(0)]));
	closeSync(fd);
	const gc = runInNewContext('gc', {}, { contextName: 'gc' }) as () => void;
	const read = (entry?: string) =>
		Effect.runPromise(Effect.result(ingest({ name: 'big.zip', mime: 'application/zip', path, bytes: new Uint8Array(), ...(entry === undefined ? {} : { options: { entry } }) })));
	await read('small.txt'); // the readers' modules load once, before the baseline
	gc();
	const before = process.memoryUsage();
	const listed = await read();
	const small = await read('small.txt');
	const big = await read('big.bin'); // 200 MiB streamed to a scratch file, then named binary
	gc();
	const after = process.memoryUsage();
	const mib = (key: 'rss' | 'heapUsed' | 'external' | 'arrayBuffers') => (after[key] - before[key]) / 1024 / 1024;
	const grown = mib('rss');
	console.log(`200 MiB archive: RSS +${grown.toFixed(1)} MiB, heap +${mib('heapUsed').toFixed(1)}, external +${mib('external').toFixed(1)}, buffers +${mib('arrayBuffers').toFixed(1)}`);
	assert.ok(listed._tag === 'Success' && listed.success.kind === 'document' && listed.success.html.includes('big.bin  209,715,200 bytes'));
	assert.ok(small._tag === 'Success' && small.success.kind === 'document' && small.success.html.includes('small but read'));
	assert.ok(big._tag === 'Failure' && /over 16 MiB to read/.test(big.failure.message), big._tag === 'Failure' ? big.failure.message : '');
	// nothing is kept: the heap and buffers end where they began. RSS keeps the allocator's high-water mark of the chunks
	// in flight (a plain 200 MiB stream copy alone adds ~45 MiB on macOS), never the archive or the entry
	assert.ok(mib('heapUsed') + mib('external') < 10, `retained ${mib('heapUsed') + mib('external')} MiB`);
	assert.ok(grown < 100, `RSS grew ${grown} MiB`);
}, 60_000);


test('a locked xlsx or docx opens with its password', async () => {
	await opensLike('locked.xlsx', 'tables.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
	await opensLike('locked.docx', 'tables.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

// ---------- over HTTP ----------
const dir = mkdtempSync(join(tmpdir(), 'convert-ingest-'));
const running: { stop: () => Promise<void> }[] = [];
afterAll(async () => {
	await Promise.all(running.map((s) => s.stop()));
	rmSync(dir, { recursive: true, force: true });
});
const never: Converter = () => Effect.die('not a conversion');
async function start() {
	const svc = service({ keys: ['k1'], database: join(dir, `db-${running.length}.db`), pollMs: 20, convert: never, ingest: readTo(ingest), maxIngestBytes: 4096 });
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
		['clip.mov', 'video/quicktime', 415, 'no parser for this format'],
		['site.dwg', 'image/vnd.dwg', 415, 'no parser for this format'],
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

const poppler = spawnSync('pdftotext', ['-v']).status === 0;
const typst = spawnSync('typst', ['--version']).status === 0;
const mutool = spawnSync('mutool', ['-v']).status !== null;
test.skipIf(!poppler || !typst)('a long PDF read across page ranges keeps its pages in order', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'long-pdf-')),
		source = join(dir, 'long.typ'),
		path = join(dir, 'long.pdf');
	writeFileSync(source, '#for n in range(1, 131) [Sheet #n #pagebreak(weak: true)]');
	assert.equal(spawnSync('typst', ['compile', source, path]).status, 0);
	const text = await Effect.runPromise(
		ingester()({
			name: 'long.pdf',
			mime: 'application/pdf',
			bytes: new Uint8Array(),
			path,
			options: { pictures: false }
		})
	);
	assert.ok(text.kind === 'document');
	const pages = [...text.html.matchAll(/<section data-page="(\d+)">\n\S*Sheet (\d+)/g)];
	assert.equal(pages.length, 130);
	assert.ok(pages.every(([, page, sheet]) => page === sheet));
});
test.skipIf(!poppler || !typst)('a PDF keeps its accents, curly quotes and Greek', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'accents-pdf-')),
		source = join(dir, 'accents.typ'),
		path = join(dir, 'accents.pdf');
	writeFileSync(source, 'Façade ‘quoted’ φ 5% — naïve 中文');
	assert.equal(spawnSync('typst', ['compile', source, path]).status, 0);
	const text = await Effect.runPromise(
		ingester()({ name: 'accents.pdf', mime: 'application/pdf', bytes: new Uint8Array(), path })
	);
	assert.ok(text.kind === 'document' && text.html.includes('Façade ‘quoted’ φ 5% — naïve 中文'), text.kind === 'document' ? text.html : '');
});
test.skipIf(!poppler || !mutool)('a locked PDF opens with its password', () =>
	opensLike('locked.pdf', 'invoice.pdf', 'application/pdf')
);
test.skipIf(!poppler)('a PDF read from the disk: its text a page at a time, one page as a picture', async () => {
	const path = fileURLToPath(new URL('./fixtures/ruled.pdf', import.meta.url)),
		scan = fileURLToPath(new URL('./fixtures/scan.pdf', import.meta.url));
	const read = ingester();
	const request = { name: 'a.pdf', mime: 'application/pdf', bytes: new Uint8Array() };
	const text = await Effect.runPromise(read({ ...request, path, options: { pictures: false } }));
	assert.ok(text.kind === 'document' && /<section data-page="1">\n<h1>Schedule<\/h1>/.test(text.html) && /<table>/.test(text.html));
	const blank = await Effect.runPromise(read({ ...request, path: scan, options: { pictures: false } }));
	assert.ok(blank.kind === 'document' && blank.html.includes('No text on this page.'));
	const page = await Effect.runPromise(read({ ...request, path: scan, options: { page: 1 } }));
	assert.equal(page.images.length, 1);
	assert.equal(page.images[0]?.mime, 'image/jpeg');
	assert.ok(page.images[0]?.bytes.startsWith('/9j/'));
});
