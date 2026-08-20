import { describe, expect, it } from 'vitest';
import { resolveRecordDetailFields } from '../../src/client/ui/collection/record-detail-fields.js';

describe('record detail fields', () => {
	it('prefers declared columns and skips row bookkeeping', () => {
		const fields = resolveRecordDetailFields({
			columns: [
				{ name: 'id', type: 'string' },
				{ name: 'norbital_created_at', type: 'datetime' },
				{ name: 'name', type: 'string', required: true },
				{ name: 'headcount', type: 'number' }
			]
		});
		expect(fields.map(({ name }) => name)).toEqual(['name', 'headcount']);
		expect(fields[0]).toMatchObject({ kind: 'string', nullable: false });
	});

	it('treats a generated column as never editable', () => {
		const [field] = resolveRecordDetailFields({
			columns: [{ name: 'summary', type: 'string', required: true, generated: true }]
		});
		expect(field?.nullable).toBe(true);
	});

	it('falls back to the record when nothing is declared', () => {
		const fields = resolveRecordDetailFields({
			record: { norbital_id: 'x', name: 'Ada', active: true, score: 3, payload: { a: 1 } }
		});
		expect(fields.map(({ name, kind }) => [name, kind])).toEqual([
			['name', 'string'],
			['active', 'boolean'],
			['score', 'number'],
			['payload', 'json']
		]);
	});

	it('attaches the relation a foreign key points at', () => {
		const [field] = resolveRecordDetailFields({
			columns: [{ name: 'company_id', type: 'string' }],
			relations: [{ name: 'company', target: 'companies', cardinality: 'one' }]
		});
		expect(field?.relation).toEqual({ name: 'company', target: 'companies' });
	});

	it('leaves an ordinary column without a relation', () => {
		const [field] = resolveRecordDetailFields({
			columns: [{ name: 'name', type: 'string' }],
			relations: [{ name: 'company', target: 'companies' }]
		});
		expect(field?.relation).toBeUndefined();
	});

	it('carries declared enum members through for rendering', () => {
		const [field] = resolveRecordDetailFields({
			columns: [{ name: 'status', type: 'string', values: ['ACTIVE', 'CLOSED'] }]
		});
		expect(field?.values).toEqual(['ACTIVE', 'CLOSED']);
	});
});
