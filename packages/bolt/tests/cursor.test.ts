import { describe, expect, it } from '@effect/vitest';
import { Encoding, Schema } from 'effect';
import { CursorValue, encodeCursor, type Cursor } from '@norbital-ai/store';

describe('page cursor codec', () => {
	it('retains issued cursors with Unicode and null keys through the nominal boundary', () => {
		for (const keys of [[], [null], ["quoted ' note \\ 🔒", '東京', null]]) {
			const wire = encodeCursor('query-hash', keys);
			const cursor: Cursor = Schema.decodeUnknownSync(CursorValue)(wire);
			expect(cursor).toBe(wire);
			expect(Schema.encodeSync(CursorValue)(cursor)).toBe(wire);
		}
	});

	it('rejects malformed wire encodings, UTF-8, JSON and payloads', () => {
		const wire = encodeCursor('query-hash', [null]);
		const malformed = [
			null,
			[],
			{},
			{ h: 'query-hash' },
			{ h: 1, k: [] },
			{ h: 'query-hash', k: null },
			{ h: 'query-hash', k: [{}] },
			{ h: 'query-hash', k: [1] },
			{ h: 'query-hash', k: [true] }
		];
		for (const value of [
			42,
			'',
			'!',
			`${wire}=`,
			`${wire}\n`,
			Encoding.encodeBase64Url('{'),
			Encoding.encodeBase64Url(
				new Uint8Array([123, 34, 104, 34, 58, 34, 255, 34, 44, 34, 107, 34, 58, 91, 93, 125])
			),
			...malformed.map((value) => Encoding.encodeBase64Url(JSON.stringify(value)))
		])
			expect(() => Schema.decodeUnknownSync(CursorValue)(value)).toThrow();
	});
});
