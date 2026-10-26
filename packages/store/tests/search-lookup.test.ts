import { Buffer } from 'node:buffer';
import { expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { searchFunctions, sha256Hex } from '../src/index.ts';

it('preserves the installed search SQL and multilingual lookup after packing its data', () => {
	const functions = searchFunctions();
	// Golden values were captured from the original grouped lookup before repacking it.
	expect(sha256Hex(JSON.stringify(functions))).toBe(
		'fa0373919c3d33114abc487070974ad60549f77a67a61fb4970dca33ba6c7ea0'
	);
	const sql = functions.find((fn) => fn.id === 'bolt:function-search-2-romanize')?.sql;
	if (sql === undefined) throw new Error('Romanization function is missing');
	const lookup =
		/select decode\('([0-9a-f]+)', 'hex'\) as codes, '([^']+)'::jsonb as readings/.exec(sql);
	const lower = /ascii\(glyph\) - (\d+) as code/.exec(sql);
	if (lookup?.[1] === undefined || lookup[2] === undefined || lower?.[1] === undefined)
		throw new Error('Romanization lookup is missing');
	const codes = Buffer.from(lookup[1], 'hex');
	const readings = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
		lookup[2]
	);
	const first = Number(lower[1]);
	expect(sha256Hex(lookup[1])).toBe(
		'b0eeb2e6f26cf4646b4f37a635db62a7b7757a8a726a3cb9a44f791e53745df8'
	);
	expect(sha256Hex(lookup[2])).toBe(
		'e19146ae347d9d42033e02b7fb75f29b355589855804156ab05fe14052d475f2'
	);
	expect(readings).toHaveLength(14903);
	expect(first).toBe(223);
	expect(first + codes.length / 2 - 1).toBe(65533);
	let mapped = 0;
	for (let offset = 0; offset < codes.length; offset += 2)
		if (codes.readUInt16BE(offset) > 0) mapped++;
	expect(mapped).toBe(48257);

	const romanize = (text: string) =>
		Array.from(text, (glyph) => {
			const offset = (glyph.codePointAt(0) ?? 0) - first;
			const index = offset >= 0 && offset < codes.length / 2 ? codes.readUInt16BE(offset * 2) : 0;
			return readings[index - 1] ?? glyph;
		});
	expect(romanize('北京厦门')).toEqual(['bei', 'jing', 'sha xia', 'men']);
	expect(romanize('москва')).toEqual(['m', 'o', 's', 'k', 'v', 'a']);
	expect(romanize('دبي')).toEqual(['d', 'b', 'y']);
	expect(romanize('서울')).toEqual(['seo', 'ul']);
	expect(romanize('とうきょう')).toEqual(['to', 'u', 'ki', 'yo', 'u']);
	expect(romanize('ßA0🙂')).toEqual(['ss', 'A', '0', '🙂']);
});
