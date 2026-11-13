import { describe, expect, it } from '@effect/vitest';
import { literal, q } from '../src/sql.ts';

describe('SQL quoting', () => {
	it('keeps punctuation and embedded quotes inside one identifier', () => {
		expect(q('')).toBe('""');
		expect(q('column"name')).toBe('"column""name"');
		expect(q('x"; DROP TABLE users; --')).toBe('"x""; DROP TABLE users; --"');
		expect(q('税')).toBe('"税"');
	});
	it('preserves standard-conforming strings while doubling apostrophes', () => {
		expect(literal('')).toBe("''");
		expect(literal("O'Brien")).toBe("'O''Brien'");
		expect(literal("'; SELECT 1; --")).toBe("'''; SELECT 1; --'");
		expect(literal('line\npath\\folder')).toBe("'line\npath\\folder'");
		expect(literal('税')).toBe("'税'");
	});
});
