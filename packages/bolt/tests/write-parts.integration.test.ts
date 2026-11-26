// A large act commits as bounded statements of one transaction: its rows, roll-ups, `seq`, history and records land
// together, its effects run once over the whole act, and a later statement's failure takes the earlier ones with it.
// Deletes, erasures and restores split the same way.
import { randomUUID } from 'node:crypto';
import { Context, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { catalog_of } from '../src/engine/access/pred.ts';
import { parts, type Commit, type Write } from '../src/engine/write/commit.ts';
import { admin as fixtureAdmin, manifest as base, NOW } from './write-fixture.ts';

// one row past two full statements (`PART.rows` is 1,000): the smallest act with a first, a middle and a last statement
const LINES = 2_001;
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
				// 2,002 rows: three statements in one transaction, after the table their rows wait in for the effects
				expect(statements).toContain(4);
				const done = yield* state;
				expect(done).toMatchObject({ lines: LINES, changed: 0, history: LINES, total: `${LINES}.00`, number: 'PO-2026-0001' });
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
				expect(yield* state).toMatchObject({ changed: 0, total: `${LINES}.00`, revision: done.revision });
			})
		)
	);
});

/** A workspace holding one order of `LINES` lines; `gates` counts each transaction's act statements, `stale` moves a line before the next. */
const large = Effect.fnUntraced(function* () {
	const db = Context.get(yield* Layer.build(TestDb.layer(manifest)), TenantDb);
	const gates: number[] = [];
	let stale: string | undefined;
	const counted = TenantDb.typed({
		...db,
		transaction: (batch) =>
			Effect.gen(function* () {
				// every statement of a split act opens or follows its gate; one statement names none
				gates.push(batch.statements.filter((statement) => statement.text.includes("'bolt.gate'")).length);
				if (stale !== undefined)
					yield* db.write({ text: 'UPDATE lines SET revision = revision + 1 WHERE id::text = $1', params: [stale] });
				stale = undefined;
				return yield* db.transaction(batch);
			})
	});
	const t = Context.get(
		yield* Layer.build(TestWorkspace.layer({ manifest, now: NOW, db: Layer.succeed(TenantDb, counted) })),
		TestWorkspace
	);
	const admin = yield* t.as(t.admin);
	yield* admin.act(
		untyped({
			'orders.create': [
				{ title: 'Large', lines: Array.from({ length: LINES }, (_, i) => ({ label: `line ${i}`, amount: '1.00' })) }
			]
		})
	);
	const lines = t.db.rows(Schema.Struct({ id: Schema.String, revision: Schema.Number }), {
		text: 'SELECT id::text, revision FROM lines ORDER BY id',
		params: []
	});
	gates.length = 0;
	return {
		t,
		admin,
		gates,
		lines,
		stale: (id: string | undefined) => {
			stale = id;
		}
	};
});

describe('a large delete, erasure or restore', () => {
	it.live('a delete commits as bounded statements of one transaction, all or nothing', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, admin, gates, lines, stale } = yield* large();
				const ids = yield* lines;
				const remove = () =>
					Effect.flatMap(lines, (rows) => admin.act(untyped({ 'lines.delete': rows.map((target) => ({ target })) })));
				const state = t.db.value(
					Schema.Struct({ lines: Schema.Number, total: Schema.String, deleted: Schema.Number, transactions: Schema.Number }),
					{
						text: `SELECT jsonb_build_object('lines', (SELECT count(*)::int FROM lines), 'total', (SELECT total::text FROM orders WHERE title = 'Large'),
						'deleted', count(*)::int, 'transactions', count(DISTINCT xmin::text)::int) FROM bolt_history WHERE collection = 'lines' AND op = 'delete'`,
						params: []
					}
				);

				// the last statement finds its line moved: the first two statements' deletes go with it
				stale(ids.at(-1)?.id);
				expect((yield* remove().pipe(Effect.flip))._tag).toBe('ActConflict');
				expect(gates).toContain(3);
				expect(yield* state).toEqual({ lines: LINES, total: `${LINES}.00`, deleted: 0, transactions: 0 });

				const before = new Map((yield* lines).map((line) => [line.id, line.revision]));
				gates.length = 0;
				const removed = yield* remove();
				expect(gates).toContain(3);
				expect(yield* state).toEqual({ lines: 0, total: '0.00', deleted: LINES, transactions: 1 });
				// an earlier statement's delete answers the revision it wrote, as one statement's would
				expect(removed.records).toHaveLength(LINES);
				expect(removed.records.every((record) => record.revision === (before.get(record.id) ?? 0) + 1)).toBe(true);
			})
		)
	);
	it.live('an erasure removes or anonymises across bounded statements of one transaction', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const anonymised = yield* large();
				const kept = yield* anonymised.admin.act(
					untyped({ 'lines.erase': { target: yield* anonymised.lines, set: { label: 'erased' } } })
				);
				expect(anonymised.gates).toContain(3);
				expect(kept.records).toHaveLength(LINES);
				// every statement queued its own lines' earlier labels for the purge the durable audit acknowledges
				expect(
					yield* anonymised.t.db.value(
						Schema.Struct({ labels: Schema.Number, queued: Schema.Number, erased: Schema.Number, transactions: Schema.Number }),
						{
							text: `SELECT jsonb_build_object('labels', (SELECT count(*)::int FROM lines WHERE label = 'erased'),
							'queued', (SELECT count(*)::int FROM bolt_audit_erase WHERE collection = 'lines' AND mode = 'anonymise' AND purge = ARRAY['label']),
							'erased', (SELECT count(*)::int FROM bolt_history WHERE collection = 'lines' AND cause = 'erased'),
							'transactions', (SELECT count(DISTINCT xmin::text)::int FROM lines))`,
							params: []
						}
					)
				).toEqual({ labels: LINES, queued: LINES, erased: LINES, transactions: 1 });

				const removed = yield* large();
				const gone = yield* removed.admin.act(
					untyped({ 'lines.erase': { target: yield* removed.lines } })
				);
				expect(removed.gates).toContain(3);
				expect(gone.records).toHaveLength(LINES);
				// each line's erased revision and its queued history removal, written in the act's one transaction
				expect(
					yield* removed.t.db.value(
						Schema.Struct({ lines: Schema.Number, queued: Schema.Number, erased: Schema.Number, transactions: Schema.Number }),
						{
							text: `SELECT jsonb_build_object('lines', (SELECT count(*)::int FROM lines),
							'queued', (SELECT count(*)::int FROM bolt_audit_erase WHERE collection = 'lines' AND mode = 'remove'),
							'erased', count(*)::int, 'transactions', count(DISTINCT xmin::text)::int)
							FROM bolt_history WHERE collection = 'lines' AND cause = 'erased'`,
							params: []
						}
					)
				).toEqual({ lines: 0, queued: LINES, erased: LINES, transactions: 1 });
			})
		)
	);
	it('carries each restore with its record; a delete reaching another written table stays one statement', () => {
		const cat = catalog_of(manifest);
		const ids = Array.from({ length: LINES }, () => randomUUID());
		const commit: Commit = {
			key: 'restore',
			digest: 'restore',
			issuedAt: NOW,
			now: NOW,
			today: NOW.slice(0, 10),
			actor: fixtureAdmin.actor,
			writer: { starter: null, actor: 'member:restorer', depth: 0 },
			writes: ids.map((id): Write => ({ model: 'lines', id, op: 'update', set: { label: 'restored' }, revision: 3 })),
			rate: [],
			runs: [],
			output: null
		};
		const split = parts(manifest, cat, { ...commit, restored: ids.map((id) => ({ model: 'lines', id, revision: 1 })) }) ?? [];
		expect(split.map((x) => x.writes.length)).toEqual([1_000, 1_000, 1]);
		for (const x of split) expect(x.restored?.map((r) => r.id)).toEqual(x.writes.map((w) => w.id));
		// the lines' roll-up moves their order, which the act also writes: a later statement would find it moved
		const deletes = ids.map((id): Write => ({ model: 'lines', id, op: 'delete', revision: 1 }));
		expect(parts(manifest, cat, { ...commit, writes: deletes })).toHaveLength(3);
		expect(
			parts(manifest, cat, {
				...commit,
				writes: [...deletes, { model: 'orders', id: randomUUID(), op: 'update', set: { note: 'moved' }, revision: 1 }]
			})
		).toBeUndefined();
	});
});
