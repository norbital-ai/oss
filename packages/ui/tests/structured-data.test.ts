import './resolve.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Decimal } from '@norbital-ai/std/decimal';
import type { JsonSchema } from '../src/kinds/json-schema.ts';
import {
	data_changed,
	dataDefaults,
	dataEntries,
	data_equal,
	infer_json_schema,
	kind_json_schema,
	pair_data_rows,
	structuredSchema
} from '../src/kinds/structured-data.ts';

it('a new form fills schema defaults only into absent or null places', () => {
	const schema = {
		type: 'object',
		properties: {
			name: { type: 'string' },
			controls: { type: 'boolean', default: false },
			tax: { type: 'boolean', default: false },
			nested: { type: 'object', properties: { code: { type: 'string', default: 'X' } } }
		}
	};
	assert.deepEqual(dataDefaults(schema, { name: 'A', nested: {}, extra: 1 }), {
		name: 'A',
		controls: false,
		tax: false,
		nested: { code: 'X' },
		extra: 1
	});
	assert.equal(
		dataDefaults(schema, { name: 'A', controls: true, tax: false, nested: { code: 'X' } }),
		undefined
	);
	const list = {
		type: 'array',
		items: { type: 'object', properties: { code: { type: 'string', default: 'D' } } }
	};
	assert.deepEqual(dataDefaults(list, [{}, { code: 'A' }]), [{ code: 'D' }, { code: 'A' }]);
});

it('inference merges every record and nested list without inventing constraints', () => {
	assert.deepEqual(
		infer_json_schema([
			{ code: 'a', amount: 1, rows: [{ enabled: false }] },
			{ code: 'b', amount: 1.5, rows: [{ note: '' }], date: '2026-10-25' }
		]),
		{
			type: 'array',
			items: {
				type: 'object',
				properties: {
					code: { type: 'string' },
					amount: { type: 'number' },
					rows: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								enabled: { type: 'boolean' },
								note: { type: 'string' }
							}
						}
					},
					date: { type: 'string' }
				}
			}
		}
	);
	assert.deepEqual(infer_json_schema([]), { type: 'array', items: {} });
	assert.deepEqual(infer_json_schema([false, 0, '', null]), {
		type: 'array',
		items: { type: ['boolean', 'integer', 'string', 'null'] }
	});
	assert.deepEqual(infer_json_schema(undefined), {});
});

it('equality distinguishes missing, null, false, zero and empty text, ignoring object key order', () => {
	const values = [undefined, null, false, 0, ''];
	for (const [i, before] of values.entries())
		for (const [j, value] of values.entries()) assert.equal(data_equal(before, value), i === j);
	assert.equal(data_equal({ b: 0, a: false }, { a: false, b: 0 }), true);
	assert.equal(data_equal({ value: null }, {}), false);
	assert.equal(data_equal([1, 2], [2, 1]), false);
});

it('decimals remain opaque and exact values do not expose their internals', () => {
	const held = Decimal.of('9007199254740993.10');
	assert.equal(dataEntries(held), undefined);
	assert.equal(data_equal(held, Decimal.of('9007199254740993.100')), true);
	assert.equal(data_equal(held, Decimal.of('9007199254740993.11')), false);
	assert.equal(data_equal(held, '9007199254740993.10'), false);
	assert.deepEqual(infer_json_schema(held), { type: 'number' });
});

it('composite identities pair new row order and append removed rows without pairing unrelated records', () => {
	const before = [
		{ family: 'leave', code: 'a', value: 1 },
		{ family: 'tax', code: 'a', value: 2 },
		{ family: 'leave', code: 'old', value: 3 }
	];
	const value = [
		{ family: 'tax', code: 'a', value: 5 },
		{ family: 'leave', code: 'a', value: 1 },
		{ family: 'leave', code: 'new', value: 4 }
	];
	const pairs = pair_data_rows(before, value, ['family', 'code']);
	assert.deepEqual(
		pairs.map((pair) => [pair.beforeIndex, pair.index]),
		[
			[1, 0],
			[0, 1],
			[undefined, 2],
			[2, undefined]
		]
	);
	assert.equal(pairs[0].before, before[1]);
	assert.equal(pairs[0].value, value[0]);
	assert.equal(
		data_changed(
			{ rows: before.slice(0, 2) },
			{ rows: [before[1], before[0]] },
			{ '/rows': ['family', 'code'] }
		),
		false
	);
	assert.equal(
		data_changed({ rows: before }, { rows: value }, { '/rows': ['family', 'code'] }),
		true
	);
});

it('ambiguous or absent identities fall back to positional semantics', () => {
	const before = [
		{ code: 'a', value: 1 },
		{ code: 'a', value: 2 }
	];
	const value = [
		{ code: 'a', value: 2 },
		{ code: 'a', value: 1 }
	];
	assert.deepEqual(
		pair_data_rows(before, value, 'code').map((pair) => pair.beforeIndex),
		[0, 1]
	);
	assert.equal(data_changed(before, value, { '': 'code' }), true);
	assert.deepEqual(
		pair_data_rows([{ code: null }], [{ code: 'b' }], 'code').map((pair) => pair.beforeIndex),
		[0]
	);
	assert.equal(
		data_changed(
			{ 'a/b': { '~rows': [{ code: 'a' }, { code: 'b' }] } },
			{ 'a/b': { '~rows': [{ code: 'b' }, { code: 'a' }] } },
			{ '/a~1b/~0rows': 'code' }
		),
		false
	);
});

it('native kind descriptions retain structure, hidden fields and primitive semantics', () => {
	assert.deepEqual(
		kind_json_schema({
			kind: 'object',
			label: 'Profile',
			fields: {
				active: { kind: 'bool', optional: true },
				amount: { kind: 'decimal', scale: 2, min: 0 },
				hidden: { kind: 'text', hidden: true }
			}
		}),
		{
			title: 'Profile',
			type: 'object',
			properties: {
				active: { type: 'boolean' },
				amount: { type: 'number', minimum: 0 }
			},
			required: ['amount']
		}
	);
	const period = kind_json_schema({ kind: 'period', of: 'instant' });
	assert.ok(typeof period !== 'boolean');
	assert.deepEqual(period.properties?.end, { type: ['string', 'null'], format: 'date-time' });
});

it('display plans fold local structural allOf without changing the source schema', () => {
	const root = {
		$defs: {
			row: {
				type: 'object',
				required: ['code'],
				properties: {
					code: { type: 'string', title: 'Circuit' },
					rate: { type: 'number', minimum: 0 }
				}
			}
		}
	};
	const schema = {
		type: 'object',
		allOf: [{ $ref: '#/$defs/row' }],
		required: ['_page'],
		properties: { _page: { type: 'integer', title: 'Page' }, rate: { type: 'number', maximum: 10 } }
	};
	const original = structuredClone(schema);
	const plan = structuredSchema(schema, root, { code: 'A', _page: 1, rate: 2 });
	assert.ok(typeof plan !== 'boolean');
	assert.equal(plan.allOf, undefined);
	assert.deepEqual(plan.required, ['_page', 'code']);
	assert.deepEqual(plan.properties?.code, { type: 'string', title: 'Circuit' });
	assert.deepEqual(plan.properties?.rate, {
		allOf: [
			{ type: 'number', maximum: 10 },
			{ type: 'number', minimum: 0 }
		]
	});
	assert.ok(plan.properties);
	assert.ok(plan.properties.rate);
	assert.deepEqual(structuredSchema(plan.properties.rate, root, 2), {
		type: 'number',
		maximum: 10,
		minimum: 0
	});
	assert.deepEqual(schema, original);
	const conflict = {
		allOf: [
			{ type: 'string', pattern: '^a' },
			{ type: 'string', pattern: 'b$' }
		]
	};
	assert.deepEqual(structuredSchema(conflict, conflict, 'ab'), conflict);
	assert.equal(structuredSchema({ allOf: [{ type: 'string' }, { type: 'number' }] }, {}), false);
});

it('variants select one observed type or discriminator and remain intact for schema-only or ambiguity', () => {
	const variants: JsonSchema = {
		title: 'Response',
		oneOf: [
			{ type: 'object', properties: { kind: { const: 'ok' }, count: { type: 'integer' } } },
			{ type: 'object', properties: { kind: { const: 'error' }, reason: { type: 'string' } } }
		]
	};
	const chosen = structuredSchema(variants, variants, { kind: 'ok', count: 0 });
	assert.ok(typeof chosen !== 'boolean');
	assert.equal(chosen.oneOf, undefined);
	assert.equal(chosen.title, 'Response');
	assert.deepEqual(chosen.properties?.count, { type: 'integer' });
	assert.deepEqual(structuredSchema(variants, variants), variants);
	assert.deepEqual(structuredSchema(variants, variants, {}), variants);
	const numeric = { anyOf: [{ type: 'string' }, { type: 'number' }] };
	assert.deepEqual(structuredSchema(numeric, numeric, 0), { type: 'number' });
	const ambiguous = { anyOf: [{ type: 'number' }, { type: 'integer' }] };
	assert.deepEqual(structuredSchema(ambiguous, ambiguous, 1), ambiguous);
	const unknown = { anyOf: [{ type: 'string' }, {}] };
	assert.deepEqual(structuredSchema(unknown, unknown, 'a'), unknown);
	const enums = { anyOf: [{ enum: [0, false] }, { enum: [1, true] }] };
	assert.deepEqual(structuredSchema(enums, enums, false), { enum: [0, false] });
});

it('display resolution retains unsupported references and stops local cycles', () => {
	const cycle = { $defs: { loop: { $ref: '#/$defs/loop' } } };
	const ref = { $ref: '#/$defs/loop' };
	assert.deepEqual(structuredSchema(ref, cycle), ref);
	const remote = { $ref: 'https://example.com/schema' };
	assert.deepEqual(structuredSchema(remote, remote), remote);
	assert.equal(structuredSchema({ $ref: '#/$defs/never' }, { $defs: { never: false } }), false);
});
