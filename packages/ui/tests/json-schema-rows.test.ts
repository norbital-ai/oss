import './resolve.ts';
import assert from 'node:assert/strict';
import { describe, it } from '@effect/vitest';
import { jsonSchemaFromRows, jsonSchemaRows } from '../src/kinds/json-schema-rows.ts';

describe('json schema rows', () => {
	it('a schema reads as rows and writes back unchanged', () => {
		const held = {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'object',
			title: 'Employee inputs',
			properties: {
				zone: { type: 'string', enum: ['1', '2', '3'], default: '1', title: 'Zone' },
				facts: {
					type: 'object',
					properties: {
						started: { type: 'string', format: 'date' },
						grade: { type: ['integer', 'null'], minimum: 1 },
						tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } }
					},
					required: ['started']
				},
				terms: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							code: { type: 'string', description: 'The code' },
							ok: { type: 'boolean' }
						}
					}
				}
			},
			required: ['zone'],
			additionalProperties: false
		};
		assert.deepStrictEqual(
			jsonSchemaRows(held).map((row) => row.path),
			[
				'zone',
				'facts',
				'facts.started',
				'facts.grade',
				'facts.tags',
				'facts.tags[]',
				'terms',
				'terms[].code',
				'terms[].ok'
			]
		);
		assert.deepStrictEqual(jsonSchemaFromRows(jsonSchemaRows(held), held), held);
	});

	it('a renamed row keeps its keywords and children, added rows nest by path, blanks are named', () => {
		const held = {
			type: 'object',
			additionalProperties: false,
			properties: {
				pay: {
					type: 'array',
					items: {
						type: 'object',
						allOf: [{ if: {}, then: { required: ['code'] } }],
						properties: { code: { type: 'string', minLength: 1 } }
					}
				}
			}
		};
		const rows = jsonSchemaRows(held);
		assert.deepStrictEqual(
			rows.map((row) => row.path),
			['pay', 'pay[].code']
		);
		const renamed = jsonSchemaFromRows(
			rows.map((row) =>
				row.path === 'pay[].code' ? { ...row, path: 'pay[].ref', required: true } : row
			),
			held
		);
		assert.deepStrictEqual(renamed.properties, {
			pay: {
				type: 'array',
				items: {
					type: 'object',
					allOf: [{ if: {}, then: { required: ['code'] } }],
					properties: { ref: { type: 'string', minLength: 1 } },
					required: ['ref']
				}
			}
		});
		const added = jsonSchemaFromRows(
			[...rows, { path: 'meta.started', type: 'date', label: 'Started' }, {}],
			held
		);
		assert.deepStrictEqual(added.properties, {
			...held.properties,
			meta: {
				type: 'object',
				properties: { started: { type: 'string', format: 'date', title: 'Started' } }
			},
			field_4: { type: 'string' }
		});
	});
});
