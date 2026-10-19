import { test } from '@effect/vitest';
import { deepStrictEqual } from 'node:assert';
import { csvRows } from '../src/csv.ts';

for (const ending of ['\n', '\r', '\r\n'])
	test(`reads ${JSON.stringify(ending)} endings without adding a trailing row`, () => {
		deepStrictEqual(csvRows(`site,title${ending}A,Work${ending}`), [
			['site', 'title'],
			['A', 'Work']
		]);
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
});
