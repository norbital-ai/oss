import { Buffer } from 'node:buffer';
import { expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { searchFunctions } from '../src/index.ts';

it('the installed search SQL romanizes multilingual text through its packed lookup', () => {
	const sql = searchFunctions().find((fn) => fn.id === 'bolt:function-search-2-romanize')?.sql;
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
