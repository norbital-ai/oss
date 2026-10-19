// engine/write on PGlite: one guarantee per test (rules 19–29, 34, 40–43, 45 hook, 70).
import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import {
	TenantDb as TenantDbService,
	type TenantDbShape as TenantDb
} from '../src/engine/db/tenant-db.ts';
import { dbError } from '../src/engine/db/wire.ts';
import type { Json } from '../src/decl/values.ts';
import type { GuestOutcome, Invocation, Lock, Outcome } from '../src/engine/contracts.ts';
import { PgliteDb, Pristine } from '../src/engine/db/pglite.ts';
import { applyPlan, plan, schemaSlice } from '../src/engine/schema/plan.ts';
import { catalogOf, toPred } from '../src/engine/access/pred.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { act, type ActRequest, type WriteEngine } from '../src/engine/write/act.ts';
import { compileCommit } from '../src/engine/write/commit.ts';
import { seed } from '../src/engine/write/seed.ts';
import { admin, arm, authority, grants, manifest, NOW, TODAY } from './write-fixture.ts';

let pg: PGlite, db: TenantDb;
const count = { reads: 0, writes: 0 };
let n = 0;
const fixture = Layer.effectDiscard(
	Effect.gen(function* () {
		pg = yield* PgliteDb.open();
		db = PgliteDb.make(pg);
		yield* applyPlan(db, plan(null, manifest), { accept: true });
		const inner = db;
		db = TenantDbService.typed({
			read: (statements) => (count.reads++, inner.read(statements)),
			write: (statement, lock) => (count.writes++, inner.write(statement, lock)),
			transaction: inner.transaction
		});
		count.reads = 0;
		count.writes = 0;
	})
).pipe(Layer.provide(Pristine.layer));

type Over = Partial<ActRequest> & Pick<ActRequest, 'verb' | 'input'>;
const run = (over: Over, engine: Partial<WriteEngine> = {}) =>
	act(
		{ manifest, db, ...engine },
		{
			collection: 'orders',
			mode: { _tag: 'Direct' },
			key: `key-${n}`,
			issuedAt: NOW,
			authority: admin,
			bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} },
			invocationId: `inv-${n++}`,
			...over
		}
	);
const rows = (sql: string) =>
	Effect.tryPromise({ try: () => pg.query<Record<string, Json>>(sql), catch: dbError }).pipe(
		Effect.map((result) => result.rows)
	);
const one = (sql: string) => rows(sql).pipe(Effect.map((rows) => rows[0]!));
const committed = (o: Outcome) => {
	if (o.kind !== 'committed' && o.kind !== 'pendingApproval') throw new Error(JSON.stringify(o));
	return o;
};
const order = Effect.fn('Test.order')(function* (
	title = 'desk',
	lines: { label: string; amount: string }[] = []
) {
	const o = committed(
		(yield* run({ verb: 'create', input: { title, lines: { create: lines } } })).outcome
	);
	return o.records.find((r) => r.collection === 'orders')!.id;
});

it.effect(
	'checks many-relation read scopes for references and targets in the native read batch',
	() =>
		Effect.gen(function* () {
			const visible = yield* order('visible', [{ label: 'Allowed', amount: '100' }]);
			const hidden = yield* order('hidden', [{ label: 'Private', amount: '1' }]);
			const source = {
				...manifest,
				collections: {
					...manifest.collections,
					tags: {
						...manifest.collections['tags'],
						read: { fields: 'all' as const },
						create: { input: { columns: ['name', 'order'] } }
					}
				}
			};
			const scoped = toPred(source, 'orders', { lines: { some: { amount: { gte: 100 } } } });
			const caller = authority({
				orders: grants({
					read: [arm(scoped)],
					create: [],
					update: [arm(undefined, ['note'])],
					delete: []
				}),
				tags: grants()
			});
			count.reads = 0;
			expect(
				(yield* run(
					{
						collection: 'tags',
						verb: 'create',
						input: { name: 'Allowed reference', order: visible },
						authority: caller
					},
					{ manifest: source }
				)).outcome.kind
			).toBe('committed');
			expect(count.reads).toBe(1);
			expect(
				(yield* run(
					{
						collection: 'tags',
						verb: 'create',
						input: { name: 'Denied reference', order: hidden },
						authority: caller
					},
					{ manifest: source }
				)).outcome
			).toMatchObject({ kind: 'refused', code: 'notFound' });
			expect(
				(yield* run({
					verb: 'update',
					input: { target: visible, set: { note: 'Readable' } },
					authority: caller
				})).outcome.kind
			).toBe('committed');
			expect(
				(yield* run({
					verb: 'update',
					input: { target: hidden, set: { note: 'Hidden' } },
					authority: caller
				})).outcome
			).toMatchObject({ kind: 'refused', code: 'notFound' });
			const denied = authority({
				orders: caller.collections['orders'] ?? grants(),
				tags: grants({ create: [] })
			});
			expect(
				(yield* run(
					{
						collection: 'tags',
						verb: 'create',
						input: { name: 'No grant', order: visible },
						authority: denied
					},
					{ manifest: source }
				)).outcome
			).toMatchObject({ kind: 'refused', code: 'forbidden' });
			expect(yield* rows('SELECT name FROM tags')).toEqual([{ name: 'Allowed reference' }]);
		}).pipe(Effect.provide(fixture))
);

describe('engine/write: one statement per act (rule 20)', () => {
	it.effect(
		'a plain create commits in one write statement with its seq, roll-ups and history',
		() =>
			Effect.gen(function* () {
				const { outcome, captured } = yield* run({
					verb: 'create',
					input: {
						title: 'desk',
						lines: {
							create: [
								{ label: 'a', amount: '40' },
								{ label: 'b', amount: '110.50' }
							]
						}
					}
				});
				expect(count).toEqual({ reads: 0, writes: 1 });
				expect(committed(outcome).records).toHaveLength(3);
				expect(yield* one(`select number, total::text, big_lines, revision from orders`)).toEqual({
					number: 'PO-2026-0001',
					total: '150.50',
					big_lines: 1,
					revision: 1
				});
				expect(
					Number((yield* one(`select count(*) from bolt_history where cause = 'direct'`))['count'])
				).toBe(3);
				expect(captured.map((c) => c.op)).toEqual(['create', 'create', 'create']);
			}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'an unmarked replay writes nothing and returns the first outcome byte for byte; a new body is keyReuse (rule 31)',
		() =>
			Effect.gen(function* () {
				const first = yield* run({
					verb: 'create',
					input: { title: 'desk' },
					key: 'same',
					invocationId: 'a'
				});
				const again = yield* run({
					verb: 'create',
					input: { title: 'desk' },
					key: 'same',
					invocationId: 'b'
				});
				expect(JSON.stringify(again.outcome)).toBe(JSON.stringify(first.outcome));
				expect(again.captured).toEqual([]);
				expect(yield* one(`select count(*)::int n from orders`)).toEqual({ n: 1 });
				expect(yield* one(`select value from bolt_seq`)).toEqual({ value: 1 });
				const marked = yield* run({
					verb: 'create',
					input: { title: 'desk' },
					key: 'same',
					retry: true
				});
				expect(JSON.stringify(marked.outcome)).toBe(JSON.stringify(first.outcome));
				expect(
					(yield* run({ verb: 'create', input: { title: 'chair' }, key: 'same' })).outcome
				).toMatchObject({ kind: 'refused', code: 'keyReuse' });
			}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'a Postgres refusal is one failed commit plus one outcome record, and a replay answers it',
		() =>
			Effect.gen(function* () {
				yield* order('desk');
				count.writes = 0;
				const refused = yield* run({ verb: 'create', input: { title: 'desk' }, key: 'dup' });
				expect(refused.outcome).toMatchObject({ kind: 'refused', code: 'unique' });
				expect(count.writes).toBe(2);
				const replay = yield* run({
					verb: 'create',
					input: { title: 'desk' },
					key: 'dup',
					retry: true
				});
				expect(JSON.stringify(replay.outcome)).toBe(JSON.stringify(refused.outcome));
			}).pipe(Effect.provide(fixture))
	);

	it.effect('a refusal before guest code writes nothing (decode, rule 36)', () =>
		Effect.gen(function* () {
			count.writes = 0;
			expect(
				(yield* run({ verb: 'create', input: { title: 'x', total: '9' } })).outcome
			).toMatchObject({ kind: 'refused', code: 'invalidInput', field: 'total' });
			expect(
				(yield* run({
					collection: 'lines',
					verb: 'create',
					input: { label: 'a', amount: '1', order: '0199a000-0000-7000-8000-0000000000ff' }
				})).outcome
			).toMatchObject({ kind: 'refused', code: 'notFound', field: 'order' });
			expect(count.writes).toBe(0);
		}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'rateLimited at the commit re-check is a failed commit and is never recorded (rule 38)',
		() =>
			Effect.gen(function* () {
				const rate = [{ rule: 'act', bucket: 'a', limit: 1, windowStart: NOW }];
				committed((yield* run({ verb: 'create', input: { title: 'a' }, rate })).outcome);
				expect(
					(yield* run({ verb: 'create', input: { title: 'b' }, rate, key: 'r2' })).outcome
				).toMatchObject({ kind: 'refused', code: 'rateLimited' });
				expect(
					yield* rows(
						`select 1 from bolt_idem_outcome o join bolt_idem i using (key) where i.key <> ''`
					)
				).toHaveLength(1);
			}).pipe(Effect.provide(fixture))
	);
});

describe('engine/write: rows (rules 21, 22, 25, 29, 43)', () => {
	it.effect(
		'a child change moves its parent roll-up in one derived write; nothing is deleted by omission',
		() =>
			Effect.gen(function* () {
				const id = yield* order('desk', [
					{ label: 'a', amount: '40' },
					{ label: 'b', amount: '60' }
				]);
				const [a] = yield* rows(`select id::text from lines order by label`);
				committed(
					(yield* run({ verb: 'update', input: { target: id, set: { note: 'n', lines: {} } } }))
						.outcome
				);
				expect(yield* one(`select count(*)::int n from lines`)).toEqual({ n: 2 });
				const { captured } = yield* run({
					verb: 'update',
					input: {
						target: id,
						set: {
							note: 'm',
							lines: { update: [{ target: String(a!['id']), set: { amount: '140' } }] }
						}
					}
				});
				expect(captured.filter((c) => c.collection === 'orders').map((c) => c.cause)).toEqual([
					'direct'
				]);
				expect(yield* one(`select total::text, big_lines, revision from orders`)).toEqual({
					total: '200',
					big_lines: 1,
					revision: 3
				});
				committed(
					(yield* run({
						collection: 'lines',
						verb: 'update',
						input: { target: String(a!['id']), set: { amount: '1' } }
					})).outcome
				);
				expect(yield* one(`select total::text, big_lines, revision from orders`)).toEqual({
					total: '61',
					big_lines: 0,
					revision: 4
				});
				expect(
					yield* one(`select count(*)::int n from bolt_history where cause = 'derived'`)
				).toEqual({ n: 1 });
			}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'an explicit delete removes one row, and deleting the parent cascades owned children and nulls tags',
		() =>
			Effect.gen(function* () {
				const id = yield* order('desk', [
					{ label: 'a', amount: '40' },
					{ label: 'b', amount: '60' }
				]);
				const [a] = yield* rows(`select id::text from lines order by label`);
				committed(
					(yield* run({
						verb: 'update',
						input: { target: id, set: { lines: { delete: [String(a!['id'])] } } }
					})).outcome
				);
				expect(yield* one(`select total::text from orders`)).toEqual({ total: '60' });
				const tag = committed(
					(yield* run({ collection: 'tags', verb: 'create', input: { name: 't' } })).outcome
				).records[0]!.id;
				committed(
					(yield* run({ verb: 'update', input: { target: id, set: { tags: { link: [tag] } } } }))
						.outcome
				);
				const { captured } = yield* run({ verb: 'delete', input: { target: id } });
				expect(captured.map((c) => `${c.collection}:${c.op}:${c.cause}`).sort()).toEqual([
					'lines:delete:cascade',
					'orders:delete:direct',
					'tags:update:cascade'
				]);
				expect(
					yield* one(`select (select count(*)::int from lines) l, (select "order" from tags) t`)
				).toEqual({ l: 0, t: null });
			}).pipe(Effect.provide(fixture))
	);

	it.effect('an update equal to the stored values writes nothing and commits empty (rule 29)', () =>
		Effect.gen(function* () {
			const id = yield* order('desk');
			const o = committed(
				(yield* run({ verb: 'update', input: { target: id, set: { title: 'desk' } } })).outcome
			);
			expect(o.records).toEqual([]);
			expect(yield* one(`select revision from orders`)).toEqual({ revision: 1 });
		}).pipe(Effect.provide(fixture))
	);

	it.effect('a moved revision fails the act conflict (rule 25)', () =>
		Effect.gen(function* () {
			const id = yield* order('desk');
			committed(
				(yield* run({
					verb: 'update',
					input: { target: id, set: { note: 'a' } },
					observed: { [id]: 1 }
				})).outcome
			);
			expect(
				(yield* run({
					verb: 'update',
					input: { target: id, set: { note: 'b' } },
					observed: { [id]: 1 }
				})).outcome
			).toEqual({ kind: 'conflict', records: [{ collection: 'orders', id, fields: [] }] });
		}).pipe(Effect.provide(fixture))
	);

	it.effect.each(['update', 'delete'] as const)(
		'a nested child %s refuses the original observed revision after a concurrent edit',
		(operation) =>
			Effect.gen(function* () {
				const parent = yield* order('desk', [{ label: 'a', amount: '1' }]);
				const child = yield* one('select id::text, revision from lines');
				const id = child['id'];
				if (typeof id !== 'string' || typeof child['revision'] !== 'number')
					throw new Error('fixture child was not created');
				const observed = { [id]: child['revision'] };
				committed(
					(yield* run({
						collection: 'lines',
						verb: 'update',
						input: { target: id, set: { amount: '2' } }
					})).outcome
				);
				count.writes = 0;
				const operations =
					operation === 'update'
						? { update: [{ target: id, set: { amount: '3' } }] }
						: { delete: [id] };
				const result = yield* run({
					verb: 'update',
					input: { target: parent, set: { note: 'must not commit', lines: operations } },
					observed
				});
				expect(result.outcome).toEqual({
					kind: 'conflict',
					records: [{ collection: 'lines', id, fields: [] }]
				});
				expect(count.writes).toBe(0);
				expect(yield* one('select amount::text, revision from lines')).toEqual({
					amount: '2',
					revision: 2
				});
				expect(yield* one('select note from orders')).toEqual({ note: null });
			}).pipe(Effect.provide(fixture))
	);

	it.effect.each(['link', 'unlink'] as const)(
		'a nested %s refuses a concurrently edited independently related row',
		(operation) =>
			Effect.gen(function* () {
				const parent = yield* order('desk');
				const created = committed(
					(yield* run({ collection: 'tags', verb: 'create', input: { name: 'Original tag' } }))
						.outcome
				);
				const tag = created.records.find((record) => record.collection === 'tags');
				if (tag === undefined) throw new Error('fixture tag was not created');
				if (operation === 'unlink')
					committed(
						(yield* run({
							verb: 'update',
							input: { target: parent, set: { tags: { link: [tag.id] } } }
						})).outcome
					);
				const before = yield* one('select revision from tags');
				if (typeof before['revision'] !== 'number')
					throw new Error('fixture tag revision is missing');
				yield* Effect.tryPromise({
					try: () =>
						pg.query('update tags set name = $1, revision = revision + 1 where id = $2', [
							'Concurrent tag',
							tag.id
						]),
					catch: dbError
				});
				count.writes = 0;
				const result = yield* run({
					verb: 'update',
					input: {
						target: parent,
						set: { note: 'must not commit', tags: { [operation]: [tag.id] } }
					},
					observed: { [tag.id]: before['revision'] }
				});
				expect(result.outcome).toEqual({
					kind: 'conflict',
					records: [{ collection: 'tags', id: tag.id, fields: [] }]
				});
				expect(count.writes).toBe(0);
				expect(yield* one('select name, "order"::text as parent from tags')).toEqual({
					name: 'Concurrent tag',
					parent: operation === 'unlink' ? parent : null
				});
				expect(yield* one('select note from orders')).toEqual({ note: null });
			}).pipe(Effect.provide(fixture))
	);

	it.effect('upsert matches by id, creates without one, and keep writes nothing (rule 28)', () =>
		Effect.gen(function* () {
			const id = yield* order('desk');
			const kept = committed(
				(yield* run({ verb: 'upsert', input: { id, note: 'x' }, onConflict: 'keep' })).outcome
			);
			expect(kept).toMatchObject({ output: [id], records: [] });
			const updated = committed(
				(yield* run({ verb: 'upsert', input: { id, note: 'x' }, onConflict: 'update' })).outcome
			);
			expect(updated).toMatchObject({ output: [id], records: [{ id, revision: 2 }] });
			const made = (yield* run({ verb: 'upsert', input: { title: 'chair' }, onConflict: 'update' }))
				.outcome;
			if (made.kind !== 'committed') throw new Error(JSON.stringify(made));
			expect(made.output).toEqual([made.records[0]!.id]);
			expect(
				(yield* run({
					verb: 'upsert',
					input: { id: '0199a000-0000-7000-8000-0000000000aa', note: 'x' },
					onConflict: 'update'
				})).outcome
			).toMatchObject({ code: 'notFound', field: 'id' });
			expect(
				(yield* run({ verb: 'upsert', input: null, onConflict: 'update' })).outcome
			).toMatchObject({ code: 'invalidInput' });
			expect(
				(yield* run({ verb: 'upsert', input: { id: 4, note: 'x' }, onConflict: 'update' })).outcome
			).toMatchObject({ code: 'invalidInput', field: 'id' });
		}).pipe(Effect.provide(fixture))
	);

	it.effect('upserts a collection without a natural key', () =>
		Effect.gen(function* () {
			const parent = yield* order('desk');
			const made = committed(
				(yield* run({
					collection: 'lines',
					verb: 'upsert',
					input: { order: parent, label: 'part', amount: '1' },
					onConflict: 'update'
				})).outcome
			);
			const id = made.records[0]!.id;
			expect(made).toMatchObject({ output: [id] });
			const changed = committed(
				(yield* run({
					collection: 'lines',
					verb: 'upsert',
					input: { id, amount: '2' },
					onConflict: 'update'
				})).outcome
			);
			expect(changed).toMatchObject({ output: [id], records: [{ id, revision: 2 }] });
		}).pipe(Effect.provide(fixture))
	);
});

describe('engine/write: model rules (rules 34, 40, 41)', () => {
	it.effect('a state moves only along `to`, and a create lands in initial', () =>
		Effect.gen(function* () {
			expect(
				(yield* run({ verb: 'create', input: { title: 'x', status: 'submitted' } })).outcome
			).toMatchObject({ code: 'invalidInput', field: 'status' });
			const id = yield* order('desk');
			committed(
				(yield* run({ verb: 'update', input: { target: id, set: { status: 'submitted' } } }))
					.outcome
			);
			committed(
				(yield* run({ verb: 'update', input: { target: id, set: { status: 'draft' } } })).outcome
			);
		}).pipe(Effect.provide(fixture))
	);

	it.effect('per-state edit locks updates for administrators too; a delete is not locked', () =>
		Effect.gen(function* () {
			const id = yield* order('desk', [{ label: 'a', amount: '1' }]);
			committed(
				(yield* run({ verb: 'update', input: { target: id, set: { status: 'submitted' } } }))
					.outcome
			);
			expect(
				(yield* run({ verb: 'update', input: { target: id, set: { title: 'y' } } })).outcome
			).toMatchObject({ code: 'locked', field: 'title' });
			committed(
				(yield* run({ verb: 'update', input: { target: id, set: { note: 'allowed' } } })).outcome
			);
			// the owned child re-tests its parent's state under FOR SHARE inside the statement: a recorded refusal
			const [line] = yield* rows(`select id::text from lines`);
			count.writes = 0;
			expect(
				(yield* run({
					collection: 'lines',
					verb: 'update',
					input: { target: String(line!['id']), set: { amount: '2' } }
				})).outcome
			).toMatchObject({ code: 'locked' });
			expect(count.writes).toBe(2);
			committed((yield* run({ verb: 'delete', input: { target: id } })).outcome);
		}).pipe(Effect.provide(fixture))
	);

	it.effect('a caller moves a state only along edges its grant lists (moves)', () =>
		Effect.gen(function* () {
			const id = yield* order('desk');
			const caller = authority({ orders: grants({ moves: {} }) });
			expect(
				(yield* run({
					verb: 'update',
					input: { target: id, set: { status: 'submitted' } },
					authority: caller
				})).outcome
			).toMatchObject({ code: 'forbidden', field: 'status' });
		}).pipe(Effect.provide(fixture))
	);
});

describe('engine/write: the caller (rules 13, 19, 35)', () => {
	it.effect(
		'out of read scope is notFound, out of write scope is forbidden, a field outside `fields` is named',
		() =>
			Effect.gen(function* () {
				const id = yield* order('secret');
				const notMine = {
					t: 'cmp',
					field: 'title',
					op: 'ne',
					arg: { _tag: 'Lit', value: 'secret' }
				} as const;
				expect(
					(yield* run({
						verb: 'update',
						input: { target: id, set: { note: 'x' } },
						authority: authority({ orders: grants({ read: [arm(notMine)] }) })
					})).outcome
				).toMatchObject({ code: 'notFound' });
				expect(
					(yield* run({
						verb: 'update',
						input: { target: id, set: { note: 'x' } },
						authority: authority({ orders: grants({ update: [arm(notMine)] }) })
					})).outcome
				).toMatchObject({ code: 'forbidden' });
				expect(
					(yield* run({
						verb: 'update',
						input: { target: id, set: { note: 'x' } },
						authority: authority({ orders: grants({ update: [arm(undefined, ['title'])] }) })
					})).outcome
				).toMatchObject({ code: 'forbidden', field: 'note' });
			}).pipe(Effect.provide(fixture))
	);

	it.effect('a create is scoped on its post-image, after the transform (rule 35)', () =>
		Effect.gen(function* () {
			const onlyUpper = {
				t: 'cmp',
				field: 'title',
				op: 'eq',
				arg: { _tag: 'Lit', value: 'DESK' }
			} as const;
			const caller = authority({ orders: grants({ create: [arm(onlyUpper)] }) });
			expect(
				(yield* run({ verb: 'create', input: { title: 'desk' }, authority: caller })).outcome
			).toMatchObject({ code: 'forbidden' });
			const upper = transformEngine((inv) => ({
				kind: 'ok',
				cpuMs: 1,
				output: Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ title: Schema.String })))(
					inv.input
				).map((x) => ({ ...x, title: x.title.toUpperCase() }))
			}));
			committed(
				(yield* run({ verb: 'create', input: { title: 'desk' }, authority: caller }, upper)).outcome
			);
		}).pipe(Effect.provide(fixture))
	);
});

function transformEngine(
	body: (inv: Invocation) => GuestOutcome,
	calls: Invocation[] = []
): Partial<WriteEngine> {
	return {
		transforms: new Set(['orders']),
		guest: {
			invokeProgram: () =>
				Effect.die(new Error('This fixture does not execute supplied guest programs.')),
			invoke: (inv) => Effect.sync(() => (calls.push(inv), body(inv)))
		}
	};
}

describe('engine/write: the transform (rules 19, 27)', () => {
	it.effect('gives an id upsert its stored row, without passing id to the transform payload', () =>
		Effect.gen(function* () {
			const calls: Invocation[] = [];
			const engine = transformEngine((inv) => ({ kind: 'ok', cpuMs: 1, output: inv.input }), calls);
			const id = yield* order('desk');
			const changed = committed(
				(yield* run(
					{
						verb: 'upsert',
						input: { id, note: 'measured', lines: { create: [{ label: 'tile', amount: '2' }] } },
						onConflict: 'update'
					},
					engine
				)).outcome
			);
			expect(changed).toMatchObject({ output: [id] });
			expect(calls[0]!.input).toEqual([
				{ note: 'measured', lines: { create: [{ label: 'tile', amount: '2' }] } }
			]);
			expect(calls[0]!.ctx.existing![0]).toMatchObject({ id, title: 'desk' });
			expect(yield* rows(`select note from orders`)).toEqual([{ note: 'measured' }]);
			expect(yield* rows(`select label from lines`)).toEqual([{ label: 'tile' }]);
		}).pipe(Effect.provide(fixture))
	);

	it.effect('runs once per batch with ctx.existing, and its payload is the write', () =>
		Effect.gen(function* () {
			const calls: Invocation[] = [];
			const engine = transformEngine(
				(inv) => ({
					kind: 'ok',
					cpuMs: 1,
					output: Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Json)))(
						inv.input
					).map((x) => ({ ...x, note: 'derived' }))
				}),
				calls
			);
			const id = yield* order('a');
			committed(
				(yield* run({ verb: 'update', input: [{ target: id, set: { title: 'b' } }] }, engine))
					.outcome
			);
			committed(
				(yield* run({ verb: 'create', input: [{ title: 'c' }, { title: 'd' }] }, engine)).outcome
			);
			expect(
				calls.map((c) => Schema.decodeUnknownSync(Schema.Array(Schema.Json))(c.input).length)
			).toEqual([1, 2]);
			expect(calls[0]!.ctx.existing![0]).toMatchObject({ title: 'a' });
			expect(yield* rows(`select note from orders order by title`)).toEqual([
				{ note: 'derived' },
				{ note: 'derived' },
				{ note: 'derived' }
			]);
		}).pipe(Effect.provide(fixture))
	);

	it.effect('a refusal is recorded, so a replay answers it without running guest code again', () =>
		Effect.gen(function* () {
			const calls: Invocation[] = [];
			const engine = transformEngine(
				() => ({ kind: 'refused', message: 'no desks', field: 'title', cpuMs: 1 }),
				calls
			);
			const first = yield* run({ verb: 'create', input: { title: 'desk' }, key: 'g' }, engine);
			expect(first.outcome).toEqual({
				kind: 'refused',
				code: 'refused',
				message: 'no desks',
				field: 'title',
				rule: 'orders.transform'
			});
			const replay = yield* run(
				{ verb: 'create', input: { title: 'desk' }, key: 'g', retry: true },
				engine
			);
			expect(replay.outcome).toEqual(first.outcome);
			expect(calls).toHaveLength(1);
		}).pipe(Effect.provide(fixture))
	);
});

describe('engine/write: locks and queued pieces (rules 26, 49)', () => {
	it.effect(
		'a transform that read takes one sorted SHARE ROW EXCLUSIVE lock over write and read tables',
		() =>
			Effect.gen(function* () {
				const locks: (Lock | undefined)[] = [];
				const inner = db;
				db = TenantDbService.typed({
					read: inner.read,
					write: (statement, lock) => (locks.push(lock), inner.write(statement, lock)),
					transaction: inner.transaction
				});
				const engine = {
					...transformEngine((inv) => ({ kind: 'ok', cpuMs: 1, output: inv.input })),
					bridge: () => ({ cross: () => Effect.succeed([]), tables: () => ['tags'] })
				};
				committed((yield* run({ verb: 'create', input: { title: 'a' } }, engine)).outcome);
				expect(locks).toEqual([{ tables: ['orders', 'tags'], mode: 'SHARE ROW EXCLUSIVE' }]);
			}).pipe(Effect.provide(fixture))
	);

	it.effect('queued runs and notices are pieces of the statement, behind the gate', () =>
		Effect.gen(function* () {
			const x = {
				key: 'q',
				digest: 'd',
				issuedAt: NOW,
				now: NOW,
				today: TODAY,
				actor: admin.actor,
				writes: [],
				owned: [],
				rate: [],
				output: null,
				runs: [
					{
						id: 'r1',
						automation: 'remind',
						input: { a: 1 },
						dueAt: NOW,
						cause: 'act',
						depth: 0,
						key: 'once'
					}
				],
				notices: [{ id: 'n1', to: { channel: 'mail', recipients: [{ user: 'u' }] }, title: 'Hi' }]
			};
			yield* db.write(compileCommit(manifest, catalogOf(manifest), x));
			yield* db.write(
				compileCommit(manifest, catalogOf(manifest), { ...x, runs: [{ ...x.runs[0]!, id: 'r2' }] })
			);
			// the mail notice queues its own delivery run, once, like the rest
			expect(
				yield* one(`select (select count(*)::int from sys_run where automation = 'remind') r, (select count(*)::int from sys_run where automation = 'notifications.deliver') d,
			(select count(*)::int from sys_notification) n`)
			).toEqual({ r: 1, d: 1, n: 1 });
		}).pipe(Effect.provide(fixture))
	);
});

describe('engine/write: approval hook points (rules 44–46, P3)', () => {
	it.effect('a routed create commits provisionally under the request the hook opens', () =>
		Effect.gen(function* () {
			const requestId = '0199a000-0000-7000-8000-0000000000aa';
			const routed = authority({
				orders: grants({
					create: [],
					approval: { create: [{ steps: [['finance']] }], update: [], delete: [] }
				})
			});
			const engine: Partial<WriteEngine> = {
				approval: {
					route: () =>
						Effect.succeed({
							requestId,
							route: { steps: [['finance']], superseded_by: [] },
							pieces: () => {}
						})
				}
			};
			const o = (yield* run(
				{ verb: 'create', input: { title: 'held' }, authority: routed },
				engine
			)).outcome;
			expect(o).toMatchObject({ kind: 'pendingApproval', requestId });
			const [created] = yield* rows(`select id::text from orders`);
			expect(o).toMatchObject({
				records: [{ collection: 'orders', id: created?.['id'], revision: 1 }]
			});
			expect(yield* rows(`select request::text from bolt_history`)).toEqual([
				{ request: requestId }
			]);
		}).pipe(Effect.provide(fixture))
	);
});

describe('engine/write: seed mode (rule 70, X-13)', () => {
	it.effect(
		'restores rows as given, derives roll-ups, refuses drift, and the next number follows the highest seeded',
		() =>
			Effect.gen(function* () {
				const o = '0199a000-0000-4000-8000-000000000001';
				const pack = {
					orders: [
						{ id: o, title: 'seeded', number: 'PO-2026-0042', status: 'submitted', total: '5.00' }
					],
					lines: [{ id: '0199a000-0000-4000-8000-000000000002', label: 'a', amount: '5', order: o }]
				};
				expect(yield* seed(manifest, db, pack, NOW)).toEqual({ inserted: 2 });
				expect(yield* seed(manifest, db, pack, NOW)).toEqual({ inserted: 0 });
				expect(yield* one(`select status, total::text from orders`)).toEqual({
					status: 'submitted',
					total: '5'
				});
				expect(
					(yield* Effect.flip(
						seed(
							manifest,
							db,
							{
								orders: [
									{
										...pack.orders[0]!,
										id: '0199a000-0000-4000-8000-000000000003',
										title: 'x',
										number: 'PO-2026-0001',
										total: '9'
									}
								]
							},
							NOW
						)
					)).message
				).toMatch(/SeedDrift|total/);
				committed((yield* run({ verb: 'create', input: { title: 'next' } })).outcome);
				expect(yield* one(`select number from orders where title = 'next'`)).toEqual({
					number: 'PO-2026-0043'
				});
			}).pipe(Effect.provide(fixture))
	);
});

describe('engine/write: grants walk relation hops to any depth (rules 35, 36)', () => {
	it.effect(
		'loads only read scopes for a reference, while real mutations still enforce its draft parent',
		() =>
			Effect.gen(function* () {
				const ext = {
					...manifest,
					models: {
						...manifest.models,
						notes: { description: 'A note', label: 'body', fields: { body: { kind: 'text' } } }
					},
					relationships: {
						...manifest.relationships,
						'notes.line': { to: 'lines', inverse: 'notes' }
					},
					collections: {
						...manifest.collections,
						notes: { read: { fields: 'all' }, create: { input: { columns: ['body', 'line'] } } }
					}
				} satisfies EngineManifest;
				yield* applyPlan(db, plan(schemaSlice(manifest), ext), { accept: true });
				const parent = yield* order('draft-parent', [{ label: 'a', amount: '1' }]);
				const line = String(
					(yield* one(`select id::text from lines where "order" = '${parent}'`))['id']
				);
				const draft = toPred(ext, 'lines', { order: { is: { status: { eq: 'draft' } } } });
				const caller = authority({
					lines: grants({ create: [arm(draft)], update: [arm(draft)], delete: [arm(draft)] }),
					notes: grants()
				});
				const reference = (body: string) =>
					run(
						{
							collection: 'notes',
							verb: 'create',
							input: { body, line },
							authority: caller
						},
						{ manifest: ext }
					);
				count.reads = 0;
				expect((yield* reference('draft reference')).outcome.kind).toBe('committed');
				expect(count.reads).toBe(1);
				count.reads = 0;
				expect(
					(yield* run(
						{
							collection: 'lines',
							verb: 'update',
							input: { target: line, set: { amount: '2' } },
							authority: caller
						},
						{ manifest: ext }
					)).outcome.kind
				).toBe('committed');
				expect(count.reads).toBe(2);
				committed(
					(yield* run({
						verb: 'update',
						input: { target: parent, set: { status: 'submitted' } }
					})).outcome
				);
				count.reads = 0;
				expect((yield* reference('locked reference')).outcome.kind).toBe('committed');
				expect(count.reads).toBe(1);
				const verbs: readonly ('update' | 'delete')[] = ['update', 'delete'];
				for (const verb of verbs) {
					count.reads = 0;
					const result = yield* run(
						{
							collection: 'lines',
							verb,
							input: verb === 'update' ? { target: line, set: { amount: '3' } } : { target: line },
							authority: caller
						},
						{ manifest: ext }
					);
					expect(result.outcome).toMatchObject({ kind: 'refused', code: 'forbidden' });
					expect(result.captured).toEqual([]);
					expect(count.reads).toBe(2);
				}
				expect(yield* rows('SELECT body FROM notes ORDER BY body')).toEqual([
					{ body: 'draft reference' },
					{ body: 'locked reference' }
				]);
				expect(yield* rows('SELECT amount::text FROM lines')).toEqual([{ amount: '2' }]);
			}).pipe(Effect.provide(fixture))
	);
	it.effect(
		'a supplied ref is readable through its parent, and a create scope through two hops, in one extra round trip',
		() =>
			Effect.gen(function* () {
				const ext = {
					...manifest,
					models: {
						...manifest.models,
						notes: { description: 'A note', label: 'body', fields: { body: { kind: 'text' } } }
					},
					relationships: {
						...manifest.relationships,
						'notes.line': { to: 'lines', inverse: 'notes' }
					},
					collections: {
						...manifest.collections,
						notes: { read: { fields: 'all' }, create: { input: { columns: ['body', 'line'] } } }
					}
				} satisfies EngineManifest;
				yield* applyPlan(db, plan(schemaSlice(manifest), ext), { accept: true });
				const id = yield* order('desk', [{ label: 'a', amount: '1' }]);
				const line = String(
					(yield* one(`select id::text from lines where "order" = '${id}'`))['id']
				);
				const desk = { title: { eq: 'desk' } };
				const caller = (title: object) =>
					authority({
						lines: grants({ read: [arm(toPred(ext, 'lines', { order: { is: title } }))] }),
						notes: grants({
							create: [arm(toPred(ext, 'notes', { line: { is: { order: { is: title } } } }))]
						})
					});
				const note = (who: ReturnType<typeof caller>) =>
					act(
						{ manifest: ext, db },
						{
							collection: 'notes',
							verb: 'create',
							mode: { _tag: 'Direct' },
							input: { body: 'hi', line },
							key: `key-${n}`,
							issuedAt: NOW,
							authority: who,
							bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} },
							invocationId: `inv-${n++}`
						}
					);
				count.reads = 0;
				committed((yield* note(caller(desk))).outcome);
				expect(count.reads).toBe(2);
				expect((yield* note(caller({ title: { eq: 'chair' } }))).outcome).toMatchObject({
					kind: 'refused',
					code: 'notFound',
					field: 'line'
				});
			}).pipe(Effect.provide(fixture))
	);
});
