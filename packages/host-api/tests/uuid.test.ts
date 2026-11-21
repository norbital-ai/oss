import { describe, expect, it } from '@effect/vitest';
import { uuidv7, uuidv7_within } from '../src/uuid.ts';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
	it('mints valid RFC 9562 v7 ids strictly ordered within a burst', () => {
		const ids = Array.from({ length: 64 }, () => uuidv7());
		for (const id of ids) expect(id).toMatch(UUID_V7);
		for (let i = 1; i < ids.length; i++) expect((ids[i] ?? '') > (ids[i - 1] ?? '')).toBe(true);
		expect(uuidv7_within(ids[0] ?? '', Date.now())).toBe(true);
	});

	it('mints strictly ordered v7 ids for repeated explicit timestamps', () => {
		const fixed = Date.parse('2026-06-01T12:00:00.000Z');
		const ids = Array.from({ length: 16 }, () => uuidv7(fixed));
		for (const id of ids) {
			expect(id).toMatch(UUID_V7);
			expect(uuidv7_within(id, fixed)).toBe(true);
		}
		for (let i = 1; i < ids.length; i++) expect((ids[i] ?? '') > (ids[i - 1] ?? '')).toBe(true);
	});
});
