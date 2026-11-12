// Plan 12's engine half, pure: the router per mime, windows that never split a table, grep, the images of a window, the
// index and transcript derived from the HTML, a data ingest's summary and the steering message's counts and map.
import { describe, expect, it } from '@effect/vitest';
import {
	blocks,
	dataLine,
	dataSummary,
	grep,
	imagesIn,
	indexOf,
	outlineMap,
	route,
	summary,
	textIngest,
	transcriptOf,
	unparsed,
	window
} from '../src/engine/agent/ingest.ts';

const OOXML = 'application/vnd.openxmlformats-officedocument.';
describe('route', () => {
	it('sends documents to Convert, keeps images and text here, audio to Convert as a transcript, and refuses the rest', () => {
		for (const mime of [
			'application/pdf',
			'text/html',
			'text/csv',
			'application/json',
			'application/rtf',
			'application/msword',
			'application/vnd.ms-excel',
			'application/vnd.ms-powerpoint',
			`${OOXML}wordprocessingml.document`,
			`${OOXML}spreadsheetml.sheet`,
			`${OOXML}presentationml.presentation`,
			'application/vnd.oasis.opendocument.text',
			'application/vnd.oasis.opendocument.spreadsheet',
			'application/vnd.oasis.opendocument.presentation'
		])
			expect(route(mime, 'f')).toBe('convert');
		expect(route('image/png', 'scan.png')).toBe('image');
		expect(route('text/plain', 'notes.txt')).toBe('text');
		for (const mime of ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg'])
			expect(route(mime, 'a')).toBe('audio');
		expect(route('video/mp4', 'site.mp4')).toBe('unsupported');
		expect(route('application/acad', 'plan.dwg')).toBe('unsupported');
		expect(route('application/zip', 'a.zip')).toBe('unsupported');
		// an unnamed type goes by its extension
		expect(route('application/octet-stream', 'rates.xls')).toBe('convert');
		expect(route('', 'meeting.m4a')).toBe('audio');
		expect(route('application/octet-stream', 'plan.dwg')).toBe('unsupported');
		expect(unparsed('plan.dwg', 'application/acad')).toContain(
			'no parser. A call-mode automation'
		);
	});
});

const html = [
	'<h1>Cover</h1>',
	'<p>Intro</p>',
	'<table>',
	'<tr><td>Lot</td><td>Rate</td></tr>',
	'<tr><td><table><tr><td>nested</td></tr></table></td></tr>',
	'<tr><td>7</td><td>12.50</td></tr>',
	'</table>',
	'<p><img src="image-1.png" alt="a"> and <img src="image-2.png"></p>',
	'<section data-slide="2">',
	'<p>Slide two</p>',
	'</section>',
	'<p>End</p>'
].join('\n');
describe('windows', () => {
	it('finds each outermost table and section, nested tables inside it', () => {
		const spans = blocks(html.split('\n'));
		expect(spans[0]).toBeUndefined();
		expect(spans.slice(2, 7)).toEqual(Array(5).fill([3, 7]));
		expect(spans.slice(8, 11)).toEqual(Array(3).fill([9, 11]));
		expect(spans[11]).toBeUndefined();
	});
	it('never cuts a table: a window inside one starts at its open and runs to its close', () => {
		const w = window(html, 5, 5);
		expect([w.from, w.to, w.next]).toEqual([3, 7, 8]);
		expect(w.lines[0]).toBe('3: <table>');
		expect(w.lines.at(-1)).toBe('7: </table>');
		expect(window(html, 1, 4)).toMatchObject({ from: 1, to: 7 });
		expect(window(html)).toMatchObject({ from: 1, to: 12, total: 12 });
		expect(window(html).next).toBeUndefined();
	});
	it('stops before a table that does not fit; only a lone table larger than the bound is cut', () => {
		const lines = window(html, 1, 12, 60);
		expect([lines.from, lines.to, lines.next]).toEqual([1, 2, 3]);
		const lone = window(html, 3, 7, 60);
		expect(lone.from).toBe(3);
		expect(lone.to).toBeLessThan(7);
	});
	it('names a PDF hit by its page, and the pages with no text as ranges', () => {
		const scan = (n: number) => [`<section data-page="${n}">`, '<p>No text on this page.</p>', '</section>'];
		const pdf = [
			...scan(1),
			...scan(2),
			'<section data-page="3">',
			'<pre>',
			'Bond 5%',
			'</pre>',
			'</section>',
			...scan(4)
		].join('\n');
		expect(indexOf(pdf).no_text).toBe('1–2, 4');
		expect(summary(indexOf(pdf), undefined)).toContain('no text on pages 1–2, 4');
		expect(grep(pdf, 'bond', 30).hits[0]?.page).toBe(3);
		expect(grep(pdf, 'bond|no text', 30).total).toBe(4);
	});
	it('greps lines in the line shape, naming a hit inside a table by the whole table', () => {
		expect(grep(html, '12.50', 30)).toEqual({
			total: 1,
			hits: [{ from: 3, to: 7, text: '<tr><td>7</td><td>12.50</td></tr>' }]
		});
		expect(grep(html, 'end', 30).hits).toEqual([{ from: 12, to: 12, text: '<p>End</p>' }]);
		expect(grep(html, 'p>', 2)).toMatchObject({ total: 4, hits: [{ from: 2 }, { from: 8 }] });
	});
	it('a window shows only the images its own lines reference', () => {
		expect(imagesIn(window(html, 1, 7).lines, ['image-1.png', 'image-2.png'])).toEqual([]);
		expect(imagesIn(window(html, 8, 8).lines, ['image-1.png', 'image-2.png'])).toEqual([
			'image-1.png',
			'image-2.png'
		]);
		expect(imagesIn(window(html, 8, 8).lines, ['image-2.png'])).toEqual(['image-2.png']);
	});
});

const recording = [
	'<section data-speaker="S1" data-start="0" data-end="4.5"><time>00:00:00</time> We agree on <strong>Friday</strong> &amp; Monday.</section>',
	'<section data-speaker="S1" data-start="4.5" data-end="9"><time>00:00:04</time> Then we pour.</section>',
	'<section data-speaker="S2" data-start="252" data-end="2412"><time>00:04:12</time> Agreed.</section>'
].join('\n');
describe('what the HTML holds', () => {
	it('indexes lines, slides, an outline with ranges, tables (nested too) and image names', () => {
		expect(indexOf(html)).toEqual({
			lines: 12,
			pages: 0,
			slides: 1,
			outline: [
				{ title: 'Cover', level: 1, from: 1, to: 12 },
				{ title: 'Slide 2', level: 7, from: 9, to: 11 }
			],
			tables: 2,
			images: ['image-1.png', 'image-2.png']
		});
		const pdf = indexOf(
			[
				'<section data-page="1">',
				'<h1>1 <em>Scope</em></h1>',
				'<h2>1.4 Pricing</h2>',
				'<p>Rates</p>',
				'</section>',
				'<section data-page="2">',
				'<h1>2 Terms</h1>',
				'</section>'
			].join('\n')
		);
		expect(pdf.pages).toBe(2);
		expect(pdf.outline).toEqual([
			{ title: 'Page 1', level: 7, from: 1, to: 5 },
			{ title: '1 Scope', level: 1, from: 2, to: 6 },
			{ title: '1.4 Pricing', level: 2, from: 3, to: 6 },
			{ title: 'Page 2', level: 7, from: 6, to: 8 },
			{ title: '2 Terms', level: 1, from: 7, to: 8 }
		]);
		expect(outlineMap(pdf)).toBe('L2–6 1 Scope (1.4 Pricing L3–6) · L7–8 2 Terms');
	});
	it("a recording's speaker runs are its outline; its transcript is read from the sections", () => {
		expect(indexOf(recording).outline).toEqual([
			{ title: 'S1 00:00:00', level: 7, from: 1, to: 2 },
			{ title: 'S2 00:04:12', level: 7, from: 3, to: 3 }
		]);
		expect(transcriptOf(recording)).toEqual({
			duration_ms: 2_412_000,
			speakers: ['S1', 'S2'],
			segments: [
				{ speaker: 'S1', start: 0, end: 4.5, text: 'We agree on Friday & Monday.' },
				{ speaker: 'S1', start: 4.5, end: 9, text: 'Then we pour.' },
				{ speaker: 'S2', start: 252, end: 2412, text: 'Agreed.' }
			]
		});
		expect(transcriptOf(html)).toBeUndefined();
	});
	it("summarises a data ingest's sheets, and any other JSON by its start", () => {
		const json = {
			sheets: [
				{
					name: 'Rates',
					columns: ['Item', 'Rate'],
					rows: Array.from({ length: 7 }, (_, i) => [`Item ${i}`, i]),
					images: [{ name: 'image-1.png', row: 0, col: 1 }]
				},
				{ name: 'Notes', columns: [], rows: [['one']] }
			]
		};
		expect(dataSummary(json)).toEqual([
			{
				name: 'Rates',
				columns: ['Item', 'Rate'],
				rows: 7,
				first: json.sheets[0]?.rows.slice(0, 5),
				images: [{ name: 'image-1.png', row: 0, col: 1 }]
			},
			{ name: 'Notes', columns: [], rows: 1, first: [['one']] }
		]);
		expect(dataLine(json)).toBe('Rates (7 rows) · Notes (1 row)');
		expect(dataSummary({ a: [1, 2] })).toEqual({ json: '{"a":[1,2]}', bytes: 11 });
		expect(dataLine([1, 2])).toBe('a JSON value (5 bytes)');
	});
});

describe('local ingests and the steering message', () => {
	it('text is its own lines, escaped; a transcript counts its length and speakers', () => {
		const text = textIngest(new TextEncoder().encode('a < b\n\nc'));
		expect(text.kind === 'document' && text.html).toBe('<p>a &lt; b</p>\n<p></p>\n<p>c</p>');
		expect(summary(indexOf(recording), transcriptOf(recording))).toBe(
			'00:40:12 · 2 speakers · 3 lines'
		);
	});
	it('counts and an outline map with line ranges', () => {
		const index = {
			lines: 14200,
			pages: 180,
			slides: 0,
			outline: [
				{ title: 'Cover', level: 1, from: 1, to: 212 },
				{ title: '1 Scope', level: 1, from: 213, to: 1880 },
				{ title: '1.4 Pricing', level: 2, from: 1402, to: 1690 },
				{ title: '1.4.1 Rates', level: 3, from: 1410, to: 1500 }
			],
			tables: 9,
			images: Array.from({ length: 63 }, (_, n) => `image-${n + 1}.png`)
		};
		expect(summary(index, undefined)).toBe('180 pages · 14,200 lines · 63 images · 9 tables');
		expect(outlineMap(index)).toBe('L1–212 Cover · L213–1,880 1 Scope (1.4 Pricing L1,402–1,690)');
	});
});
