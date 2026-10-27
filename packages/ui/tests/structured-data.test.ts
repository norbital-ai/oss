import './resolve.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Decimal } from '@norbital-ai/std/decimal';
import {
	dataChanged,
	dataDefaults,
	dataEntries,
	dataEqual,
	inferJsonSchema,
	kindJsonSchema,
	pairDataRows,
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
		inferJsonSchema([
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
	assert.deepEqual(inferJsonSchema([]), { type: 'array', items: {} });
	assert.deepEqual(inferJsonSchema([false, 0, '', null]), {
		type: 'array',
		items: { type: ['boolean', 'integer', 'string', 'null'] }
	});
	assert.deepEqual(inferJsonSchema(undefined), {});
});

it('equality distinguishes missing, null, false, zero and empty text, ignoring object key order', () => {
	const values = [undefined, null, false, 0, ''];
	for (const [i, before] of values.entries())
		for (const [j, value] of values.entries()) assert.equal(dataEqual(before, value), i === j);
	assert.equal(dataEqual({ b: 0, a: false }, { a: false, b: 0 }), true);
	assert.equal(dataEqual({ value: null }, {}), false);
	assert.equal(dataEqual([1, 2], [2, 1]), false);
});

it('decimals remain opaque, exact values and masks do not expose their internals', () => {
	const held = Decimal.of('9007199254740993.10');
	assert.equal(dataEntries(held), undefined);
	assert.equal(dataEqual(held, Decimal.of('9007199254740993.100')), true);
	assert.equal(dataEqual(held, Decimal.of('9007199254740993.11')), false);
	assert.equal(dataEqual(held, '9007199254740993.10'), false);
	assert.deepEqual(inferJsonSchema(held), { type: 'number' });
	assert.equal(dataEntries({ $masked: true }), undefined);
	assert.equal(dataEqual({ $masked: true, a: 1 }, { $masked: true, a: 2 }), true);
	assert.deepEqual(inferJsonSchema({ $masked: true }), {});
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
	const pairs = pairDataRows(before, value, ['family', 'code']);
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
		dataChanged(
			{ rows: before.slice(0, 2) },
			{ rows: [before[1], before[0]] },
			{ '/rows': ['family', 'code'] }
		),
		false
	);
	assert.equal(
		dataChanged({ rows: before }, { rows: value }, { '/rows': ['family', 'code'] }),
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
		pairDataRows(before, value, 'code').map((pair) => pair.beforeIndex),
		[0, 1]
	);
	assert.equal(dataChanged(before, value, { '': 'code' }), true);
	assert.deepEqual(
		pairDataRows([{ code: null }], [{ code: 'b' }], 'code').map((pair) => pair.beforeIndex),
		[0]
	);
	assert.equal(
		dataChanged(
			{ 'a/b': { '~rows': [{ code: 'a' }, { code: 'b' }] } },
			{ 'a/b': { '~rows': [{ code: 'b' }, { code: 'a' }] } },
			{ '/a~1b/~0rows': 'code' }
		),
		false
	);
});

it('native kind descriptions retain structure, hidden fields and primitive semantics', () => {
	assert.deepEqual(
		kindJsonSchema({
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
			description: undefined,
			type: 'object',
			properties: {
				active: { title: undefined, description: undefined, type: 'boolean' },
				amount: {
					title: undefined,
					description: undefined,
					type: 'number',
					minimum: 0,
					maximum: undefined
				}
			},
			required: ['amount']
		}
	);
	const period = kindJsonSchema({ kind: 'period', of: 'instant' });
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
	assert.deepEqual(structuredSchema(plan.properties!.rate, root, 2), {
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
	const variants = {
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
