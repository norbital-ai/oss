import type { PGlite } from '@electric-sql/pglite';
import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { build, constraintIndex, schema, table, type FieldSpec, type Sql } from '../src/index.ts';
import { database, exec, script } from './support.ts';

const rejected = Effect.fnUntraced(function* (pg: PGlite, statement: Sql) {
	const error = yield* Effect.flip(
		Effect.tryPromise({
			try: () => pg.query(statement.text, [...statement.params]),
			catch: (cause: unknown) => cause
		})
	);
	return yield* Schema.decodeUnknownEffect(
		Schema.Struct({ code: Schema.String, constraint: Schema.String })
	)(error);
});
const cases: readonly { name: string; field: FieldSpec; value: string }[] = [
	{
		name: 'bigint',
		field: { kind: 'int', storage: 'int64', optional: true },
		value: '9223372036854775807'
	},
	{ name: 'double precision', field: { kind: 'number', optional: true }, value: '0.125' }
];

for (const { name, field, value } of cases) {
	it.effect(
		`enforces nullable ${name} identities in partial uniqueness and overlap constraints`,
		() =>
			Effect.gen(function* () {
				const records = schema({
					partial_key: table({
						audit: true,
						key: 'text',
						fields: { account: field, label: { kind: 'text' }, active: { kind: 'bool' } },
						unique: [{ fields: ['account', 'label'], where: { active: { eq: true } } }]
					}),
					booking: table({
						audit: true,
						key: 'text',
						fields: { account: field, window: { kind: 'period', of: 'date' } },
						noOverlap: [{ key: ['account'], period: 'window' }]
					})
				});
				const pg = yield* database;
				yield* script(pg, `${(yield* build(records)).join(';\n')};`);
				const constraints = yield* constraintIndex(records);
				for (const { id, account } of [
					{ id: 'null', account: null },
					{ id: 'zero', account: '0' },
					{ id: 'nonzero', account: value }
				]) {
					yield* exec(pg)({
						text: 'INSERT INTO partial_key (id, account, label, active) VALUES ($1, $2, $3, true)',
						params: [id, account, 'shared']
					});
					yield* exec(pg)({
						text: 'INSERT INTO booking (id, account, "window") VALUES ($1, $2, $3::daterange)',
						params: [id, account, '[2026-10-01,2026-10-05)']
					});
				}
				for (const account of [null, '0', value]) {
					const duplicate = yield* rejected(pg, {
						text: 'INSERT INTO partial_key (id, account, label, active) VALUES ($1, $2, $3, true)',
						params: ['duplicate', account, 'shared']
					});
					expect(duplicate.code).toBe('23P01');
					expect(constraints.get(duplicate.constraint)).toMatchObject({
						model: 'partial_key',
						kind: 'unique',
						fields: ['account', 'label']
					});
					const overlap = yield* rejected(pg, {
						text: 'INSERT INTO booking (id, account, "window") VALUES ($1, $2, $3::daterange)',
						params: ['overlap', account, '[2026-10-03,2026-10-06)']
					});
					expect(overlap.code).toBe('23P01');
					expect(constraints.get(overlap.constraint)).toMatchObject({
						model: 'booking',
						kind: 'overlap',
						fields: ['account', 'window']
					});
				}
				yield* script(
					pg,
					`
				INSERT INTO partial_key (id, account, label, active) VALUES
					('inactive', NULL, 'shared', false), ('other-label', NULL, 'other', true);
				INSERT INTO booking (id, account, "window") VALUES
					('adjacent', NULL, '[2026-10-05,2026-10-08)'::daterange);
			`
				);
				expect(
					yield* exec(pg)({
						text: 'SELECT account::text AS account FROM partial_key WHERE id = $1',
						params: ['nonzero']
					})
				).toEqual([{ account: value }]);
				expect(
					yield* exec(pg)({
						text: 'SELECT (SELECT count(*)::int FROM partial_key) AS partial, (SELECT count(*)::int FROM booking) AS bookings',
						params: []
					})
				).toEqual([{ partial: 5, bookings: 4 }]);
			})
	);
}
