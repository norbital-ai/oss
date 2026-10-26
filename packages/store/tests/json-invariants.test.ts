import { expect, it } from '@effect/vitest';
import { Effect, Exit, Schema } from 'effect';
import { inputSchema } from '@norbital-ai/std/kind';
import { build, schema, table, type FieldSpec, type Json, type TableSpec } from '../src/index.ts';
import { database, exec, script } from './support.ts';

type Case = { kind: FieldSpec; valid: readonly Json[]; invalid: readonly Json[] };
const file = { id: 'file', name: 'file.bin', mime: 'application/octet-stream' };
const cases: readonly Case[] = [
	{ kind: { kind: 'object', fields: {} }, valid: [{}], invalid: [{ extra: 1 }, [], null] },
	{
		kind: { kind: 'object', fields: { note: { kind: 'text', optional: true } } },
		valid: [{}, { note: null }, { extra: [1, 2] }],
		invalid: [{ note: 1 }, []]
	},
	{
		kind: { kind: 'object', fields: { value: { kind: 'json' } } },
		valid: [{ value: {} }, { value: [] }],
		invalid: [{}, { value: null }]
	},
	{
		kind: { kind: 'object', fields: { count: { kind: 'int', default: 3 } } },
		valid: [{}, { count: null }, { count: 2 }],
		invalid: [{ count: '2' }, { count: 1.5 }]
	},
	{
		kind: {
			kind: 'object',
			fields: { fixed: { kind: 'text' } },
			rest: { kind: 'int', optional: true }
		},
		valid: [{ fixed: 'x' }, { fixed: 'x', a: 1, b: null }],
		invalid: [{ a: 1 }, { fixed: 'x', a: 'wrong' }]
	},
	{
		kind: {
			kind: 'union',
			by: 'kind',
			arms: {
				text: { value: { kind: 'text' } },
				empty: {},
				shadow: { kind: { kind: 'int' } }
			}
		},
		valid: [{ kind: 'text', value: 'x' }, { kind: 'empty', ignored: true }, { kind: 'shadow' }],
		invalid: [{}, { kind: 'unknown' }, { kind: 3 }, { kind: 'text', value: null }]
	},
	{
		kind: {
			kind: 'union',
			of: [{ kind: 'int' }, { kind: 'object', fields: { ok: { kind: 'bool' } } }]
		},
		valid: [3, { ok: true }],
		invalid: [null, '3', { ok: 'true' }]
	},
	{
		kind: {
			kind: 'list',
			min: 1,
			max: 2,
			of: { kind: 'object', optional: true, fields: { name: { kind: 'text' } } }
		},
		valid: [[null], [{ name: 'x' }, null]],
		invalid: [[], [null, null, null], [{ name: null }]]
	},
	{
		kind: { kind: 'record', of: { kind: 'enum', values: ['a', 'b'] } },
		valid: [{}, { first: 'a', second: 'b' }],
		invalid: [[], { first: null }, { first: 'c' }]
	},
	{
		kind: { kind: 'file', accept: ['application/pdf'], max: '1MB' },
		valid: [file, { ...file, size: -1 }, { ...file, ignored: true }],
		invalid: [
			{ ...file, size: null },
			{ ...file, size: 1.5 },
			{ id: 'x', name: 'x' },
			{ ...file, id: 3 }
		]
	},
	{
		kind: { kind: 'file', accept: [], max: '1MB', multiple: true },
		valid: [[], Array.from({ length: 25 }, () => file)],
		invalid: [[null], [file, {}]]
	},
	{
		kind: { kind: 'text', many: true, optional: true, max: 2 },
		valid: [null, [], ['a', '😀']],
		invalid: [[null], ['long'], 'a']
	},
	{
		kind: { kind: 'custom', of: 'opaque', many: true, optional: true },
		valid: [null, [], [null, {}, 1]],
		invalid: [{}, 'x']
	},
	{ kind: { kind: 'json' }, valid: [null, false, 1, 'x', [], {}], invalid: [] },
	{
		kind: { kind: 'object', optional: true, fields: { value: { kind: 'number', min: 0, max: 2 } } },
		valid: [null, { value: 1.5 }],
		invalid: [{}, { value: -1 }, { value: 3 }]
	},
	{
		kind: {
			kind: 'object',
			fields: {
				day: { kind: 'date' },
				amount: { kind: 'decimal', scale: 2 },
				at: { kind: 'instant' },
				id: { kind: 'id', of: 'entry' },
				clock: { kind: 'time' }
			}
		},
		valid: [
			{
				day: '2000-02-29',
				amount: { $dec: '1.20' },
				at: '2026-10-25T01:02:03.000Z',
				id: '0199a000-0000-7000-8000-000000000001',
				clock: '23:59:59.12'
			}
		],
		invalid: [{ day: '2026-02-29', amount: 'x', at: 'bad', id: 'not-id', clock: '24:00' }]
	}
];

it.effect(
	'direct persisted JSON matches the shared kind codec for structures, defaults, nulls and unions',
	() =>
		Effect.gen(function* () {
			const tables = Object.fromEntries(
				cases.map((test, index): [string, TableSpec] => [
					`case_${index}`,
					table({ key: 'text', fields: { value: { kind: 'json', shape: test.kind } } })
				])
			);
			const pg = yield* database;
			yield* script(pg, (yield* build(schema(tables))).join(';\n'));
			for (const [index, test] of cases.entries()) {
				const codec = inputSchema(test.kind);
				const groups: readonly (readonly [boolean, readonly Json[]])[] = [
					[true, test.valid],
					[false, test.invalid]
				];
				for (const [accepted, values] of groups)
					for (const [row, value] of values.entries()) {
						expect(
							Exit.isSuccess(yield* Effect.exit(Schema.decodeUnknownEffect(codec)(value)))
						).toBe(accepted);
						const operation = Effect.tryPromise({
							try: () =>
								pg.query(`INSERT INTO case_${index}(id,value) VALUES ($1,$2::jsonb)`, [
									`${accepted}-${row}`,
									JSON.stringify(value)
								]),
							catch: (error: unknown) => error
						});
						if (accepted) yield* operation;
						else
							expect(
								yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.String }))(
									yield* Effect.flip(operation)
								)
							).toEqual({ code: '23514' });
					}
			}
		})
);

it.effect('SQL NULL, JSON null and a JSON null default retain their distinct meanings', () =>
	Effect.gen(function* () {
		const pg = yield* database;
		yield* script(
			pg,
			(yield* build(
				schema({
					entry: table({
						key: 'text',
						fields: {
							required: { kind: 'json', default: null },
							nullable: { kind: 'json', optional: true }
						}
					})
				})
			)).join(';\n')
		);
		yield* script(
			pg,
			"INSERT INTO entry(id) VALUES ('default'); INSERT INTO entry(id,required,nullable) VALUES ('explicit','null'::jsonb,'null'::jsonb)"
		);
		expect(
			yield* exec(pg)({
				text: "SELECT id,required IS NULL AS sql_null,required='null'::jsonb AS json_null,nullable IS NULL AS nullable_sql FROM entry ORDER BY id",
				params: []
			})
		).toEqual([
			{ id: 'default', sql_null: false, json_null: true, nullable_sql: true },
			{ id: 'explicit', sql_null: false, json_null: true, nullable_sql: false }
		]);
		const failure = yield* Effect.flip(
			Effect.tryPromise({
				try: () => pg.query("INSERT INTO entry(id,required) VALUES ('null',NULL)"),
				catch: (error: unknown) => error
			})
		);
		expect(
			yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.String }))(failure)
		).toEqual({ code: '23502' });
	})
);
