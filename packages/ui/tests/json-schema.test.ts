import './resolve.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonSchemaGroups, jsonSchemaInitial, jsonSchemaKind, resolveJsonSchema, type JsonSchema } from '../src/kinds/json-schema.ts';

test('local references resolve safely, escaped names work and cycles/remote refs fall back', () => {
	const root: JsonSchema = { $defs: { 'a/b': { type: 'string', format: 'date' }, cycle: { $ref: '#/$defs/cycle' } } };
	assert.equal(jsonSchemaKind(resolveJsonSchema({ $ref: '#/$defs/a~1b' }, root)).kind, 'date');
	assert.equal(resolveJsonSchema({ $ref: '#/$defs/cycle' }, root), true);
	assert.equal(resolveJsonSchema({ $ref: 'https://example.com/schema' }, root), true);
	assert.equal(resolveJsonSchema({ $ref: '#/$defs/missing' }, root), true);
	assert.equal(resolveJsonSchema({ $ref: '#/$defs/a~1b', type: 'number' }, root), true);
});
test('system and tenant datatypes use the same existing custom registry dispatch', () => {
	for (const datatype of ['money', 'phone', 'tenant_tax_reference']) assert.deepEqual(jsonSchemaKind({ type: 'string', 'x-norbital': { datatype } }), { kind: 'custom', of: datatype, label: undefined, help: undefined });
	assert.equal(jsonSchemaKind({ type: 'integer', minimum: 0 }).kind, 'int');
	assert.equal(jsonSchemaKind({ type: ['string', 'null'] }).kind, 'text');
	assert.equal(jsonSchemaKind({ enum: ['a', 'b'] }).kind, 'enum');
	assert.equal(jsonSchemaKind({ oneOf: [{ type: 'string' }, { type: 'number' }] }).kind, 'json');
});
test('required and secondary fields segment predictably, explicit sections and order are honored', () => {
	const groups = jsonSchemaGroups({ type: 'object', required: ['name'], properties: {
		notes: { type: 'string' }, name: { type: 'string' },
		country: { type: 'string', 'x-norbital': { section: 'Payroll', advanced: false, order: -1 } }
	} });
	assert.deepEqual(groups.map((g) => [g.title, g.advanced]), [['Payroll', false], ['Required details', false], ['Additional details', true]]);
	assert.equal(groups[1]!.fields[0]!.required, true);
	assert.deepEqual(jsonSchemaInitial({ type: 'object', default: { fixed: false } }), { fixed: false });
	assert.deepEqual(jsonSchemaInitial({ type: 'object', properties: { x: { default: 4 } } }), {});
});
