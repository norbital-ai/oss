import { test } from '@effect/vitest';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { csvDelimiter, csvOf, csvRows, csvText } from '../src/csv.ts';

for (const ending of ['\n', '\r', '\r\n'])
	test(`reads ${JSON.stringify(ending)} endings without adding a trailing row`, () => {
		deepStrictEqual(csvRows(`site,title${ending}A,Work${ending}`), [
			['site', 'title'],
			['A', 'Work']
		]);
		deepStrictEqual(csvRows(`header${ending}""`), [['header'], ['']]);
		deepStrictEqual(csvRows(`header${ending}""${ending}`), [['header'], ['']]);
	});
test('preserves quoted delimiters, doubled quotes and multiline cells', () => {
	deepStrictEqual(csvRows('"A, B","Quoted ""work"""\r\nJapan,"Line1\r\nLine2"'), [
		['A, B', 'Quoted "work"'],
		['Japan', 'Line1\r\nLine2']
	]);
});
test('keeps blank rows and string cells for callers to interpret', () => {
	deepStrictEqual(csvRows('name,value\n\n日本,001\n'), [['name', 'value'], [''], ['日本', '001']]);
	deepStrictEqual(csvRows(''), []);
	deepStrictEqual(csvRows('""'), [['']]);
});
test('reads another delimiter, a quoted one kept in its cell', () => {
	deepStrictEqual(csvRows('a\tb\n"x\ty"\t2\n', '\t'), [
		['a', 'b'],
		['x\ty', '2']
	]);
	deepStrictEqual(csvRows('a;b\n1,5;2\n', ';'), [
		['a', 'b'],
		['1,5', '2']
	]);
});
test('detects the delimiter from the header line, outside quotes; comma when none', () => {
	strictEqual(csvDelimiter('name;amount;date\n"a,b";1,5;x'), ';');
	strictEqual(csvDelimiter('name\tamount\n'), '\t');
	strictEqual(csvDelimiter('"a;b;c",d,e\n'), ',');
	strictEqual(csvDelimiter('a|b|c'), '|');
	strictEqual(csvDelimiter('single'), ',');
});
test('detects the encoding: a byte-order mark, else UTF-8, else Windows-1252', () => {
	strictEqual(csvText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62])), 'a,b');
	strictEqual(csvText(new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0xe9, 0x00])), 'aé');
	strictEqual(csvText(new Uint8Array([0xfe, 0xff, 0x00, 0x61, 0x00, 0xe9])), 'aé');
	strictEqual(csvText(new TextEncoder().encode('日本,é')), '日本,é');
	strictEqual(csvText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x80])), 'café€');
});
test('writes RFC 4180 rows that read back, quoting the delimiter, quotes and line breaks', () => {
	const rows = [
		['a', 'b'],
		['x, y', 'say "hi"'],
		[null, 2],
		['multi\nline', true]
	];
	const text = csvOf(rows);
	strictEqual(text, 'a,b\r\n"x, y","say ""hi"""\r\n,2\r\n"multi\nline",true');
	deepStrictEqual(csvRows(text), [
		['a', 'b'],
		['x, y', 'say "hi"'],
		['', '2'],
		['multi\nline', 'true']
	]);
	strictEqual(csvOf([['a\tb', 'c']], '\t'), '"a\tb"\tc');
});
