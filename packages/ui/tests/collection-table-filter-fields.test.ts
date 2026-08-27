// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { collectionFilterFields } from '../src/collection-filter/collection-filter-paths.ts';

const collections = {
	people: {
		name: 'people',
		fields: [
			{ name: 'id', kind: 'uuid', nullable: false },
			{ name: 'name', kind: 'text', nullable: false },
			{
				name: 'company_id',
				kind: 'uuid',
				nullable: true,
				relation: { name: 'company', target: 'companies' }
			}
		],
		relationships: [{ name: 'company', target: 'companies', cardinality: 'one' }]
	},
	companies: {
		name: 'companies',
		fields: [
			{ name: 'id', kind: 'uuid', nullable: false },
			{ name: 'name', kind: 'text', nullable: false },
			{
				name: 'country_id',
				kind: 'uuid',
				nullable: true,
				relation: { name: 'country', target: 'countries' }
			}
		],
		relationships: [{ name: 'country', target: 'countries', cardinality: 'one' }]
	},
	countries: {
		name: 'countries',
		fields: [
			{ name: 'id', kind: 'uuid', nullable: false },
			{ name: 'name', kind: 'text', nullable: false },
			{
				name: 'region_id',
				kind: 'uuid',
				nullable: true,
				relation: { name: 'region', target: 'regions' }
			}
		],
		relationships: [{ name: 'region', target: 'regions', cardinality: 'one' }]
	},
	regions: {
		name: 'regions',
		fields: [
			{ name: 'id', kind: 'uuid', nullable: false },
			{ name: 'name', kind: 'text', nullable: false }
		]
	}
};

test('filter fields include root attributes and recurse through exactly two relationships', () => {
	const fields = collectionFilterFields(collections.people, collections);
	const paths = new Set(fields.map((field) => field.value));

	assert.equal(paths.has('name'), true);
	assert.equal(paths.has('company.name'), true);
	assert.equal(paths.has('company.country.name'), true);
	assert.equal(paths.has('company.country.region.name'), false);
	assert.equal(
		fields.find((field) => field.value === 'company.country.id')?.lookupTarget,
		'countries'
	);
});

test('a recursively selected filter retains its full relationship path', () => {
	const field = collectionFilterFields(collections.people, collections).find(
		(candidate) => candidate.value === 'company.country.name'
	);
	assert.ok(field);
	assert.deepEqual(field.path, ['company', 'country', 'name']);
});
