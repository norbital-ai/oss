// engine/write and engine/query on PGlite, the P2 review gaps: erase (38e), history (17), import and export
// (30), relation-action upsert (28), cascades and frozen parents (41), the delete guard (27),
// telemetry (§5.12), pipeline order (19), guest failures (42, 72a) and `expired` (31).
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Authority, GuestOutcome, Invocation, Outcome, Sql } from '../src/engine/contracts.ts';
import { type EngineError } from '../src/engine/errors.ts';
import { BoltError, type Code } from '../src/protocol/errors.ts';
import { TelemetryLive } from '../src/engine/guest/telemetry.ts';
import type { LogEvent } from '../src/engine/contracts.ts';
import { Logs } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Telemetry } from '../src/engine/services.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import type { ReadIR } from '../src/protocol/reads.ts';
import { readHistory } from '../src/engine/query/history.ts';
import {
	act,
	type ActRequest,
	type StepsSnapshot,
	type WriteEngine
} from '../src/engine/write/act.ts';
import { restorePreview, restoreRecord, type RestoreTarget } from '../src/engine/write/restore.ts';
import { admin, arm, authority, deleteArm, grants, NOW, TODAY, writeArm } from './write-fixture.ts';
import { manifest } from './write-p2.fixture.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';

const count = { reads: 0, writes: 0 };
/** Every read statement, oldest first. */
const statements: Sql[] = [];
const bindings = { now: NOW, today: TODAY, tz: 'UTC' };
type Over = Partial<ActRequest> & Pick<ActRequest, 'verb' | 'input'>;
const required = <A>(value: A | undefined, at: string): A => {
	if (value === undefined) throw new Error(`Missing fixture ${at}`);
	return value;
};
const fixture = Effect.gen(function* () {
	const inner = yield* TenantDb;
	const db = TenantDb.typed({
		read: (read) =>
			Effect.suspend(() => {
				count.reads++;
				statements.push(...read);
				return inner.read(read);
			}),
		write: (statement, lock) =>
			Effect.suspend(() => {
				count.writes++;
				return inner.write(statement, lock);
			}),
		transaction: (batch) =>
			Effect.suspend(() => {
				// Native commits use complete batches; dry runs execute the same SQL and roll back.
				if (batch.rollback !== true) count.writes++;
				return inner.transaction(batch);
			}),
		session: inner.session
	});
	count.reads = 0;
	count.writes = 0;
	let n = 0;
	const run = (over: Over, engine: Partial<WriteEngine> = {}) =>
		act(
			{ manifest, db, ...engine },
			{
				model: 'orders',
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
const P2FixtureLive = Layer.effect(P2Fixture, fixture).pipe(Layer.provide(TestDb.layer(manifest)));
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
		ok(o).records.find((r) => r.model === c),
		`created ${c}`
	).id;
const order = Effect.fnUntraced(function* (
	title = 'desk',
	lines: { label: string; amount: string }[] = []
) {
	return idOf((yield* run({ verb: 'create', input: [{ title, lines }] })).outcome);
});
const person = Effect.fnUntraced(function* (
	code: string,
	name: string,
	email: string | null = null
) {
	return idOf(
		(yield* run({ model: 'people', verb: 'create', input: [{ code, name, email }] })).outcome,
		'people'
	);
});
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
const REQUEST = '0199a000-0000-7000-8000-0000000000aa';
const columns = (op: 'create' | 'update') => manifest.exposures['orders']?.[op]?.columns ?? {};
/** A write its policy `check` approves. The fake hook still cannot mutate domain data. */
const routed = (op: 'create' | 'update') =>
	authority({ orders: grants('orders', { [op]: [writeArm(columns(op), true)] }) });
const snapshot: StepsSnapshot = {
	kind: 'steps',
	steps: [{ name: 'Finance', teams: ['finance'], users: [] }],
	superseded_by: []
};
const holding: Partial<WriteEngine> = {
	guest: {
		invokeProgram: () => Effect.die('The approval fixture does not execute programs'),
		invoke: () => Effect.succeed({ kind: 'ok', output: { kind: 'approve', flow: snapshot } })
	},
	approval: {
		route: () =>
			Effect.succeed({
				requestId: REQUEST,
				route: snapshot,
				pieces: () => {}
			}),
		resubmit: () => Effect.die('The approval fixture does not resubmit requests')
	}
};
function callback(
	body: (inv: Invocation) => GuestOutcome,
	model = 'orders',
	calls: Invocation[] = []
): Partial<WriteEngine> {
	const exposed = manifest.exposures[model];
	if (exposed === undefined) throw new Error(`The callback fixture has no ${model} contract`);
	return {
		manifest: {
			...manifest,
			exposures: {
				...manifest.exposures,
				[model]: {
					...exposed,
					...(exposed.create === undefined
						? {}
						: { create: { ...exposed.create, transform: true } }),
					...(exposed.update === undefined
						? {}
						: { update: { ...exposed.update, transform: true } }),
					...(exposed.delete === undefined ? {} : { delete: { check: true } })
				}
			}
		},
		guest: {
			invokeProgram: () =>
				Effect.die(new Error('This fixture does not execute supplied guest programs.')),
			invoke: (inv) => Effect.sync(() => (calls.push(inv), body(inv)))
		}
	};
}

describe('engine-owned callback identities', () => {
	it.effect(
		'gives children a multi-row callback adds distinct ids and replays without duplicating them',
		() =>
			Effect.gen(function* () {
				const calls: Invocation[] = [];
				const engine = callback(
					(inv) => ({
						kind: 'ok',
						output: Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ title: Schema.String })))(
							inv.input
						).map((row, index) =>
							index < 2
								? {
										...row,
										lines: [
											{ label: `${row['title']}-a`, amount: '1' },
											{ label: `${row['title']}-b`, amount: '2' }
										]
									}
								: row
						)
					}),
					'orders',
					calls
				);
				const request: Over = {
					verb: 'create',
					input: [{ title: 'first' }, { title: 'second' }, { title: 'third' }],
					key: 'callback-identities'
				};
				const result = yield* run(request, engine);
				expect((yield* run({ ...request, retry: true }, engine)).outcome).toEqual(result.outcome);
				expect(calls).toHaveLength(1);
				const records = ok(result.outcome).records;
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
				expect(
					records
						.filter((row) => row.model === 'orders')
						.map((row) => row.id)
						.sort()
				).toEqual(orders.map((row) => row.id).sort());
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
				ok((yield* run({ verb: 'update', input: [{ target: id, set: { note: 'n' } }] })).outcome);
				yield* (yield* P2Fixture).db.write({
					text: `insert into sys_notification (id, recipient, title, link, at) values ('n1', '{}', 'Hi', $1, now())`,
					params: [JSON.stringify({ model: 'orders', id })]
				});
				count.writes = 0;
				const { outcome, captured } = yield* run({ verb: 'erase', input: { target: id } });
				expect(ok(outcome).records).toEqual([{ model: 'orders', id, revision: 3 }]);
				// hook:identity — the removed rows reach live views only; no event trigger fires and no run is queued (38e(d))
				// owned children are deleted before the root they point at; order among them is not the contract
				expect(captured.map((x) => [x.model, x.op]).sort()).toEqual([
					['lines', 'delete'],
					['lines', 'delete'],
					['orders', 'delete']
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
							model: Schema.String,
							op: Schema.String,
							cause: Schema.String,
							changes: Changes
						}),
						`select collection model, op, cause, changes from bolt_history order by collection`
					)
				).toEqual([{ model: 'orders', op: 'delete', cause: 'erased', changes: {} }]);
			}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect(
		'anonymise purges earlier field values and computed readers; the erased revision anchors the safe live row',
		() =>
			Effect.gen(function* () {
				const id = yield* person('p1', 'Ada', 'ada@example.com');
				ok(
					(yield* run({
						model: 'people',
						verb: 'update',
						input: [{ target: id, set: { name: 'Ada L' } }]
					})).outcome
				);
				ok(
					(yield* run({
						model: 'people',
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
				expect(required(history[1], 'erased people history').changes).toEqual(
					(yield* one(
						Schema.Struct({ row: Changes }),
						`select to_jsonb(people) - array['bolt_search','bolt_embedding'] as row from people`
					)).row
				);
				expect(
					yield* one(
						Schema.Struct({ name: Schema.String, shout: Schema.String }),
						`select name, shout from people`
					)
				).toEqual({ name: 'Erased', shout: 'ERASED' });
			}).pipe(Effect.provide(P2FixtureLive))
	);
});

describe('engine/query: history (rule 17)', () => {
	// a narrower `brief` output of orders, without `note`
	const orders = required(manifest.exposures['orders'], 'orders exposure');
	const viewed: EngineManifest = {
		...manifest,
		exposures: {
			...manifest.exposures,
			orders: { ...orders, outputs: { brief: { orders: { fields: ['title', 'status'] } } } }
		}
	};
	const history = Effect.fnUntraced(function* (
		id: string,
		reader: Authority,
		at?: { revision: number } | { before: string },
		output?: string
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
			viewed,
			{
				kind: 'history',
				model: 'orders',
				id,
				...(selector === undefined ? {} : { at: selector }),
				...(output === undefined ? {} : { output })
			},
			{ as: 'caller', authority: reader },
			bindings
		);
		return yield* Schema.decodeUnknownEffect(Schema.Array(HistoryRevision))(answer);
	});

	const FoldedOrder = Schema.Struct({
		id: Schema.String,
		revision: Schema.Number,
		title: Schema.String,
		number: Schema.String,
		status: Schema.String,
		note: Schema.NullOr(Schema.String),
		total: Schema.Struct({ $dec: Schema.String }),
		big_lines: Schema.Number
	});
	/** get(…, { revision }): the revisions folded into the full record as of that revision (L-BOLT-181). */
	const folded = Effect.fnUntraced(function* (
		id: string,
		revision: number,
		reader: Authority = admin
	) {
		const { db } = yield* P2Fixture;
		const answer = yield* readHistory(
			db,
			viewed,
			{ kind: 'history', model: 'orders', id, at: { _tag: 'Revision', revision }, full: true },
			{ as: 'caller', authority: reader },
			bindings
		);
		return yield* Schema.decodeUnknownEffect(Schema.NullOr(FoldedOrder))(answer);
	});
	const foldedBrief = Effect.fnUntraced(function* (
		id: string,
		revision: number,
		reader: Authority
	) {
		const { db } = yield* P2Fixture;
		const answer = yield* readHistory(
			db,
			viewed,
			{
				kind: 'history',
				model: 'orders',
				id,
				at: { _tag: 'Revision', revision },
				full: true,
				output: 'brief'
			},
			{ as: 'caller', authority: reader },
			bindings
		);
		return answer;
	});

	it.effect(
		'reads revisions in order, cut by `at`, showing the output the read names, and none without a history grant or that output; folded as of a revision',
		() =>
			Effect.gen(function* () {
				const id = yield* order('desk');
				ok((yield* run({ verb: 'update', input: [{ target: id, set: { note: 'a' } }] })).outcome);
				ok((yield* run({ verb: 'update', input: [{ target: id, set: { note: 'b' } }] })).outcome);
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
				// a reader holding only the `brief` output: its revisions show brief's fields, never `note`
				const brief = authority({
					orders: grants('orders', { history: [arm()], read: { brief: { orders: [arm()] } } })
				});
				expect(yield* folded(id, 2)).toMatchObject({ id, revision: 2, title: 'desk', note: 'a' });
				const asBrief = yield* foldedBrief(id, 2, brief);
				expect(asBrief).toMatchObject({ id, revision: 2, title: 'desk' });
				expect(asBrief).not.toHaveProperty('note');
				expect(yield* folded(id, 2, authority({ orders: grants('orders') }))).toBeNull();
				const briefRevisions = yield* history(id, brief, undefined, 'brief');
				expect(briefRevisions).toHaveLength(3);
				expect(briefRevisions.every((r) => !('note' in r.changed))).toBe(true);
				// the default output is not granted to it: no revisions
				expect(yield* history(id, brief)).toEqual([]);
				expect(yield* history(id, authority({ orders: grants('orders') }))).toEqual([]);
				// a grant that depends on the caller resolves its `{ actor }` operand against the reader, not the workspace
				const own = authority({
					orders: grants('orders', {
						history: [
							arm({ t: 'cmp', field: 'note', op: 'eq', arg: { _tag: 'Var', text: 'requestor.id' } })
						]
					})
				});
				expect(yield* history(id, own)).toEqual([]);
				ok((yield* run({ verb: 'delete', input: [{ target: id }] })).outcome);
				expect(
					yield* history(id, authority({ orders: grants('orders', { history: [arm()] }) }))
				).toHaveLength(4); // read: true sees a deleted row's
			}).pipe(Effect.provide(P2FixtureLive))
	);
});

describe('engine/write: per-record restore (rule 17)', () => {
	let n = 0;
	const at = (record: string, revision: number, model = 'orders'): RestoreTarget => ({
		model,
		record,
		revision
	});
	const preview = Effect.fnUntraced(function* (
		target: RestoreTarget,
		who: Authority = admin,
		engine: Partial<WriteEngine> = {}
	) {
		const { db } = yield* P2Fixture;
		const previewed = yield* restorePreview({ manifest, db, ...engine }, target, who, bindings);
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
			{ manifest, db, ...engine },
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
	const history = Effect.fnUntraced(function* (id: string, model = 'orders') {
		const { db } = yield* P2Fixture;
		return yield* Schema.decodeUnknownEffect(Schema.Array(HistoryRevision))(
			yield* readHistory(
				db,
				manifest,
				{ kind: 'history', model, id },
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
				ok((yield* run({ verb: 'update', input: [{ target: id, set: { note: 'a' } }] })).outcome);
				ok((yield* run({ verb: 'update', input: [{ target: id, set: { note: 'b' } }] })).outcome);
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
						input: [
							{
								target: id,
								set: { title: 'desk 2', lines: { create: [{ label: 'y', amount: '200' }] } }
							}
						]
					})).outcome
				);
				const tag = idOf(
					(yield* run({ model: 'tags', verb: 'create', input: [{ name: 't' }] })).outcome,
					'tags'
				);
				ok(
					(yield* run({ verb: 'update', input: [{ target: id, set: { tags: { link: [tag] } } }] }))
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

	it.effect('a field the caller may not write is skipped as noGrant', () =>
		Effect.gen(function* () {
			const id = yield* order('desk');
			ok(
				(yield* run({ verb: 'update', input: [{ target: id, set: { title: 'x', note: 'a' } }] }))
					.outcome
			);
			const titleOnly = authority({
				orders: grants('orders', { history: [arm()], update: [writeArm({ orders: ['title'] })] })
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
});

describe('engine/write: import (rule 30)', () => {
	const imp = (input: Json, over: Partial<ActRequest> = {}) =>
		run({ model: 'people', verb: 'import', input, ...over });
	const report = (o: Outcome) => {
		if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
		return Schema.decodeUnknownSync(ImportReport)(o.output).rows.map(
			(r) => `${r.index}:${r.action}`
		);
	};

	it.effect(
		'one act upserts every row and reports each; refuse and skip; onConflict is required on a keyed model',
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

	it.effect(
		'a keyed import finds its stored rows by a hash join on its required key, never a nested loop',
		() =>
			Effect.gen(function* () {
				const rows = (name: string) =>
					Array.from({ length: 400 }, (_, i) => ({ code: `c${i}`, name }));
				ok((yield* imp({ rows: rows('A'), onConflict: 'update' })).outcome);
				statements.length = 0;
				expect(
					report((yield* imp({ rows: rows('B'), onConflict: 'update' })).outcome).filter((r) =>
						r.endsWith(':updated')
					)
				).toHaveLength(400);
				const lookup = required(
					statements.find((s) => s.text.includes('jsonb_populate_recordset')),
					'the key lookup'
				);
				expect(lookup.text).not.toContain('IS NOT DISTINCT FROM');
				const plan = yield* (yield* P2Fixture).db.rows(
					Schema.Struct({ 'QUERY PLAN': Schema.String }),
					{
						text: `EXPLAIN ${lookup.text}`,
						params: lookup.params
					}
				);
				expect(plan.map((r) => r['QUERY PLAN']).join('\n')).not.toContain('Nested Loop');
			}).pipe(Effect.provide(P2FixtureLive))
	);

	it.effect("a ref accepts the target's key values", () =>
		Effect.gen(function* () {
			const id = yield* order('desk');
			ok(
				(yield* run({
					model: 'receipts',
					verb: 'import',
					input: { rows: [{ memo: 'r', order: { title: 'desk' } }] }
				})).outcome
			);
			expect(yield* one(Owner, `select "order"::text o from receipts`)).toEqual({ o: id });
			expect(
				(yield* run({
					model: 'receipts',
					verb: 'import',
					input: { rows: [{ memo: 'r', order: { title: 'nope' } }] }
				})).outcome
			).toMatchObject({ code: 'notFound', field: 'order', row: 0 });
		}).pipe(Effect.provide(P2FixtureLive))
	);
});

describe('engine/write: relation actions and cascades (rules 28, 41)', () => {
	it.effect(
		'delete.check receives stored rows and guards everyone, administrators included (rules 27, 35)',
		() =>
			Effect.gen(function* () {
				const calls: Invocation[] = [];
				const guard = callback(
					() => ({ kind: 'refused', message: 'the tag is in use' }),
					'tags',
					calls
				);
				const tag = idOf(
					(yield* run({ model: 'tags', verb: 'create', input: [{ name: 't' }] })).outcome,
					'tags'
				);
				const member = authority({ tags: grants('tags', { delete: [deleteArm()] }) });
				expect(
					(yield* run(
						{ model: 'tags', verb: 'delete', input: [{ target: tag }], authority: member },
						guard
					)).outcome
				).toEqual({
					kind: 'refused',
					code: 'refused',
					message: 'the tag is in use',
					rule: 'tags.delete'
				});
				expect(calls.map((call) => call.kind)).toEqual(['delete']);
				expect(calls.map((call) => call.input)).toMatchObject([[{ id: tag, name: 't' }]]);
				// an administrator's delete faces the same guard: a business rule (a settled row) is not an authority question
				expect(
					(yield* run({ model: 'tags', verb: 'delete', input: [{ target: tag }] }, guard)).outcome
				).toMatchObject({ kind: 'refused', message: 'the tag is in use' });
				expect(calls).toHaveLength(2);
			}).pipe(Effect.provide(P2FixtureLive))
	);
});

describe('engine/write: telemetry (§5.12)', () => {
	it.effect(
		"an act writes each outcome's event to the host's log, its commit only when it writes",
		() =>
			Effect.gen(function* () {
				const written: LogEvent[] = [];
				const context = yield* Layer.build(
					TelemetryLive.pipe(
						Layer.provide(
							Layer.succeed(Logs, {
								write: (event) =>
									Effect.sync(() => {
										written.push(event);
									}),
								query: () => Port.unavailable('logs')
							})
						)
					)
				);
				const log = () => Context.get(context, Telemetry).open({ invocation: 'i' });
				count.writes = 0;
				ok(
					(yield* run({ verb: 'create', input: [{ title: 'a' }] }, { log: yield* log() })).outcome
				);
				expect(count.writes).toBe(1);
				expect(
					(yield* run({ verb: 'create', input: [{ title: 1 }] }, { log: yield* log() })).outcome
				).toMatchObject({ code: 'invalidInput' });
				expect(count.writes).toBe(1);
				const refusing = callback(() => ({ kind: 'refused', message: 'no' }));
				expect(
					(yield* run(
						{ verb: 'create', input: [{ title: 'b' }] },
						{ ...refusing, log: yield* log() }
					)).outcome
				).toMatchObject({ code: 'refused' });
				expect(count.writes).toBe(2);
				expect(
					written.map((e) => ({
						severity: e.severity,
						event: e.event,
						c: e.attributes['callable']
					}))
				).toEqual([
					{ severity: 'info', event: 'act.settled', c: 'orders.create' },
					{ severity: 'warn', event: 'act.refused', c: 'orders.create' },
					{ severity: 'warn', event: 'act.refused', c: 'orders.create' }
				]);
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
		callback(() => ({ kind: 'refused', message: 'guest' }), 'orders', calls);
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
					{ verb: 'create', input: [{ title: 1 }] },
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
					{ verb: 'create', input: [{ title: 1 }], issuedAt: '2026-09-20T00:00:00.000Z' },
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
					{ verb: 'create', input: [{ title: 1 }], authority: authority({}) },
					refusing(calls)
				).pipe(Effect.map((answer) => answer.outcome))
		}),
		(calls) => ({
			name: 'the caller before write callbacks',
			expect: 'forbidden',
			guest: false,
			writes: 0,
			act: () =>
				Effect.gen(function* () {
					return (yield* run(
						{
							verb: 'update',
							input: [{ target: yield* targetOrder(), set: { note: 'x' } }],
							authority: authority({ orders: grants('orders', { update: [] }) })
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
						{ verb: 'update', input: [{ target: id, set: { note: 'x' } }], observed: { [id]: 7 } },
						refusing(calls)
					)).outcome;
				})
		}),
		(calls) => ({
			name: 'the columns before any guest code',
			expect: 'forbidden',
			guest: false,
			writes: 0,
			act: () =>
				run(
					{
						verb: 'create',
						input: [{ title: 'x' }],
						authority: authority({
							orders: grants('orders', { create: [writeArm({ orders: ['note'] }, true)] })
						})
					},
					refusing(calls)
				).pipe(Effect.map((answer) => answer.outcome))
		}),
		(calls) => ({
			name: 'a denying check before the approval route',
			expect: 'refused',
			guest: true,
			writes: 1,
			act: () =>
				run(
					{
						verb: 'create',
						input: [{ title: 'x' }],
						authority: authority({
							orders: grants('orders', { create: [writeArm(columns('create'), true)] })
						})
					},
					{
						guest: {
							invokeProgram: () => Effect.die('The pipeline fixture does not execute programs'),
							invoke: (inv) =>
								Effect.sync((): GuestOutcome => {
									calls.push(inv);
									return { kind: 'ok', output: { kind: 'deny', message: 'no' } };
								})
						},
						approval: {
							route: () =>
								Effect.sync(() => {
									throw new Error('routed');
								}),
							resubmit: () => Effect.die('resubmitted')
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
				run({ verb: 'create', input: [{ title: 'x' }], authority: routed('create') }, holding).pipe(
					Effect.map((answer) => answer.outcome)
				)
		})
	];
	it.effect('each stage refuses before the next one runs', () =>
		Effect.gen(function* () {
			for (const make of table) {
				const calls: Invocation[] = [],
					row = make(calls);
				count.writes = 0;
				const o = yield* row.act();
				expect(o.kind === 'refused' ? o.code : o.kind, row.name).toBe(row.expect);
				expect(calls.length > 0, row.name).toBe(row.guest);
				expect(count.writes, row.name).toBe(row.writes);
			}
		}).pipe(Effect.provide(P2FixtureLive))
	);
});

describe('engine/write: guest failures (rules 42, 72a)', () => {
	it.effect(
		'a throw is internal, a budget keeps its code, a platform fault throws with its cause',
		() =>
			Effect.gen(function* () {
				const failing = (code: Code) =>
					callback(() => ({
						kind: 'failed',
						error: BoltError.make(code, 'guest', `${code}!`)
					}));
				expect(
					(yield* run({ verb: 'create', input: [{ title: 'a' }] }, failing('guestError'))).outcome
				).toEqual({ kind: 'refused', code: 'internal', message: 'guestError!' });
				expect(
					(yield* run({ verb: 'create', input: [{ title: 'a' }] }, failing('cpuBudget'))).outcome
				).toEqual({ kind: 'refused', code: 'cpuBudget', message: 'cpuBudget!' });
				expect(
					yield* Effect.flip(
						run({ verb: 'create', input: [{ title: 'a' }] }, failing('missingBody'))
					)
				).toMatchObject({ code: 'missingBody' });
			}).pipe(Effect.provide(P2FixtureLive))
	);
});
