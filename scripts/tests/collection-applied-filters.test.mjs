import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectionAppliedFilterConditions } from '../../packages/ui/src/collection-table/collection-table-applied-filters.ts';

const companies = {
	name: 'companies',
	recordLabel: 'name',
	fields: [
		{ name: 'id', kind: 'uuid', nullable: false },
		{ name: 'name', kind: 'text', nullable: false }
	]
};

const entries = {
	name: 'entries',
	fields: [
		{
			name: 'company_id',
			label: 'Company',
			kind: 'uuid',
			nullable: false,
			relation: { name: 'company', target: 'companies' }
		},
		{ name: 'amount', kind: 'number', nullable: false }
	],
	relationships: [
		{ name: 'company', target: 'companies', fields: ['company_id'], references: ['id'] }
	]
};

describe('schema-aware applied collection filters', () => {
	it('resolves a nested relationship key to the target collection renderer', () => {
		const [condition] = collectionAppliedFilterConditions(
			{ company: { id: { eq: 'company-1' } } },
			entries,
			{ entries, companies }
		);

		assert.equal(condition?.label, 'Company');
		assert.equal(condition?.lookupTarget, 'companies');
		assert.equal(condition?.operand, 'company-1');
	});

	it('preserves boolean context without flattening values into display strings', () => {
		const [condition] = collectionAppliedFilterConditions(
			{ NOT: { OR: [{ amount: { gte: 100 } }] } },
			entries,
			{ entries, companies }
		);

		assert.equal(condition?.operator, 'gte');
		assert.equal(condition?.operand, 100);
		assert.equal(condition?.negated, true);
		assert.equal(condition?.alternative, true);
	});
});
