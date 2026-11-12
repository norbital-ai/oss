import { describe, expect, it } from '@effect/vitest';
import { UUID_PATTERN } from '../src/id.ts';

describe('UUID spelling', () => {
	it('accepts nil, all version/variant hex digits and uppercase without a stateful flag', () => {
		for (const id of [
			'00000000-0000-0000-0000-000000000000',
			'019629f1-0b80-7000-8000-000000000001',
			'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF'
		]) {
			expect(UUID_PATTERN.test(id)).toBe(true);
			expect(UUID_PATTERN.test(id)).toBe(true);
		}
		expect(UUID_PATTERN.flags).toBe('i');
	});
	it('refuses malformed lengths, nonhex characters, escaping, braces and extra text', () => {
		for (const id of [
			'',
			'00000000-0000-0000-0000-00000000000',
			'00000000-0000-0000-0000-00000000000g',
			'00000000--0000-0000-0000-000000000000',
			'{00000000-0000-0000-0000-000000000000}',
			'\\00000000-0000-0000-0000-000000000000',
			' 00000000-0000-0000-0000-000000000000',
			'00000000-0000-0000-0000-000000000000 extra'
		]) expect(UUID_PATTERN.test(id)).toBe(false);
	});
	it('keeps the exact source emitted by existing native SQL definitions', () => {
		expect(UUID_PATTERN.source).toBe('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
	});
});
