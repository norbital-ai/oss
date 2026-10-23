// engine/write and engine/query on PGlite, the P2 review gaps: erase (38e), history and prune (17), import and export
// (30), same-shape merge (12), relation-action upsert (28), cascades and frozen parents (41), the delete guard (27),
// telemetry (§5.12), pipeline order (19), guest failures (42, 72a), `expired` (31) and the roll-up oracle (21).
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Authority, GuestOutcome, Invocation, Outcome } from '../src/engine/contracts.ts';
import { type EngineError } from '../src/engine/errors.ts';
import { BoltError, type Code } from '../src/protocol/errors.ts';
import { EventSink, TelemetryLive } from '../src/engine/guest/telemetry.ts';
import { Telemetry } from '../src/engine/services.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { PgliteDb } from '../src/engine/db/pglite.ts';
import type { Pred, ReadIR } from '../src/protocol/ir-types.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { readEngine } from '../src/engine/query/engine.ts';
import { pruneHistory, readHistory } from '../src/engine/query/history.ts';
import { act, type ActRequest, type WriteEngine } from '../src/engine/write/act.ts';
import { restorePreview, restoreRecord, type RestoreTarget } from '../src/engine/write/restore.ts';
import { admin, arm, authority, grants, NOW, TODAY } from './write-fixture.ts';
import { manifest } from './write-p2.fixture.ts';

const count = { reads: 0, writes: 0, statements: 0 };
const bindings = { now: NOW, today: TODAY, tz: 'UTC', params: {} };
type Over = Partial<ActRequest> & Pick<ActRequest, 'verb' | 'input'>;
const required = <A>(value: A | undefined, at: string): A => {
	if (value === undefined) throw new Error(`Missing fixture ${at}`);
	return value;
};
const fixture = Effect.gen(function* () {
	const inner = yield* TenantDb;
	const db = TenantDb.typed({
		read: (statements) =>
			Effect.suspend(() => {
				count.reads++;
				count.statements += statements.length;
				return inner.read(statements);
			}),
		write: (statement, lock) =>
			Effect.suspend(() => {
				count.writes++;
				return inner.write(statement, lock);
			}),
		transaction: inner.transaction
	});
	yield* applyPlan(inner, plan(null, manifest), { accept: true });
	count.reads = 0;
	count.writes = 0;
	count.statements = 0;
	let n = 0;
	const run = (over: Over, engine: Partial<WriteEngine> = {}) =>
		act(
			{ manifest, db, ...engine },
			{
				collection: 'orders',
				mode: { _tag: 'Direct' },
				key: `key-${n}`,
				issuedAt: NOW,
				authority: admin,
				bindings,
				invocationId: `inv-${n++}`,
				...over
			}
		);
	return { db, run, nextTitle: () => `order-${n}` };
});
class P2Fixture extends Context.Service<P2Fixture, Effect.Success<typeof fixture>>()(
	'test/P2Fixture'
) {}
const P2FixtureLive = Layer.effect(P2Fixture, fixture).pipe(Layer.provide(PgliteDb.layer()));
const run = Effect.fnUntraced(function* (over: Over, engine: Partial<WriteEngine> = {}) {
	return yield* (yield* P2Fixture).run(over, engine);
});
const rows = Effect.fnUntraced(function* <A>(schema: Schema.Decoder<A>, sql: string) {
	return yield* (yield* P2Fixture).db.rows(schema, { text: sql, params: [] });
});
const one = Effect.fnUntraced(function* <A>(schema: Schema.Decoder<A>, sql: string) {
	return required((yield* rows(schema, sql))[0], sql);
});
const ok = (o: Outcome) => {
	if (o.kind !== 'committed' && o.kind !== 'pendingApproval') throw new Error(JSON.stringify(o));
	return o;
};
const idOf = (o: Outcome, c = 'orders') =>
	required(
		ok(o).records.find((r) => r.collection === c),
		`created ${c}`
	).id;
const order = Effect.fnUntraced(function* (
	title = 'desk',
	lines: { label: string; amount: string }[] = []
) {
	return idOf((yield* run({ verb: 'create', input: { title, lines: { create: lines } } })).outcome);
});
const person = Effect.fnUntraced(function* (
	code: string,
	name: string,
	email: string | null = null
) {
	return idOf(
		(yield* run({ collection: 'people', verb: 'create', input: { code, name, email } })).outcome,
		'people'
	);
});
const Id = Schema.Struct({ id: Schema.String });
const Count = Schema.Struct({ n: Schema.Number });
const Owner = Schema.Struct({ o: Schema.NullOr(Schema.String) });
const Changes = Schema.Record(Schema.String, Schema.Json);
const HistoryRevision = Schema.Struct({
	revision: Schema.Number,
	at: Schema.String,
	cause: Schema.String,
	restoredFrom: Schema.NullOr(Schema.Number),
	changed: Changes,
	actor: Schema.NullOr(Schema.Struct({ kind: Schema.String, id: Schema.String }))
});
const ImportReport = Schema.Struct({
	rows: Schema.Array(
		Schema.Struct({
			index: Schema.NullOr(Schema.Number),
			id: Schema.NullOr(Schema.String),
			action: Schema.Literals(['created', 'updated', 'kept', 'skipped', 'deleted'])
		})
	)
});
const Event = Schema.Struct({
	at: Schema.String,
	severity: Schema.Literals(['info', 'warn', 'error']),
	event: Schema.String,
	invocation: Schema.String,
	run: Schema.NullOr(Schema.String),
	conversation: Schema.NullOr(Schema.String),
	turn: Schema.NullOr(Schema.String),
	attributes: Changes
});
const FALSE: Pred = { t: 'const', value: false };
const REQUEST = '0199a000-0000-7000-8000-0000000000aa';
/** A denied write with source fallback configuration. The fake hook still cannot mutate domain data. */
const routed = (op: 'create' | 'update') =>
	authority({
		orders: grants({
			[op]: [],
			approval: { create: [], update: [], delete: [], [op]: [{ steps: [['finance']] }] }
		})
	});
const holding: Partial<WriteEngine> = {
	approval: {
		route: () =>
			Effect.succeed({
				requestId: REQUEST,
				route: { steps: [['finance']], superseded_by: [] },
				pieces: () => {}
			})
	}
};
function transform(
	body: (inv: Invocation) => GuestOutcome,
	collection = 'orders',
	calls: Invocation[] = []
): Partial<WriteEngine> {
	return {
		transforms: new Set([collection]),
		guest: {
			invokeProgram: () =>
				Effect.die(new Error('This fixture does not execute supplied guest programs.')),
			invoke: (inv) => Effect.sync(() => (calls.push(inv), body(inv)))
		}
	};
}

describe('engine-owned staged transform identities', () => {
	it.effect(
		'exposes genuine root and owned child identities and persists those exact coordinates',
		() =>
			Effect.gen(function* () {
				const calls: Invocation[] = [];
				const result = yield* run(
					{
						verb: 'create',
						input: { title: 'staged', lines: { create: [{ label: 'contract', amount: '1' }] } }
					},
					transform((inv) => ({ kind: 'ok', output: inv.input, cpuMs: 1 }), 'orders', calls)
				);
				ok(result.outcome);
				const staged = required(
					required(calls[0], 'transform call').ctx.staged,
					'staged identities'
				);
				expect(staged).toHaveLength(2);
				const parent = required(
						staged.find((row) => row.collection === 'orders'),
						'staged parent'
					),
					child = required(
						staged.find((row) => row.collection === 'lines'),
						'staged child'
					);
				expect(parent.parent).toBeUndefined();
				expect(child.parent).toEqual({
					collection: 'orders',
					id: parent.id,
					relation: 'lines',
					field: 'order'
				});
				expect(child.path).toEqual(['lines', 'create', 0]);
				expect((yield* one(Id, 'select id::text as id from orders')).id).toBe(parent.id);
				expect(
					yield* one(
						Schema.Struct({ id: Schema.String, owner: Schema.String }),
						'select id::text as id, "order"::text as owner from lines'
					)
				).toEqual({ id: child.id, owner: parent.id });
			}).pipe(Effect.provide(P2FixtureLive))
	);
	it.effect(
		'gives rows a multi-row transform adds fresh ids disjoint from every submitted path, and commits',
		() =>
			Effect.gen(function* () {
				const calls: Invocation[] = [];
				const result = yield* run(
					{ verb: 'create', input: [{ title: 'first' }, { title: 'second' }, { title: 'third' }] },
					transform(
						(inv) => ({
							kind: 'ok',
							output: Schema.decodeUnknownSync(
								Schema.Array(Schema.Struct({ title: Schema.String }))
							)(inv.input).map((row, index) =>
								index < 2
									? {
											...row,
											lines: {
												create: [
													{ label: `${row['title']}-a`, amount: '1' },
													{ label: `${row['title']}-b`, amount: '2' }
												]
											}
										}
									: row
							),
							cpuMs: 1
						}),
						'orders',
						calls
					)
				);
				const records = ok(result.outcome).records;
				const staged = new Map(
					required(required(calls[0], 'transform call').ctx.staged, 'staged identities').map(
						(row) => [row.path.join('.'), row.id]
					)
				);
				const orders = yield* rows(
					Schema.Struct({ id: Schema.String, title: Schema.String }),
					'select id::text as id, title from orders order by title'
				);
				const lines = yield* rows(
					Schema.Struct({ id: Schema.String, label: Schema.String, owner: Schema.String }),
					'select id::text as id, label, "order"::text as owner from lines order by label'
				);
				expect(orders.map((o) => o['title'])).toEqual(['first', 'second', 'third']);
				expect(lines).toHaveLength(4);
				const ids = [...orders, ...lines].map((row) => row['id']);
				expect(new Set(ids).size).toBe(7);
				// every submitted root keeps the identity the engine assigned it before the transform
				for (const [i, title] of ['first', 'second', 'third'].entries())
					expect(
						required(
							orders.find((o) => o['title'] === title),
							'order title'
						).id
					).toBe(staged.get(String(i)));
				const idOfTitle = (title: string) =>
					required(
						orders.find((o) => o['title'] === title),
						'order title'
					).id;
				for (const line of lines)
					expect(line['owner']).toBe(
						idOfTitle(required(line.label.split('-')[0], 'line label prefix'))
					);
				expect(new Set(records.map((r) => r.id)).size).toBe(records.length);
			}).pipe(Effect.provide(P2FixtureLive))
	);
});

describe('engine/write: erase (rule 38e, §5.13)', () => {
	it.effect(
		'remove deletes as a delete would, keeps one erased revision, and drops the rest of its history and its notices',
		() =>
			Effect.gen(function* () {
				const id = yield* order('desk', [
					{ label: 'a', amount: '1' },
					{ label: 'b', amount: '2' }
				]);
				ok((yield* run({ verb: 'update', input: { target: id, set: { note: 'n' } } })).outcome);
				yield* (yield* P2Fixture).db.write({
					text: `insert into sys_notification (id, recipient, title, link, at) values ('n1', '{}', 'Hi', $1, now())`,
					params: [JSON.stringify({ collection: 'orders', id })]
				});
				count.writes = 0;
				const { outcome, captured } = yield* run({ verb: 'erase', input: { target: id } });
				expect(ok(outcome).records).toEqual([{ collection: 'orders', id, revision: 3 }]);
				// hook:identity — the removed rows reach live views only; no event trigger fires and no run is queued (38e(d))
				expect(captured.map((x) => [x.collection, x.op])).toEqual([
					['orders', 'delete'],
					['lines', 'delete'],
					['lines', 'delete']
				]);
				expect(yield* one(Count, `select count(*)::int n from sys_run`)).toEqual({ n: 0 });
				expect(count.writes).toBe(1);
				expect(
					yield* one(
						Schema.Struct({ o: Schema.Number, l: Schema.Number, n: Schema.Number }),
						`select (select count(*)::int from orders) o, (select count(*)::int from lines) l, (select count(*)::int from sys_notification) n`
					)
				).toEqual({ o: 0, l: 0, n: 0 });
				expect(
					yield* rows(
						Schema.Struct({
							collection: Schema.String,
							op: Schema.String,
							cause: Schema.String,
							changes: Changes
						}),
						`select collection, op, cause, changes from bolt_history order by collection`
					)
				).toEqual([{ collection: 'orders', op: 'delete', cause: 'erased', changes: {} }]);
			}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect(
		'anonymise purges the fields and their computed readers from earlier revisions; the erased revision holds the set values',
		() =>
			Effect.gen(function* () {
				const id = yield* person('p1', 'Ada', 'ada@example.com');
				ok(
					(yield* run({
						collection: 'people',
						verb: 'update',
						input: { target: id, set: { name: 'Ada L' } }
					})).outcome
				);
				ok(
					(yield* run({
						collection: 'people',
						verb: 'erase',
						input: { target: id, set: { name: 'Erased' } }
					})).outcome
				);
				const history = yield* rows(
					Schema.Struct({ revision: Schema.Number, cause: Schema.String, changes: Changes }),
					`select revision, cause, changes from bolt_history where collection = 'people' order by revision`
				);
				// revision 2 changed only name (and shout), so it is left empty and goes
				expect(history.map((h) => [h['revision'], h['cause']])).toEqual([
					[1, 'direct'],
					[3, 'erased']
				]);
				expect(Object.keys(required(history[0], 'first people history').changes)).not.toContain(
					'name'
				);
				expect(Object.keys(required(history[0], 'first people history').changes)).not.toContain(
					'shout'
				);
				expect(required(history[0], 'first people history').changes).toMatchObject({
					code: 'p1',
					email: 'ada@example.com'
				});
				expect(required(history[1], 'erased people history').changes).toEqual({
					name: 'Erased',
					shout: 'ERASED'
				});
				expect(
					yield* one(
						Schema.Struct({ name: Schema.String, shout: Schema.String }),
						`select name, shout from people`
					)
				).toEqual({ name: 'Erased', shout: 'ERASED' });
			}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect(
		'on a frozen row remove is locked and anonymise of an erasable field commits past edit: none',
		() =>
			Effect.gen(function* () {
				const id = yield* person('p1', 'Ada', 'ada@example.com');
				ok(
					(yield* run({
						collection: 'people',
						verb: 'update',
						input: { target: id, set: { status: 'archived' } }
					})).outcome
				);
				expect(
					(yield* run({
						collection: 'people',
						verb: 'update',
						input: { target: id, set: { email: null } }
					})).outcome
				).toMatchObject({ code: 'locked' });
				expect(
					(yield* run({ collection: 'people', verb: 'erase', input: { target: id } })).outcome
				).toMatchObject({ code: 'locked' });
				ok(
					(yield* run({
						collection: 'people',
						verb: 'erase',
						input: { target: id, set: { email: null } }
					})).outcome
				);
				expect(
					yield* one(
						Schema.Struct({ email: Schema.NullOr(Schema.String), status: Schema.String }),
						`select email, status from people`
					)
				).toEqual({ email: null, status: 'archived' });
			}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect('is admin-only and a restricting child refuses a remove', () =>
		Effect.gen(function* () {
			const id = yield* order('desk');
			expect(
				(yield* run({
					verb: 'erase',
					input: { target: id },
					authority: authority({ orders: grants() })
				})).outcome
			).toMatchObject({ code: 'forbidden' });
			ok(
				(yield* run({ collection: 'receipts', verb: 'create', input: { memo: 'r', order: id } }))
					.outcome
			);
			expect((yield* run({ verb: 'erase', input: { target: id } })).outcome).toMatchObject({
				code: 'restricted'
			});
			expect((yield* run({ verb: 'delete', input: { target: id } })).outcome).toMatchObject({
				code: 'restricted'
			});
		}).pipe(Effect.provide(P2FixtureLive))
	);
});

describe('engine/query: history (rule 17)', () => {
	const history = Effect.fnUntraced(function* (
		id: string,
		reader: Authority,
		at?: { revision: number } | { before: string }
	) {
		const { db } = yield* P2Fixture;
		const selector =
			at === undefined
				? undefined
				: 'revision' in at
					? ({ _tag: 'Revision', revision: at.revision } satisfies NonNullable<
							Extract<ReadIR, { kind: 'history' }>['at']
						>)
					: ({ _tag: 'Before', before: at.before } satisfies NonNullable<
							Extract<ReadIR, { kind: 'history' }>['at']
						>);
		const answer = yield* readHistory(
			db,
			manifest,
			{
				kind: 'history',
				collection: 'orders',
				id,
				...(selector === undefined ? {} : { at: selector })
			},
			{ as: 'caller', authority: reader },
			bindings
		);
		return yield* Schema.decodeUnknownEffect(Schema.Array(HistoryRevision))(answer);
	});

	it.effect(
		"reads revisions in order, cut by `at`, masked by the reader's grant, and none without a history grant",
		() =>
			Effect.gen(function* () {
				const id = yield* order('desk');
				ok((yield* run({ verb: 'update', input: { target: id, set: { note: 'a' } } })).outcome);
				ok((yield* run({ verb: 'update', input: { target: id, set: { note: 'b' } } })).outcome);
				const all = yield* history(id, admin);
				expect(all.map((r) => [r.revision, r.changed['note']])).toEqual([
					[1, null],
					[2, 'a'],
					[3, 'b']
				]);
				expect(required(all[0], 'first history').actor).toEqual({
					kind: 'member',
					id: admin.actor.kind === 'member' ? admin.actor.id : ''
				});
				expect(yield* history(id, admin, { revision: 2 })).toHaveLength(2);
				const masked = authority({ orders: grants({ history: [arm()], masks: { note: FALSE } }) });
				expect((yield* history(id, masked)).map((r) => r.changed['note'])).toEqual([
					{ $masked: true },
					{ $masked: true },
					{ $masked: true }
				]);
				expect(yield* history(id, authority({ orders: grants() }))).toEqual([]);
				// a grant that depends on the caller resolves its `{ actor }` operand against the reader, not the workspace
				const own = authority({
					orders: grants({
						history: [arm({ t: 'cmp', field: 'note', op: 'eq', arg: { _tag: 'Actor', of: 'id' } })]
					})
				});
				expect(yield* history(id, own)).toEqual([]);
				ok((yield* run({ verb: 'delete', input: { target: id } })).outcome);
				expect(
					yield* history(id, authority({ orders: grants({ history: [arm()] }) }))
				).toHaveLength(4); // read: true sees a deleted row's
			}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect(
		'get(…, { revision }) folds the revisions into the full record as of that revision (L-BOLT-181)',
		() =>
			Effect.gen(function* () {
				const id = yield* order('desk');
				ok((yield* run({ verb: 'update', input: { target: id, set: { note: 'a' } } })).outcome);
				ok((yield* run({ verb: 'update', input: { target: id, set: { note: 'b' } } })).outcome);
				const { db } = yield* P2Fixture;
				const FoldedOrder = Schema.Struct({
					id: Schema.String,
					revision: Schema.Number,
					title: Schema.String,
					number: Schema.String,
					status: Schema.String,
					note: Schema.Union([
						Schema.NullOr(Schema.String),
						Schema.Struct({ $masked: Schema.Literal(true) })
					]),
					total: Schema.Struct({ $dec: Schema.String }),
					big_lines: Schema.Number
				});
				const at = Effect.fnUntraced(function* (revision: number, reader: Authority = admin) {
					const answer = yield* readHistory(
						db,
						manifest,
						{
							kind: 'history',
							collection: 'orders',
							id,
							at: { _tag: 'Revision', revision },
							full: true
						},
						{ as: 'caller', authority: reader },
						bindings
					);
					return yield* Schema.decodeUnknownEffect(Schema.NullOr(FoldedOrder))(answer);
				});
				expect(yield* at(2)).toMatchObject({ id, revision: 2, title: 'desk', note: 'a' });
				expect(yield* at(3)).toMatchObject({ revision: 3, title: 'desk', note: 'b' });
				expect(
					yield* at(2, authority({ orders: grants({ history: [arm()], masks: { note: FALSE } }) }))
				).toMatchObject({ note: { $masked: true } });
				expect(yield* at(2, authority({ orders: grants() }))).toBeNull();
				yield* pruneHistory((yield* P2Fixture).db, 1);
				expect(yield* at(3)).toMatchObject({ revision: 3, title: 'desk', note: 'b' }); // the anchor folds the cut
				expect(yield* at(2)).toBeNull(); // pruned: nothing to fold from
			}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect('a before selector with no captured request has no history boundary', () =>
		Effect.gen(function* () {
			const id = yield* order('desk');
			expect(yield* history(id, admin, { before: REQUEST })).toEqual([]);
		}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect('the prune keeps the newest committed revisions and every erased audit marker', () =>
		Effect.gen(function* () {
			const a = yield* order('a');
			for (const note of ['1', '2', '3'])
				ok((yield* run({ verb: 'update', input: { target: a, set: { note } } })).outcome);
			const second = yield* order('second');
			ok((yield* run({ verb: 'update', input: { target: second, set: { note: 'x' } } })).outcome);
			const p = yield* person('p1', 'Ada');
			ok(
				(yield* run({
					collection: 'people',
					verb: 'erase',
					input: { target: p, set: { name: 'E' } }
				})).outcome
			);
			ok(
				(yield* run({
					collection: 'people',
					verb: 'update',
					input: { target: p, set: { email: 'e@x' } }
				})).outcome
			);
			expect(yield* pruneHistory((yield* P2Fixture).db, 1)).toBe(5); // a: 1–3 go; second and people lose their creates
			const kept = yield* rows(
				Schema.Struct({
					collection: Schema.String,
					r: Schema.String,
					revision: Schema.Number,
					cause: Schema.String
				}),
				`select collection, record::text r, revision, cause from bolt_history order by collection, record, revision`
			);
			expect(kept.filter((h) => h['r'] === a).map((h) => h['revision'])).toEqual([4]);
			expect(kept.filter((h) => h['r'] === second).map((h) => h['revision'])).toEqual([2]);
			expect(kept.filter((h) => h['r'] === p).map((h) => h['cause'])).toEqual(['erased', 'direct']);
		}).pipe(Effect.provide(P2FixtureLive))
	);
});

describe('engine/write: per-record restore (rule 17)', () => {
	let n = 0;
	const at = (record: string, revision: number, collection = 'orders'): RestoreTarget => ({
		collection,
		record,
		revision
	});
	const preview = Effect.fnUntraced(function* (target: RestoreTarget, who: Authority = admin) {
		const { db } = yield* P2Fixture;
		const previewed = yield* restorePreview({ manifest, db }, target, who, bindings);
		if (!previewed.ok) throw new Error(JSON.stringify(previewed.outcome));
		return previewed.preview;
	});
	const restore = Effect.fnUntraced(function* (
		target: RestoreTarget,
		over: Partial<Pick<ActRequest, 'authority' | 'observed'>> = {},
		engine: Partial<WriteEngine> = {}
	) {
		const { db } = yield* P2Fixture;
		const i = n++;
		return (yield* restoreRecord(
			{ manifest, db },
			(request) => act({ manifest, db, ...engine }, request),
			target,
			{
				authority: admin,
				bindings,
				key: `restore-${i}`,
				issuedAt: NOW,
				invocationId: `restore-inv-${i}`,
				...over
			}
		)).outcome;
	});
	const history = Effect.fnUntraced(function* (id: string, collection = 'orders') {
		const { db } = yield* P2Fixture;
		return yield* Schema.decodeUnknownEffect(Schema.Array(HistoryRevision))(
			yield* readHistory(
				db,
				manifest,
				{ kind: 'history', collection, id },
				{ as: 'caller', authority: admin },
				bindings
			)
		);
	});
	const fields = (p: { changes: readonly { field: string }[] }) => p.changes.map((c) => c.field);
	const skips = (p: { skipped: readonly { field: string; reason: string }[] }) =>
		p.skipped.map((c) => [c.field, c.reason]);

	it.effect(
		'writes one new revision marked restored from N; later history stays and a restore is itself undone by one',
		() =>
			Effect.gen(function* () {
				const id = yield* order('desk');
				ok((yield* run({ verb: 'update', input: { target: id, set: { note: 'a' } } })).outcome);
				ok((yield* run({ verb: 'update', input: { target: id, set: { note: 'b' } } })).outcome);
				const p = yield* preview(at(id, 2));
				expect(p).toMatchObject({ revision: 2, live: 3, skipped: [] });
				expect(p.changes).toEqual([
					{ field: 'note', current: 'b', restored: 'a', approval: false }
				]);
				ok(yield* restore(at(id, 2), { observed: { [id]: p.live } }));
				ok(yield* restore(at(id, 3)));
				const all = yield* history(id);
				expect(all.map((r) => [r.revision, r.cause, r.restoredFrom, r.changed['note']])).toEqual([
					[1, 'direct', null, null],
					[2, 'direct', null, 'a'],
					[3, 'direct', null, 'b'],
					[4, 'restored', 2, 'a'],
					[5, 'restored', 3, 'b']
				]);
				expect(
					yield* one(Schema.Struct({ note: Schema.String }), 'select note from orders')
				).toEqual({ note: 'b' });
				expect(yield* restore(at(id, 4))).toMatchObject({ kind: 'committed' }); // a restore entry restores too
				expect(yield* restore(at(id, 6))).toMatchObject({ code: 'invalidInput' }); // not a past revision
			}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect(
		'takes back own writable fields only: roll-ups, seq, owned children and many-links stay as they are',
		() =>
			Effect.gen(function* () {
				const id = yield* order('desk', [{ label: 'x', amount: '100' }]);
				ok(
					(yield* run({
						verb: 'update',
						input: {
							target: id,
							set: { title: 'desk 2', lines: { create: [{ label: 'y', amount: '200' }] } }
						}
					})).outcome
				);
				const tag = idOf(
					(yield* run({ collection: 'tags', verb: 'create', input: { name: 't' } })).outcome,
					'tags'
				);
				ok(
					(yield* run({ verb: 'update', input: { target: id, set: { tags: { link: [tag] } } } }))
						.outcome
				);
				const p = yield* preview(at(id, 1));
				expect(fields(p)).toEqual(['title']);
				expect(p.skipped).toEqual([]);
				ok(yield* restore(at(id, 1)));
				expect(
					yield* one(
						Schema.Struct({
							title: Schema.String,
							total: Schema.String,
							big_lines: Schema.Number,
							lines: Schema.Number,
							tags: Schema.Number
						}),
						`select title, total::text total, big_lines::int big_lines, (select count(*)::int from lines) lines,
						(select count(*)::int from tags where "order" is not null) tags from orders`
					)
				).toEqual({ title: 'desk', total: '300', big_lines: 2, lines: 2, tags: 1 });
			}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect(
		'restores a link whose target still exists and skips one whose target was deleted, never writing the target',
		() =>
			Effect.gen(function* () {
				const a = yield* order('a'),
					b = yield* order('b'),
					c = yield* order('c');
				const r = idOf(
					(yield* run({ collection: 'receipts', verb: 'create', input: { memo: 'm1', order: a } }))
						.outcome,
					'receipts'
				);
				const update = (set: Json) =>
					run({ collection: 'receipts', verb: 'update', input: { target: r, set } });
				ok((yield* update({ memo: 'm2', order: b })).outcome);
				ok((yield* update({ order: c })).outcome);
				ok((yield* run({ verb: 'delete', input: { target: a } })).outcome);
				const back = yield* preview(at(r, 2, 'receipts'));
				expect(back.changes).toEqual([
					{ field: 'order', current: c, restored: b, approval: false }
				]);
				const first = yield* preview(at(r, 1, 'receipts'));
				expect(fields(first)).toEqual(['memo']);
				expect(skips(first)).toEqual([['order', 'deletedTarget']]);
				ok(yield* restore(at(r, 1, 'receipts')));
				expect(
					yield* one(
						Schema.Struct({ memo: Schema.String, o: Schema.String }),
						'select memo, "order"::text o from receipts'
					)
				).toEqual({ memo: 'm1', o: c });
				ok(yield* restore(at(r, 2, 'receipts')));
				expect(yield* one(Owner, 'select "order"::text o from receipts')).toEqual({ o: b });
				expect((yield* history(b)).map((h) => h.revision)).toEqual([1]); // the target is never written
			}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect('a stale observed revision is a conflict', () =>
		Effect.gen(function* () {
			const id = yield* order('desk');
			ok((yield* run({ verb: 'update', input: { target: id, set: { note: 'a' } } })).outcome);
			const p = yield* preview(at(id, 1));
			ok((yield* run({ verb: 'update', input: { target: id, set: { note: 'b' } } })).outcome);
			expect(yield* restore(at(id, 1), { observed: { [id]: p.live } })).toMatchObject({
				kind: 'conflict'
			});
		}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect('a field the caller may not write is skipped as noGrant', () =>
		Effect.gen(function* () {
			const id = yield* order('desk');
			ok(
				(yield* run({ verb: 'update', input: { target: id, set: { title: 'x', note: 'a' } } }))
					.outcome
			);
			const titleOnly = authority({
				orders: grants({ history: [arm()], update: [arm(undefined, ['title'])] })
			});
			const p = yield* preview(at(id, 1), titleOnly);
			expect(fields(p)).toEqual(['title']);
			expect(skips(p)).toEqual([['note', 'noGrant']]);
			ok(yield* restore(at(id, 1), { authority: titleOnly }));
			expect(
				yield* one(
					Schema.Struct({ title: Schema.String, note: Schema.NullOr(Schema.String) }),
					'select title, note from orders'
				)
			).toEqual({ title: 'desk', note: 'a' });
		}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect('an approval-routed restore commits provisionally under its request', () =>
		Effect.gen(function* () {
			const id = yield* order('desk');
			ok((yield* run({ verb: 'update', input: { target: id, set: { note: 'a' } } })).outcome);
			const reviewed = authority({
				orders: grants({
					history: [arm()],
					update: [],
					approval: { create: [], update: [{ steps: [['finance']] }], delete: [] }
				})
			});
			const p = yield* preview(at(id, 1), reviewed);
			expect(p.changes).toEqual([{ field: 'note', current: 'a', restored: null, approval: true }]);
			expect(yield* restore(at(id, 1), { authority: reviewed }, holding)).toMatchObject({
				kind: 'pendingApproval',
				requestId: REQUEST
			});
			// the restore is the provisional change: written now, recorded `restored` and held by the request
			expect(
				yield* one(Schema.Struct({ note: Schema.NullOr(Schema.String) }), 'select note from orders')
			).toEqual({ note: null });
			expect(
				yield* one(
					Schema.Struct({ cause: Schema.String, request: Schema.String }),
					'select cause, request::text request from bolt_history order by revision desc limit 1'
				)
			).toEqual({ cause: 'restored', request: REQUEST });
		}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect('a pruned record keeps every retained revision restorable', () =>
		Effect.gen(function* () {
			const id = yield* order('desk');
			for (const note of ['1', '2', '3'])
				ok((yield* run({ verb: 'update', input: { target: id, set: { note } } })).outcome);
			expect(yield* pruneHistory((yield* P2Fixture).db, 2)).toBe(2);
			const p = yield* preview(at(id, 3));
			expect(p.changes).toEqual([{ field: 'note', current: '3', restored: '2', approval: false }]);
			ok(yield* restore(at(id, 3)));
			expect(
				(yield* history(id)).map((h) => [h.revision, h.cause, h.changed['title'] ?? null])
			).toEqual([
				[3, 'direct', 'desk'], // the anchor holds the full row
				[4, 'direct', null],
				[5, 'restored', null]
			]);
			const { db } = yield* P2Fixture;
			expect(yield* restorePreview({ manifest, db }, at(id, 2), admin, bindings)).toMatchObject({
				ok: false,
				outcome: { code: 'notFound' }
			});
		}).pipe(Effect.provide(P2FixtureLive))
	);
});

describe('engine/write: import (rule 30)', () => {
	const imp = (input: Json, over: Partial<ActRequest> = {}) =>
		run({ collection: 'people', verb: 'import', input, ...over });
	const report = (o: Outcome) => {
		if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
		return Schema.decodeUnknownSync(ImportReport)(o.output).rows.map(
			(r) => `${r.index}:${r.action}`
		);
	};

	it.effect(
		'one act upserts every row and reports each; refuse and skip; onConflict is required on a keyed collection',
		() =>
			Effect.gen(function* () {
				count.writes = 0;
				expect(
					report((yield* imp({ rows: [{ code: 'p1', name: 'A' }], onConflict: 'update' })).outcome)
				).toEqual(['0:created']);
				expect(
					report(
						(yield* imp({
							rows: [
								{ code: 'p1', name: 'B' },
								{ code: 'p2', name: 'C' }
							],
							onConflict: 'update'
						})).outcome
					)
				).toEqual(['0:updated', '1:created']);
				expect(count.writes).toBe(2);
				expect(
					(yield* imp({
						rows: [
							{ code: 'p2', name: 'C' },
							{ code: 'p1', name: 'X' }
						],
						onConflict: 'refuse'
					})).outcome
				).toMatchObject({ code: 'unique', row: 0 });
				expect(
					report(
						(yield* imp({
							rows: [
								{ code: 'p1', name: 'Z' },
								{ code: 'p9', name: 'N' }
							],
							onConflict: 'update',
							onMissing: 'skip'
						})).outcome
					)
				).toEqual(['0:updated', '1:skipped']);
				expect(
					yield* rows(
						Schema.Struct({ code: Schema.String, name: Schema.String }),
						`select code, name from people order by code`
					)
				).toEqual([
					{ code: 'p1', name: 'Z' },
					{ code: 'p2', name: 'C' }
				]);
				expect((yield* imp({ rows: [{ code: 'p3', name: 'N' }] })).outcome).toMatchObject({
					code: 'invalidInput',
					field: 'onConflict'
				});
			}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect('prune deletes the absent keys inside its Where; dryRun writes nothing', () =>
		Effect.gen(function* () {
			ok(
				(yield* imp({
					rows: ['p1', 'p2', 'p3'].map((code) => ({ code, name: code })),
					onConflict: 'update'
				})).outcome
			);
			expect(
				report(
					(yield* imp({
						rows: [{ code: 'p1', name: 'p1' }],
						onConflict: 'keep',
						prune: { code: { in: ['p1', 'p2'] } }
					})).outcome
				)
			).toEqual(['0:kept', 'null:deleted']);
			expect(
				(yield* rows(
					Schema.Struct({ code: Schema.String }),
					`select code from people order by code`
				)).map((r) => r['code'])
			).toEqual(['p1', 'p3']);
			count.writes = 0;
			expect(
				report(
					(yield* imp({ rows: [{ code: 'p9', name: 'x' }], onConflict: 'update', dryRun: true }))
						.outcome
				)
			).toEqual(['0:created']);
			expect(count.writes).toBe(0);
			expect(
				yield* one(
					Schema.Struct({ p: Schema.Number, i: Schema.Number }),
					`select (select count(*)::int from people) p, (select count(*)::int from bolt_idem) i`
				)
			).toEqual({ p: 2, i: 2 });
		}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect("a ref accepts the target's key values", () =>
		Effect.gen(function* () {
			const id = yield* order('desk');
			ok(
				(yield* run({
					collection: 'receipts',
					verb: 'import',
					input: { rows: [{ memo: 'r', order: { title: 'desk' } }] }
				})).outcome
			);
			expect(yield* one(Owner, `select "order"::text o from receipts`)).toEqual({ o: id });
			expect(
				(yield* run({
					collection: 'receipts',
					verb: 'import',
					input: { rows: [{ memo: 'r', order: { title: 'nope' } }] }
				})).outcome
			).toMatchObject({ code: 'notFound', field: 'order', row: 0 });
		}).pipe(Effect.provide(P2FixtureLive))
	);
});

describe('engine/query: same-shape reads merge (rule 12)', () => {
	it.effect('gets of one collection and select are one statement, answered in order', () =>
		Effect.gen(function* () {
			const a = yield* order('a'),
				b = yield* order('b');
			const missing = '0199a000-0000-7000-8000-0000000000ff';
			const reads = readEngine({ db: (yield* P2Fixture).db, manifest });
			const get = (id: string, c = 'orders'): ReadIR => ({
				kind: 'get',
				collection: c,
				id,
				select: { fields: c === 'orders' ? ['title'] : null, relations: {} }
			});
			count.reads = 0;
			count.statements = 0;
			const out = yield* reads.run(
				[get(b), get(a), get(missing), get(a, 'tags')],
				{ as: 'workspace' },
				bindings
			);
			expect(out).toEqual([{ id: b, title: 'b' }, { id: a, title: 'a' }, null, null]);
			expect(count).toMatchObject({ reads: 1, statements: 1 }); // the merged gets and the lone one compose into one statement
		}).pipe(Effect.provide(P2FixtureLive))
	);
});

describe('engine/write: relation actions and cascades (rules 28, 41)', () => {
	it.effect(
		'a relation-action upsert states its conflict rule: keep leaves the existing row, update takes it over',
		() =>
			Effect.gen(function* () {
				const a = yield* order('a'),
					b = yield* order('b');
				ok(
					(yield* run({
						verb: 'update',
						input: { target: a, set: { tags: { upsert: [{ name: 't' }] } } }
					})).outcome
				);
				const tag = String((yield* one(Id, `select id::text from tags where name = 't'`))['id']);
				const tagOrder = () =>
					one(Owner, `select "order"::text o from tags where name = 't'`).pipe(
						Effect.map((row) => row.o)
					);
				ok(
					(yield* run({
						verb: 'update',
						input: {
							target: b,
							set: { tags: { upsert: [{ values: { id: tag }, onConflictDoUpdate: false }] } }
						}
					})).outcome
				);
				expect(yield* tagOrder()).toBe(a);
				ok(
					(yield* run({
						verb: 'update',
						input: {
							target: b,
							set: { tags: { upsert: [{ values: { id: tag }, onConflictDoUpdate: true }] } }
						}
					})).outcome
				);
				expect(yield* tagOrder()).toBe(b);
				expect(
					(yield* run({
						verb: 'update',
						input: {
							target: b,
							set: { tags: { upsert: [{ values: { id: tag }, onConflictDoUpdate: 'x' }] } }
						}
					})).outcome
				).toMatchObject({ code: 'invalidInput' });
			}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect('judges a nested id upsert as an update of the stored child', () =>
		Effect.gen(function* () {
			const a = yield* order('a'),
				b = yield* order('b');
			ok(
				(yield* run({
					verb: 'update',
					input: { target: a, set: { tags: { upsert: [{ name: 't' }] } } }
				})).outcome
			);
			const tag = String((yield* one(Id, `select id::text from tags where name = 't'`))['id']);
			const caller = authority({
				orders: grants(),
				tags: grants({ create: [arm(undefined, [])], update: [arm()] })
			});
			ok(
				(yield* run({
					verb: 'update',
					input: { target: b, set: { tags: { upsert: [{ id: tag, name: 't' }] } } },
					authority: caller
				})).outcome
			);
			expect(
				(yield* one(Id, `select "order"::text as id from tags where id = '${tag}'`))['id']
			).toBe(b);
		}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect(
		'a nested change to an owned child of a frozen parent is locked; an administrator still deletes the frozen parent with its children',
		() =>
			Effect.gen(function* () {
				const id = yield* order('desk', [{ label: 'a', amount: '1' }]);
				const [line] = yield* rows(Id, `select id::text from lines`);
				ok(
					(yield* run({ verb: 'update', input: { target: id, set: { status: 'submitted' } } }))
						.outcome
				);
				expect(
					(yield* run({
						verb: 'update',
						input: {
							target: id,
							set: {
								lines: { update: [{ target: required(line, 'line').id, set: { amount: '2' } }] }
							}
						}
					})).outcome
				).toMatchObject({ code: 'locked' });
				expect(
					(yield* run({
						verb: 'update',
						input: { target: id, set: { lines: { create: [{ label: 'b', amount: '1' }] } } }
					})).outcome
				).toMatchObject({ code: 'locked' });
				ok((yield* run({ verb: 'delete', input: { target: id } })).outcome);
				expect(yield* one(Count, `select count(*)::int n from lines`)).toEqual({ n: 0 });
			}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect("a nested delete of a child outside the caller's read scope is notFound", () =>
		Effect.gen(function* () {
			const id = yield* order('desk', [{ label: 'hidden', amount: '1' }]);
			const [line] = yield* rows(Id, `select id::text from lines`);
			const caller = authority({
				orders: grants(),
				lines: grants({
					read: [arm({ t: 'cmp', field: 'label', op: 'ne', arg: { _tag: 'Lit', value: 'hidden' } })]
				})
			});
			expect(
				(yield* run({
					verb: 'update',
					input: { target: id, set: { lines: { delete: [required(line, 'line').id] } } },
					authority: caller
				})).outcome
			).toMatchObject({ code: 'notFound' });
			expect(yield* one(Count, `select count(*)::int n from lines`)).toEqual({ n: 1 });
		}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect(
		'delete: { transform: true } runs the transform as a guard for everyone, administrators included (rules 27, 35)',
		() =>
			Effect.gen(function* () {
				const calls: Invocation[] = [];
				const guard = transform(
					() => ({ kind: 'refused', message: 'the tag is in use', cpuMs: 1 }),
					'tags',
					calls
				);
				const tag = idOf(
					(yield* run({ collection: 'tags', verb: 'create', input: { name: 't' } })).outcome,
					'tags'
				);
				const member = authority({ tags: grants() });
				expect(
					(yield* run(
						{ collection: 'tags', verb: 'delete', input: { target: tag }, authority: member },
						guard
					)).outcome
				).toEqual({
					kind: 'refused',
					code: 'refused',
					message: 'the tag is in use',
					rule: 'tags.transform'
				});
				expect(calls.map((c) => c.input)).toEqual([[{ $delete: true }]]);
				// an administrator's delete faces the same guard: a business rule (a settled row) is not an authority question
				expect(
					(yield* run({ collection: 'tags', verb: 'delete', input: { target: tag } }, guard))
						.outcome
				).toMatchObject({ kind: 'refused', message: 'the tag is in use' });
				expect(calls).toHaveLength(2);
			}).pipe(Effect.provide(P2FixtureLive))
	);
});

describe('engine/write: telemetry (§5.12)', () => {
	it.effect(
		'an act writes its events as a piece of its one statement; a refusal before guest code writes none',
		() =>
			Effect.gen(function* () {
				const { db } = yield* P2Fixture,
					lines: string[] = [];
				const context = yield* Layer.build(
					TelemetryLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								Layer.succeed(TenantDb, db),
								Layer.succeed(EventSink, (row) =>
									Effect.sync(() => {
										lines.push(JSON.stringify(row));
									})
								)
							)
						)
					)
				);
				const log = () => Context.get(context, Telemetry).open({ invocation: 'i' });
				count.writes = 0;
				ok((yield* run({ verb: 'create', input: { title: 'a' } }, { log: yield* log() })).outcome);
				expect(count.writes).toBe(1);
				expect(
					(yield* run({ verb: 'create', input: { title: 1 } }, { log: yield* log() })).outcome
				).toMatchObject({ code: 'invalidInput' });
				expect(count.writes).toBe(1);
				const refusing = transform(() => ({ kind: 'refused', message: 'no', cpuMs: 1 }));
				expect(
					(yield* run(
						{ verb: 'create', input: { title: 'b' } },
						{ ...refusing, log: yield* log() }
					)).outcome
				).toMatchObject({ code: 'refused' });
				expect(count.writes).toBe(2);
				expect(
					yield* rows(
						Schema.Struct({
							severity: Schema.Literals(['info', 'warn', 'error']),
							event: Schema.String,
							c: Schema.NullOr(Schema.String)
						}),
						`select severity, event, attributes->>'callable' c from sys_event order by id`
					)
				).toEqual([
					{ severity: 'info', event: 'act.settled', c: 'orders.create' },
					{ severity: 'warn', event: 'act.refused', c: 'orders.create' }
				]);
				expect(
					lines.map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Event))(line).event)
				).toEqual(['act.settled', 'act.refused', 'act.refused']);
			}).pipe(Effect.provide(P2FixtureLive), Effect.scoped)
	);
});

describe('engine/write: pipeline order (rule 19)', () => {
	type Row = {
		name: string;
		expect: string;
		guest: boolean;
		writes: number;
		act: () => Effect.Effect<Outcome, EngineError, P2Fixture>;
	};
	const refusing = (calls: Invocation[]) =>
		transform(() => ({ kind: 'refused', message: 'guest', cpuMs: 1 }), 'orders', calls);
	const targetOrder = Effect.fnUntraced(function* () {
		const id = yield* order((yield* P2Fixture).nextTitle());
		count.writes = 0;
		return id;
	});
	const table: ((calls: Invocation[]) => Row)[] = [
		(calls) => ({
			name: 'rate admission before decode',
			expect: 'rateLimited',
			guest: false,
			writes: 0,
			act: () =>
				run(
					{ verb: 'create', input: { title: 1 } },
					{ ...refusing(calls), admit: () => ({ retryAfter: 1 }) }
				).pipe(Effect.map((answer) => answer.outcome))
		}),
		(calls) => ({
			name: 'expiry before decode',
			expect: 'expired',
			guest: false,
			writes: 0,
			act: () =>
				run(
					{ verb: 'create', input: { title: 1 }, issuedAt: '2026-09-20T00:00:00.000Z' },
					refusing(calls)
				).pipe(Effect.map((answer) => answer.outcome))
		}),
		(calls) => ({
			name: 'decode before the caller',
			expect: 'invalidInput',
			guest: false,
			writes: 0,
			act: () =>
				run(
					{ verb: 'create', input: { title: 1 }, authority: authority({}) },
					refusing(calls)
				).pipe(Effect.map((answer) => answer.outcome))
		}),
		(calls) => ({
			name: 'the caller before transformations',
			expect: 'forbidden',
			guest: false,
			writes: 0,
			act: () =>
				Effect.gen(function* () {
					return (yield* run(
						{
							verb: 'update',
							input: { target: yield* targetOrder(), set: { note: 'x' } },
							authority: authority({ orders: grants({ update: [] }) })
						},
						{ ...refusing(calls), ...holding }
					)).outcome;
				})
		}),
		(calls) => ({
			name: 'the observed revision before guest code',
			expect: 'conflict',
			guest: false,
			writes: 0,
			act: () =>
				Effect.gen(function* () {
					const id = yield* order('o');
					count.writes = 0;
					return (yield* run(
						{ verb: 'update', input: { target: id, set: { note: 'x' } }, observed: { [id]: 7 } },
						refusing(calls)
					)).outcome;
				})
		}),
		(calls) => ({
			name: 'guest code before the post-image scope',
			expect: 'refused',
			guest: true,
			writes: 1,
			act: () =>
				run(
					{
						verb: 'create',
						input: { title: 'x' },
						authority: authority({ orders: grants({ create: [arm(FALSE)] }) })
					},
					refusing(calls)
				).pipe(Effect.map((answer) => answer.outcome))
		}),
		() => ({
			name: 'the post-image scope before the approval route',
			expect: 'forbidden',
			guest: false,
			writes: 0,
			act: () =>
				run(
					{
						verb: 'create',
						input: { title: 'x' },
						authority: authority({
							orders: grants({
								create: [arm(FALSE)],
								approval: {
									create: [{ where: { title: { eq: 'other' } }, steps: [['f']] }],
									update: [],
									delete: []
								}
							})
						})
					},
					{
						approval: {
							route: () =>
								Effect.sync(() => {
									throw new Error('routed');
								})
						}
					}
				).pipe(Effect.map((answer) => answer.outcome))
		}),
		() => ({
			name: 'the approval route before the commit',
			expect: 'pendingApproval',
			guest: false,
			writes: 1,
			act: () =>
				run({ verb: 'create', input: { title: 'x' }, authority: routed('create') }, holding).pipe(
					Effect.map((answer) => answer.outcome)
				)
		})
	];
	for (const make of table) {
		const calls: Invocation[] = [],
			row = make(calls);
		it.effect(row.name, () =>
			Effect.gen(function* () {
				count.writes = 0;
				const o = yield* row.act();
				expect(o.kind === 'refused' ? o.code : o.kind).toBe(row.expect);
				expect(calls.length > 0).toBe(row.guest);
				expect(count.writes).toBe(row.writes);
			}).pipe(Effect.provide(P2FixtureLive))
		);
	}
});

describe('engine/write: guest failures (rules 42, 72a)', () => {
	it.effect(
		'a throw is internal, a budget keeps its code, a platform fault throws with its cause',
		() =>
			Effect.gen(function* () {
				const failing = (code: Code) =>
					transform(() => ({
						kind: 'failed',
						error: BoltError.make(code, 'guest', `${code}!`),
						cpuMs: 1
					}));
				expect(
					(yield* run({ verb: 'create', input: { title: 'a' } }, failing('guestError'))).outcome
				).toEqual({ kind: 'refused', code: 'internal', message: 'guestError!' });
				expect(
					(yield* run({ verb: 'create', input: { title: 'a' } }, failing('cpuBudget'))).outcome
				).toEqual({ kind: 'refused', code: 'cpuBudget', message: 'cpuBudget!' });
				expect(
					yield* Effect.flip(run({ verb: 'create', input: { title: 'a' } }, failing('missingBody')))
				).toMatchObject({ code: 'missingBody' });
			}).pipe(Effect.provide(P2FixtureLive))
	);
});

describe('engine/write: roll-ups against a re-select oracle (rule 21)', () => {
	it.effect(
		'every roll-up equals a fresh aggregate after any sequence of child and parent writes',
		() =>
			Effect.gen(function* () {
				let seed = 7;
				const rand = (k: number) => {
					seed = (seed * 1103515245 + 12345) & 0x7fffffff;
					return seed % k;
				};
				const AMOUNTS = ['0', '50', '99.99', '100', '150.5', '250'];
				const amount = () => required(AMOUNTS[rand(AMOUNTS.length)], 'random amount');
				const pick = Effect.fnUntraced(function* (sql: string) {
					const r = yield* rows(Id, sql);
					return r.length === 0 ? null : required(r[rand(r.length)], 'random row').id;
				});
				for (let step = 0; step < 40; step++) {
					const kind = rand(6);
					const o = yield* pick(`select id::text from orders order by id`);
					const l = yield* pick(`select id::text from lines order by id`);
					const lineOrder =
						l === null
							? null
							: (yield* one(Owner, `select "order"::text o from lines where id = '${l}'`)).o;
					if (kind === 0 || o === null)
						yield* order(
							`o${step}`,
							Array.from({ length: rand(3) }, (_, i) => ({ label: `l${i}`, amount: amount() }))
						);
					else if (kind === 1)
						ok(
							(yield* run({
								verb: 'update',
								input: { target: o, set: { lines: { create: [{ label: 'x', amount: amount() }] } } }
							})).outcome
						);
					else if (kind === 2 && l !== null)
						ok(
							(yield* run({
								collection: 'lines',
								verb: 'update',
								input: { target: l, set: { amount: amount() } }
							})).outcome
						);
					else if (kind === 3 && l !== null) {
						if (lineOrder === null) throw new Error('The selected child has no parent');
						ok(
							(yield* run({
								verb: 'update',
								input: { target: lineOrder, set: { note: `s${step}`, lines: { delete: [l] } } }
							})).outcome
						);
					} else if (kind === 4)
						ok(
							(yield* run({
								collection: 'lines',
								verb: 'create',
								input: { label: 'd', amount: amount(), order: o }
							})).outcome
						);
					else if (kind === 5 && rand(3) === 0)
						ok((yield* run({ verb: 'delete', input: { target: o } })).outcome);
					const drift = yield* rows(
						Id,
						`select o.id from orders o where o.total <> coalesce((select sum(amount) from lines l where l."order" = o.id), 0)
				or o.big_lines <> (select count(*) from lines l where l."order" = o.id and l.amount >= 100)`
					);
					expect(drift, `step ${step} (kind ${kind})`).toEqual([]);
				}
			}).pipe(Effect.provide(P2FixtureLive))
	);
});
