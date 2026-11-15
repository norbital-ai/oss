import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { build, schema, schema_snapshot, store, table } from '../src/index.ts';
import { database, run, script } from './support.ts';

const ROWS = 10_000;
const ms = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const started = performance.now();
		const value = yield* effect;
		return [value, performance.now() - started] as const;
	});
const declaration = schema({
	facility: table({ key: 'text', fields: { name: { kind: 'text' } }, record_label: 'name' }),
	// a stored own-field label: each `+` reads its operands several times
	line: table({
		key: 'text',
		fields: {
			facility: { kind: 'ref', to: 'facility' },
			reference: { kind: 'text', optional: true },
			product: { kind: 'text' },
			currency: { kind: 'text' },
			amount: { kind: 'decimal', scale: 2 }
		},
		record_label:
			"(record.reference != null ? record.reference : string(record.product)) + ' · ' + record.currency + ' ' + string(record.amount)"
	}),
	// a live label through a relation, resolved when read
	charge: table({
		key: 'text',
		fields: { facility: { kind: 'ref', to: 'facility' }, code: { kind: 'text' } },
		record_label: "record.facility.name + ' · ' + record.code"
	})
});

describe('record label cost', () => {
	// Unfenced, the planner copies a `+`'s left operand into every place it is read: a chain of four cost 5^4 copies of
	// its first term (200 rows took 30 s). Fenced, each operand is evaluated once per row and each relation once per read.
	it.live(
		`a chained stored label and a relation label stay linear over ${ROWS} rows`,
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const pg = yield* database;
					const statements = yield* build((yield* schema_snapshot(declaration)).schema);
					yield* script(pg, `${statements.join(';\n')};`);
					// plan shape: every `+` of the stored label reads its operands from one fenced row
					const fn = statements.find((s) => s.includes('bolt_record_label_line_')) ?? '';
					expect(fn.match(/AS right_value OFFSET 0\)/g)).toHaveLength(4);

					yield* script(pg, "insert into facility (id, name) values ('f1', 'Harbour'), ('f2', 'Meridian')");
					const [, insert] = yield* ms(
						script(
							pg,
							`insert into line (id, facility, reference, product, currency, amount)
							select 'l' || n, 'f' || (1 + n % 2), case when n % 2 = 0 then 'R' || n end, 'if', 'USD', n
							from generate_series(1, ${ROWS}) n;
							insert into charge (id, facility, code) select 'c' || n, 'f' || (1 + n % 2), 'C' || n from generate_series(1, ${ROWS}) n`
						)
					);
					const labels = yield* Effect.promise(() =>
						pg.query<{ bolt_record_label: string }>(
							"select bolt_record_label from line where id in ('l1', 'l2') order by id"
						)
					);
					expect(labels.rows).toEqual([
						{ bolt_record_label: 'if · USD 1' },
						{ bolt_record_label: 'R2 · USD 2' }
					]);
					expect(insert).toBeLessThan(30_000);

					const db = store(declaration),
						execute = run(pg);
					const [page, first] = yield* ms(
						Effect.flatMap(db.read('charge', { order_by: 'id', limit: 50 }), execute)
					);
					expect(page.rows).toHaveLength(50);
					const [all, scan] = yield* ms(
						Effect.flatMap(db.read('charge', { order_by: 'id', all: true }), execute)
					);
					expect(all.rows).toHaveLength(ROWS);
					expect(first).toBeLessThan(1_000);
					expect(scan).toBeLessThan(2_000);
				})
			),
		120_000
	);
});
