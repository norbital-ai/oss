// PDF tables from geometry (ruled, merged, nested, unruled, page-spanning, invoice-like; reportlab fixtures), pictures
// turned as shown, every word of the text layer exactly once, and spreadsheets' typed cells (openpyxl, recalculated and
// saved by LibreOffice).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { test } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { ingester } from '../src/ingest.ts';
import { order, stream } from '../src/readers/pdf.ts';
import type { Word } from '../src/readers/trace.ts';
import { parseCsv, serialDate, typed } from '../src/sheets.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const ingest = ingester();
const pdf = async (name: string, bytes: Uint8Array = fixture(name)) => {
	const out = await Effect.runPromise(ingest({ name, mime: 'application/pdf', bytes }));
	if (out.kind !== 'document') throw new Error(`${name} is no document`);
	return out;
};
const Value = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);
const Sheets = Schema.Struct({
	sheets: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			columns: Schema.Array(Schema.String),
			rows: Schema.Array(Schema.Array(Value)),
			merges: Schema.optionalKey(Schema.Array(Schema.Struct({ row: Schema.Number, col: Schema.Number, rows: Schema.Number, cols: Schema.Number })))
		})
	)
});
/** The `<table>` blocks of `html`, each as its lines. */
const tablesOf = (html: string) => {
	const out: string[][] = [];
	let depth = 0;
	for (const line of html.split('\n')) {
		if (line === '<table>' && depth++ === 0) out.push([]);
		if (depth > 0) out.at(-1)!.push(line);
		if (line === '</table>') depth--;
	}
	return out;
};
const row = (...cells: string[]) => ['<tr>', ...cells, '</tr>'];
const td = (...texts: string[]) => texts.map((t) => (t ? `<td>${t}</td>` : '<td></td>'));
const table = (...rows: string[][]) => ['<table>', '<tbody>', ...rows.flat(), '</tbody>', '</table>'];
const counted = (text: string) => {
	const m = new Map<string, number>();
	for (const w of text.match(/[\p{L}\p{N}]+/gu) ?? []) m.set(w, (m.get(w) ?? 0) + 1);
	return [...m].sort();
};
const unescape = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&(amp|lt|gt|quot);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[e]!);
/** Every word of the PDF's text layer is in the HTML exactly as often: none dropped, none doubled. */
function sameWords(name: string, html: string) {
	const layer = execFileSync('pdftotext', ['-q', fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), '-']).toString('utf8');
	assert.deepEqual(counted(unescape(html)), counted(layer), name);
}
const FIXTURES = ['ruled', 'unruled', 'merged', 'nested', 'spanning', 'invoice', 'straddle', 'rotated-table', 'rotated-image', 'rotated-scan', 'scan'];

test('every word of every PDF fixture comes out exactly once', async () => {
	for (const f of FIXTURES) sameWords(`${f}.pdf`, (await pdf(`${f}.pdf`)).html);
});

test('ruled and unruled PDF tables come out cell-exact, in place', async () => {
	const rate = (n: number, word: string) => td(`R-00${n}`, `Item ${n} ${word}`, `${n * 3}.00`);
	const body = (words: string[]) => [row(...td('Code', 'Description', 'Rate')), ...words.map((w, i) => row(...rate(i + 1, w)))];
	for (const [name, rows] of [
		['ruled.pdf', body(['lambda', 'epsilon', 'tau', 'beta', 'gamma', 'cable'])],
		['unruled.pdf', body(['epsilon', 'kappa', 'omega', 'epsilon', 'cable', 'delta'])]
	] as const)
		assert.deepEqual(tablesOf((await pdf(name)).html), [table(...rows)], name);
	const lines = (await pdf('ruled.pdf')).html.split('\n');
	assert.deepEqual(lines.slice(0, 4), ['<section data-page="1">', '<h1>Schedule</h1>', lines[2], '<table>'], 'heading, paragraph, then the table where it stood');
	assert.match(lines[2]!, /^<p>Delta sigma .* cable\.<\/p>$/);
});

test('a missing inner rule merges cells; a grid inside a cell nests', async () => {
	assert.deepEqual(tablesOf((await pdf('merged.pdf')).html), [
		table(
			row('<td rowspan="2">Item</td>', '<td colspan="2">Quantity</td>'),
			row(...td('Ordered', 'Shipped')),
			row(...td('Cable', '10', '8')),
			row(...td('Panel', '4', '4'))
		)
	]);
	assert.deepEqual(tablesOf((await pdf('nested.pdf')).html), [
		table(row(...td('Zone', 'Detail')), row('<td>North</td>', '<td>', ...table(row(...td('n1', 'n2')), row(...td('n3', 'n4'))), '</td>'))
	]);
});

test('a table running onto the next page with the same columns is one table', async () => {
	const out = await pdf('spanning.pdf');
	const [one, ...rest] = tablesOf(out.html);
	assert.equal(rest.length, 0);
	assert.equal(one!.filter((l) => l === '<tr>').length, 91);
	assert.deepEqual(one!.slice(-6), ['<td>R-090</td>', one!.at(-5), '<td>270.00</td>', '</tr>', '</tbody>', '</table>']);
	assert.equal(out.meta.stats.pages, 3);
});

test('an invoice: line items between horizontal rules are a table, the prose around it stays prose', async () => {
	const out = await pdf('invoice.pdf');
	assert.deepEqual(tablesOf(out.html), [
		table(
			row(...td('Item', 'Description', 'Qty', 'Unit price', 'Amount')),
			row(...td('A-100', 'Copper cable 2.5 mm', '10', '4.50', '45.00')),
			row(...td('B-220', 'Panel mount', '4', '12.00', '48.00')),
			row(...td('C-310', 'Cable gland M20', '25', '0.80', '20.00')),
			row(...td('D-415', 'Installation labour', '3', '65.00', '195.00'))
		)
	]);
	assert.match(out.html, /<p>Payment due within 30 days\. Thank you for your business\.<\/p>/);
});

test('a grid with a word across its rule is no table: its lines stay paragraphs, every word once', async () => {
	const out = await pdf('straddle.pdf');
	assert.equal(tablesOf(out.html).length, 0);
	assert.match(out.html, /<p>R-1 overflowing text 3\.00 across the rule<\/p>/);
});

const word = (text: string, x0: number, y: number): Word => ({ text, x0, x1: x0 + text.length * 5, y, size: 10, split: false, rotated: false, bold: false, italic: false });
test('unruled detection is conservative: prose in two columns, a chart axis and a stray line are no table', () => {
	/** A line of text from x0, words a space (3 pt) apart. */
	const line = (text: string, x0: number, y: number) => {
		let x = x0;
		return text.split(' ').map((w) => {
			const out = word(w, x, y);
			x = out.x1 + 3;
			return out;
		});
	};
	const prose = Array.from({ length: 6 }, (_, i) => [
		...line('the quick brown fox jumps over', 50, 700 - i * 12),
		...line('a lazy dog sleeps in the sun', 320, 700 - i * 12)
	]).flat();
	assert.deepEqual(stream(prose), []);
	const axis = Array.from({ length: 5 }, (_, i) => [word(`${i * 10}`, 60, 700 - i * 15), word(`${i * 5}`, 400, 700 - i * 15)]).flat();
	assert.equal(stream(axis).length, 1);
	assert.deepEqual(stream(axis, [{ x: 100, y0: 620, y1: 720 }]), []);
	const astray = Array.from({ length: 5 }, (_, i) => [word('A', 60, 700 - i * 12), word(`${i}`, 200, 700 - i * 12)]).flat();
	astray.push(word('B', 60, 640), ...line('runs between', 110, 640));
	assert.deepEqual(stream(astray), []);
});

test('reading order: two prose columns read one after the other; label and value pairs stay on their lines', () => {
	const piece = (text: string, x0: number, y: number) => {
		const words = text.split(' ').map((t, i) => word(t, x0 + i * 30, y));
		return { x0, x1: words.at(-1)!.x1, y0: y - 2.5, y1: y + 7.5, words };
	};
	const page = [
		piece('Title over both columns here', 50, 760),
		...[0, 1, 2].map((i) => piece(`left column line ${i} words`, 50, 700 - i * 12)),
		...[0, 1, 2].map((i) => piece(`right column line ${i} words`, 330, 700 - i * 12))
	];
	const text = (pieces: ReturnType<typeof order>) => pieces.map((leaf) => leaf.flatMap((q) => ('words' in q ? q.words.map((w) => w.text) : [])).join(' '));
	assert.deepEqual(text(order(page)), [
		'Title over both columns here',
		'left column line 0 words',
		'left column line 1 words',
		'left column line 2 words',
		'right column line 0 words',
		'right column line 1 words',
		'right column line 2 words'
	]);
	const form = [piece('Invoice', 50, 700), piece('INV-1', 330, 700), piece('Date', 50, 688), piece('2026-10-30', 330, 688)];
	assert.deepEqual(text(order(form)), ['Invoice INV-1', 'Date 2026-10-30']);
});

// ---------- pictures as their page shows them ----------
/** An 8-bit PNG as pixels, its row filters undone. */
const decode = (bytes: Uint8Array) => {
	const b = Buffer.from(bytes);
	const [width, height, type] = [b.readUInt32BE(16), b.readUInt32BE(20), b[25]!];
	const channels = [1, 0, 3, 0, 2, 0, 4][type]!;
	const idat: Buffer[] = [];
	for (let at = 8; at < b.length; at += 12 + b.readUInt32BE(at)) if (b.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(b.subarray(at + 8, at + 8 + b.readUInt32BE(at)));
	const raw = inflateSync(Buffer.concat(idat));
	const data = new Uint8Array(width * height * channels),
		stride = width * channels;
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!,
			row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let i = 0; i < stride; i++) {
			const left = i < channels ? 0 : data[y * stride + i - channels]!,
				up = y === 0 ? 0 : data[(y - 1) * stride + i]!,
				corner = y === 0 || i < channels ? 0 : data[(y - 1) * stride + i - channels]!,
				guess = left + up - corner,
				[l, u, c] = [Math.abs(guess - left), Math.abs(guess - up), Math.abs(guess - corner)];
			const predicted = [0, left, up, (left + up) >> 1, l <= u && l <= c ? left : u <= c ? up : corner][filter]!;
			data[y * stride + i] = row[i]! + predicted;
		}
	}
	return { width, height, channels, data };
};
/** Where the red block (the stored picture's top-left corner) sits in the returned picture. */
const red = (bytes: string) => {
	const p = decode(Buffer.from(bytes, 'base64'));
	const at = (x: number, y: number) => p.data[(y * p.width + x) * p.channels]! > 200 && p.data[(y * p.width + x) * p.channels + 1]! < 80;
	const corner = ['TL', 'TR', 'BL', 'BR'].find((_, i) => at(i % 2 ? p.width - 3 : 2, i < 2 ? 2 : p.height - 3));
	return { width: p.width, height: p.height, corner };
};

test('a picture painted under a quarter-turn matrix comes back as the page shows it, after the text above it', async () => {
	const out = await pdf('rotated-image.pdf');
	assert.deepEqual(red(out.images[0]!.bytes), { width: 200, height: 400, corner: 'BL' });
	assert.deepEqual(out.html.split('\n').slice(1, 3), ['<p>A picture turned a quarter.</p>', '<img src="image-1.png" alt="">']);
});

test('a scan on a page with /Rotate comes back upright, and a table on such a page reads upright too', async () => {
	const scan = await pdf('rotated-scan.pdf');
	const turned = red(scan.images[0]!.bytes);
	assert.equal(turned.corner, 'BL');
	assert.ok(Math.abs(turned.width - 1654) <= 2 && Math.abs(turned.height - 2340) <= 2, `${turned.width}×${turned.height}`);
	const [one] = tablesOf((await pdf('rotated-table.pdf')).html);
	assert.deepEqual(one?.slice(0, 7), ['<table>', '<tbody>', '<tr>', '<td>Code</td>', '<td>Description</td>', '<td>Rate</td>', '</tr>']);
	assert.equal(one?.filter((l) => l === '<tr>').length, 7);
});

const TRIALS = new URL('../../../../.tmp/demo-files/trials.pdf', import.meta.url);
test.skipIf(!existsSync(TRIALS))('the real trials.pdf scan is one upright picture', async () => {
	const out = await pdf('trials.pdf', readFileSync(TRIALS));
	assert.deepEqual(out.html.split('\n'), ['<section data-page="1">', '<img src="image-1.png" alt="">', '</section>']);
	const { width, height } = red(out.images[0]!.bytes);
	assert.ok(width < height, `${width}×${height}`);
});

// ---------- datasets: typed JSON ----------
const data = async (name: string, mime: string, bytes: Uint8Array) => {
	const out = await Effect.runPromise(ingest({ name, mime, bytes }));
	if (out.kind !== 'data') throw new Error(`${name} is no dataset`);
	assert.ok(!('html' in out), name);
	return out;
};
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

test('xlsx and ods: typed values, ISO dates, formulas cached values, a header row, merges', async () => {
	for (const [name, mime] of [
		['data.xlsx', XLSX],
		['data.ods', 'application/vnd.oasis.opendocument.spreadsheet']
	] as const) {
		const out = await data(name, mime, fixture(name));
		const [rates, merged] = Schema.decodeUnknownSync(Sheets)(out.json).sheets;
		const [yes, no] = [true, false];
		assert.deepEqual(rates, {
			name: 'Rates',
			columns: ['Code', 'Rate', 'Active', 'Since', 'Double'],
			rows: [
				['A1', 3.5, yes, '2026-10-30', 7],
				['007', 4, no, '2026-01-02T13:45:00', 8],
				['B2', null, yes, null, 'yes']
			]
		}, name);
		assert.deepEqual(merged && { ...merged, merges: [...(merged.merges ?? [])].sort((a, b) => a.col - b.col) }, {
			name: 'Merged',
			columns: ['A', 'B', 'C'],
			rows: [['Item', 'Quantity', null], [null, 'Ordered', 'Shipped'], ['Cable', 10, 8]],
			merges: [{ row: 0, col: 0, rows: 2, cols: 1 }, { row: 0, col: 1, rows: 1, cols: 2 }]
		}, name);
		assert.deepEqual(out.images, []);
	}
	const xls = await data('tables.xls', 'application/vnd.ms-excel', fixture('tables.xls'));
	assert.deepEqual(Schema.decodeUnknownSync(Sheets)(xls.json).sheets[0]?.rows, [['Item', 'Quantity', null], [null, 'Ordered', 'Shipped'], ['Cable', 10, 8], ['Panel', 4, 4]]);
});

test('a picture drawn on a sheet comes back as an image, anchored at its cell in the json', async () => {
	const out = await data('picture.xlsx', XLSX, fixture('picture.xlsx'));
	assert.deepEqual(out.json, {
		sheets: [{ name: 'Sites', columns: ['Site', 'Area'], rows: [['North', 12.5], ['South', 8]], images: [{ name: 'image-1.png', row: 1, col: 2 }] }]
	});
	assert.deepEqual(out.images.map((i) => [i.name, i.mime]), [['image-1.png', 'image/png']]);
	assert.equal(decode(Buffer.from(out.images[0]!.bytes, 'base64')).width, 40);
});

test('csv and tsv: delimiter sniffed, quotes, typed values, header detected; json passes through', async () => {
	assert.deepEqual(parseCsv('a;"b;c"\n1;"say ""hi"""\n'), [['a', 'b;c'], ['1', 'say "hi"']]);
	assert.deepEqual(parseCsv('a\tb\r\n1\t2'), [['a', 'b'], ['1', '2']]);
	assert.deepEqual(parseCsv('code,"multi\nline"\n'), [['code', 'multi\nline']]);
	assert.deepEqual([typed('12'), typed('-1.5e3'), typed('007'), typed('TRUE'), typed(' '), typed('2026-10-30')], [12, -1500, '007', true, null, '2026-10-30']);
	const one = await data('rates.csv', 'text/csv', new TextEncoder().encode('code;rate;note\nA1;3.5;"x; y"\nB2;;true\n'));
	assert.deepEqual(one.json, { sheets: [{ name: 'rates', columns: ['code', 'rate', 'note'], rows: [['A1', 3.5, 'x; y'], ['B2', null, true]] }] });
	const tsv = await data('n.tsv', 'text/tab-separated-values', new TextEncoder().encode('1\t2\n3\t"a\tb"\n'));
	assert.deepEqual(tsv.json, { sheets: [{ name: 'n', columns: ['A', 'B'], rows: [[1, 2], [3, 'a\tb']] }] });
	const json = await data('a.json', 'application/json', new TextEncoder().encode('{"a":[1,"x",null,true]}'));
	assert.deepEqual([json.json, json.images], [{ a: [1, 'x', null, true] }, []]);
	assert.deepEqual([serialDate(46325, false), serialDate(0.5, false), serialDate(44863.25, true)], ['2026-10-30', '12:00:00', '2026-10-30T06:00:00']);
});
