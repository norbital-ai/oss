import { describe, expect, it } from 'vitest';
import {
	CreateManyResultSchema,
	CreateManyWireSchema,
	ImportRecordsResultSchema,
	UpdateManyResultSchema,
	UpdateManyWireSchema
} from '@norbital-ai/platform-utils/remote/collection_wire_schemas';

describe('createMany wire projection', () => {
	it('accepts an id-only response request without changing the default', () => {
		const input = { collection: 'records', inputs: [{ title: 'one' }] };
		expect(CreateManyWireSchema.parse(input)).toEqual(input);
		expect(CreateManyWireSchema.parse({ ...input, returning: 'ids' }).returning).toBe('ids');
		expect(CreateManyWireSchema.parse({ ...input, skipAudit: true }).skipAudit).toBe(true);
		expect(() => CreateManyWireSchema.parse({ ...input, returning: 'nothing' })).toThrow();
	});

	it('rejects leftover resume fields on createMany', () => {
		const input = {
			collection: 'records',
			inputs: [{ title: 'one' }, { title: 'two' }],
			offset: 1,
			priorSlice: { rows: 1, ms: 40 }
		};
		expect(() => CreateManyWireSchema.parse(input)).toThrow();
	});

	it('parses records only and rejects leftover resume fields', () => {
		expect(
			CreateManyResultSchema.parse({
				records: [{ title: 'one' }]
			})
		).toEqual({
			records: [{ title: 'one' }]
		});
		expect(() =>
			CreateManyResultSchema.parse({
				records: [{ title: 'one' }],
				offset: 1,
				priorSlice: { rows: 1, ms: 12 }
			})
		).toThrow();
		expect(() => CreateManyResultSchema.parse([{ title: 'one' }])).toThrow();
	});

	it('rejects leftover resume fields on updateMany', () => {
		const input = {
			collection: 'records',
			updates: [{ record_id: '1', input: { title: 'one' } }],
			offset: 0,
			priorSlice: { rows: 1, ms: 12 }
		};
		expect(() => UpdateManyWireSchema.parse(input)).toThrow();
	});

	it('parses records only for updateMany and import', () => {
		const envelope = {
			records: [{ title: 'one' }]
		};
		expect(UpdateManyResultSchema.parse(envelope)).toEqual(envelope);
		expect(ImportRecordsResultSchema.parse(envelope)).toEqual(envelope);
		expect(() =>
			UpdateManyResultSchema.parse({
				...envelope,
				offset: 0,
				priorSlice: { rows: 1, ms: 12 }
			})
		).toThrow();
	});
});
