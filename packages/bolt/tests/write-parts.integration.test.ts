// A large act commits as bounded statements of one transaction: its rows, roll-ups, `seq`, history and records land
// together, its effects run once over the whole act, and a later statement's failure takes the earlier ones with it.
import { Context, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { manifest as base, NOW } from './write-fixture.ts';

const LINES = 2_500;
const lines = base.exposures.lines;
if (lines?.create === undefined) throw new Error('The write fixture needs a lines create.');
/** The write fixture with an effect on each created line. */
const manifest: EngineManifest = {
	...base,
	exposures: { ...base.exposures, lines: { ...lines, create: { ...lines.create, effect: true } } }
};
const EffectInput = Schema.Struct({
	ids: Schema.Array(Schema.String),
	changes: Schema.Array(Schema.Struct({ before: Schema.Null, after: Schema.Struct({ label: Schema.String }) }))
});
/** An act map over the write fixture's models, which the type registry does not name. */
const untyped = (acts: { readonly [callable: string]: Json }) => acts;

describe('a large act', () => {
	it.live('commits as bounded statements of one transaction, all or nothing', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = Context.get(yield* Layer.build(TestDb.layer(manifest)), TenantDb);
				const statements: number[] = [];
				let stale: string | undefined;
				const counted = TenantDb.typed({
					...db,
					transaction: (batch) =>
						Effect.gen(function* () {
							statements.push(batch.statements.length);
							// a write between the plan and the commit: the act's last statement finds this row moved
							if (stale !== undefined)
								yield* db.write({ text: 'UPDATE lines SET revision = revision + 1 WHERE id::text = $1', params: [stale] });
							return yield* db.transaction(batch);
						})
				});
				const context = yield* Layer.build(
					TestWorkspace.layer({ manifest, now: NOW, db: Layer.succeed(TenantDb, counted) })
				);
				const t = Context.get(context, TestWorkspace);
				const admin = yield* t.as(t.admin);
				const state = t.db.value(
					Schema.Struct({
						lines: Schema.Number,
						changed: Schema.Number,
						history: Schema.Number,
						total: Schema.String,
						number: Schema.String,
						revision: Schema.Number
					}),
					{
						text: `SELECT jsonb_build_object('lines', (SELECT count(*)::int FROM lines), 'changed', (SELECT count(*)::int FROM lines WHERE amount = 2),
						'history', (SELECT count(*)::int FROM bolt_history WHERE collection = 'lines'), 'total', total::text, 'number', number, 'revision', revision)
						FROM orders WHERE title = 'Large'`,
						params: []
					}
				);

				const created = yield* admin.act(
					untyped({
						'orders.create': [
							{ title: 'Large', lines: Array.from({ length: LINES }, (_, i) => ({ label: `line ${i}`, amount: '1.00' })) }
						]
					})
				);
				// 2,501 rows: three statements in one transaction, after the table their rows wait in for the effects
				expect(statements).toContain(4);
				const done = yield* state;
				expect(done).toMatchObject({ lines: LINES, changed: 0, history: LINES, total: '2500.00', number: 'PO-2026-0001' });
				// each later statement's roll-up moved the order: its record names the revision it holds now
				expect(created.records).toHaveLength(LINES + 1);
				expect(created.records.find((record) => record.model === 'orders')?.revision).toBe(done.revision);
				// one effect run for the act, every line's change in it, in id order, as an unsplit act queues it
				const effects = yield* t.db.rows(Schema.Struct({ input: Schema.Json }), {
					text: "SELECT input FROM sys_run WHERE automation = 'lines.effect.create'",
					params: []
				});
				expect(effects).toHaveLength(1);
				const effect = yield* Schema.decodeUnknownEffect(EffectInput)(effects[0]?.input);
				expect(effect.changes).toHaveLength(LINES);
				expect(effect.ids).toEqual([...effect.ids].sort());
				expect(new Set(effect.changes.map((change) => change.after.label)).size).toBe(LINES);

				const ids = yield* t.db.rows(Schema.Struct({ id: Schema.String, revision: Schema.Number }), {
					text: 'SELECT id::text, revision FROM lines',
					params: []
				});
				stale = ids.at(-1)?.id;
				statements.length = 0;
				const failed = yield* admin
					.act(untyped({ 'lines.update': ids.map((target) => ({ target, set: { amount: '2.00' } })) }))
					.pipe(Effect.flip);
				stale = undefined;
				expect(statements).toContain(4);
				expect(failed._tag).toBe('ActConflict');
				// the first two statements' updates went with the third's conflict
				expect(yield* state).toMatchObject({ changed: 0, total: '2500.00', revision: done.revision });
			})
		)
	);
});
