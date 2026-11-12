import './resolve.ts';
import assert from 'node:assert/strict';
import { it as test } from '@effect/vitest';
import {
	is_json_schema,
	jsonSchemaGroups,
	jsonSchemaInitial,
	json_schema_kind,
	resolve_json_schema,
	type JsonSchema
} from '../src/kinds/json-schema.ts';

test('local references resolve safely, escaped names work and cycles/remote refs fall back', () => {
	const root: JsonSchema = {
		$defs: { 'a/b': { type: 'string', format: 'date' }, cycle: { $ref: '#/$defs/cycle' } }
	};
	assert.equal(json_schema_kind(resolve_json_schema({ $ref: '#/$defs/a~1b' }, root)).kind, 'date');
	assert.equal(resolve_json_schema({ $ref: '#/$defs/cycle' }, root), true);
	assert.equal(resolve_json_schema({ $ref: 'https://example.com/schema' }, root), true);
	assert.equal(resolve_json_schema({ $ref: '#/$defs/missing' }, root), true);
	assert.equal(resolve_json_schema({ $ref: '#/$defs/a~1b', type: 'number' }, root), true);
});
test('system and tenant datatypes use the same existing custom registry dispatch', () => {
	for (const datatype of ['money', 'phone', 'tenant_tax_reference'])
		assert.deepEqual(json_schema_kind({ type: 'string', 'x-norbital': { datatype } }), {
			kind: 'custom',
			of: datatype,
			label: undefined,
			help: undefined
		});
	assert.equal(json_schema_kind({ type: 'integer', minimum: 0 }).kind, 'int');
	assert.equal(json_schema_kind({ type: ['string', 'null'] }).kind, 'text');
	assert.equal(json_schema_kind({ enum: ['a', 'b'] }).kind, 'enum');
	assert.equal(json_schema_kind({ oneOf: [{ type: 'string' }, { type: 'number' }] }).kind, 'json');
});
test('unsectioned fields form one untitled group in order; explicit sections and order are honored', () => {
	const groups = jsonSchemaGroups({
		type: 'object',
		required: ['name'],
		properties: {
			notes: { type: 'string' },
			name: { type: 'string' },
			country: { type: 'string', 'x-norbital': { section: 'Payroll', order: -1 } },
			audit: { type: 'string', 'x-norbital': { section: 'Audit', advanced: true } }
		}
	});
	assert.deepEqual(
		groups.map((g) => [g.title, g.advanced, g.fields.map((f) => f.name)]),
		[
			['Payroll', false, ['country']],
			['', false, ['notes', 'name']],
			['Audit', true, ['audit']]
		]
	);
	assert.equal(groups[1]?.fields[1]?.required, true);
	assert.deepEqual(jsonSchemaInitial({ type: 'object', default: { fixed: false } }), {
		fixed: false
	});
	assert.deepEqual(jsonSchemaInitial({ type: 'object', properties: { x: { default: 4 } } }), {});
});
test('conditionals that only require keys keep their controls; stored schemas decode once', () => {
	const base = { type: 'object', properties: { kind: { type: 'string' } } } as const;
	const requires = { if: { properties: { kind: { const: 'A' } } }, then: { required: ['kind'] } };
	assert.equal(json_schema_kind({ ...base, allOf: [requires] }).kind, 'object');
	assert.equal(json_schema_kind({ ...base, ...requires }).kind, 'object');
	assert.equal(
		json_schema_kind({ ...base, allOf: [{ then: { properties: { x: { type: 'string' } } } }] }).kind,
		'json'
	);
	assert.equal(is_json_schema({ ...base, required: ['kind'], enum: [1, 'a', null] }), true);
	assert.equal(is_json_schema({ type: 'object', properties: { kind: 4 } }), false);
	assert.equal(is_json_schema({ type: 'object', required: 'kind' }), false);
	assert.equal(is_json_schema([]), false);
});
test('a stored schema decodes its read keywords once; a pointer target is decoded where it lands', () => {
	assert.equal(is_json_schema({ type: 'array', minItems: '3' }), false);
	assert.equal(is_json_schema({ allOf: { type: 'string' } }), false);
	assert.equal(is_json_schema({ type: 'object', vendor: { any: ['json'] } }), true);
	const root: JsonSchema = {
		$defs: { text: { type: 'string', maxLength: 4 }, bad: { type: 7 }, list: [1] }
	};
	assert.deepEqual(json_schema_kind(resolve_json_schema({ $ref: '#/$defs/text' }, root)), {
		kind: 'text',
		label: undefined,
		help: undefined,
		max: 4
	});
	assert.equal(resolve_json_schema({ $ref: '#/$defs/bad' }, root), true);
	assert.equal(resolve_json_schema({ $ref: '#/$defs/list' }, root), true);
	assert.equal(resolve_json_schema({ $ref: '#/$defs/list/0' }, root), true);
});
