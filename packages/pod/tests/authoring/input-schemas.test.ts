import { describe, expect, it } from 'vitest';
import { dateRange, file } from '$lib/authoring/builtin/columns.js';
import { buildInputSchemas } from '$lib/authoring/schema/input-schemas.js';
import { norbitalTableInternal } from '$lib/authoring/schema/table.js';

const FIRST_FILE = '11111111-1111-4111-8111-111111111111';
const SECOND_FILE = '22222222-2222-4222-8222-222222222222';

describe('collection mutation input schemas', () => {
	it('accepts open-ended date ranges while retaining UTC validation', () => {
		const records = norbitalTableInternal('records', { validity_range: dateRange() }, {});
		const input = buildInputSchemas({ records }).records.create;

		expect(
			input.parse({ validity_range: { start: '2026-03-01T08:00:00.000Z' } }).validity_range
		).toEqual({ start: '2026-03-01T08:00:00.000Z' });
		expect(
			input.parse({ validity_range: { end: '2026-12-31T00:00:00.000Z' } }).validity_range
		).toEqual({ end: '2026-12-31T00:00:00.000Z' });
		expect(() =>
			input.parse({ validity_range: { start: '2026-03-01T08:00:00.000+08:00' } })
		).toThrow(/UTC ISO instant/);
	});

	it('validates custom-type arrays as arrays of their element schema', () => {
		const records = norbitalTableInternal(
			'records',
			{ supporting_documents: file().array(), milestones: dateRange().array() },
			{}
		);
		const input = buildInputSchemas({ records }).records.create;

		expect(
			input.parse({
				supporting_documents: [FIRST_FILE, SECOND_FILE],
				milestones: [{ start: '2026-01-01T00:00:00.000Z' }, { end: '2026-12-31T00:00:00.000Z' }]
			})
		).toMatchObject({
			supporting_documents: [FIRST_FILE, SECOND_FILE],
			milestones: [{ start: '2026-01-01T00:00:00.000Z' }, { end: '2026-12-31T00:00:00.000Z' }]
		});
		expect(() => input.parse({ supporting_documents: FIRST_FILE, milestones: [] })).toThrow();
		expect(() => input.parse({ supporting_documents: ['not-a-uuid'], milestones: [] })).toThrow();
	});
});
