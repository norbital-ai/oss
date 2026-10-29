// engine/write on PGlite: one guarantee per test (rules 19–29, 34, 40–43, 45 hook, 70).
import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Layer, Schema, Stream } from 'effect';
import {
	TenantDb as TenantDbService,
	type TenantDbShape as TenantDb
} from '../src/engine/db/tenant-db.ts';
import { dbError } from '../src/engine/db/wire.ts';
import type { Json } from '../src/decl/values.ts';
import type { ApprovalSnapshot } from '../src/decl/access/policy.ts';
import type { GuestOutcome, Invocation, Lock, Outcome } from '../src/engine/contracts.ts';
import { PgliteDb, type PgliteClient } from '../src/node/db/pglite.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { catalogOf } from '../src/engine/access/pred.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import {
	act,
	type ActRequest,
	type ApprovalHook,
	type WriteEngine
} from '../src/engine/write/act.ts';
import { executeCommit, type Commit } from '../src/engine/write/commit.ts';
import { restorer, restoreSource, seed } from '../src/engine/write/seed.ts';
import { aggregate } from '@norbital-ai/store';
import type { GuestShape } from '../src/engine/services.ts';
import { BoltError, fromStore } from '../src/protocol/errors.ts';
import { bridgeOn, open } from './write-p2.fixture.ts';
import {
	admin,
	arm,
	authority,
	grants,
	manifest,
	member,
	NOW,
	TODAY,
	writeArm
} from './write-fixture.ts';

let pg: PGlite, db: TenantDb;
const count = { reads: 0, writes: 0 };
const native = { active: 0, batches: 0, streams: 0 };
let n = 0;
const fixtureFor = (schema: EngineManifest) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			pg = yield* TestDb.open(schema);
			const client: PgliteClient = {
				query: (text, params) => pg.query(text, params),
				exec: (text) => pg.exec(text),
				execProtocol: pg.execProtocol.bind(pg),
				parsers: pg.parsers,
				transaction: (body) => {
					let entered = false;
					return pg
						.transaction(async (tx) => {
							expect(native.streams).toBe(0);
							entered = true;
							native.active++;
							native.batches++;
							return await body(tx);
						})
						.finally(() => {
							if (entered) native.active--;
						});
				}
			};
			db = PgliteDb.make(client);
			const inner = db;
			db = TenantDbService.typed({
				read: (statements) => (count.reads++, inner.read(statements)),
				write: (statement, lock) => (count.writes++, inner.write(statement, lock)),
				transaction: (batch) => (count.writes++, inner.transaction(batch)),
				session: inner.session
			});
			count.reads = 0;
			count.writes = 0;
		})
	);
/** The write workspace plus the models a few rules need: a ref onto `lines`, an arc, json shapes, checks, a sys_user ref. */
const ext = {
	...manifest,
	models: {
		...manifest.models,
		projects: {
			description: 'A project',
			label: 'title',
			fields: {
				title: { kind: 'text' },
				profile: {
					kind: 'json',
					optional: true,
					shape: {
						kind: 'object',
						fields: {
							grade: { kind: 'enum', values: ['a', 'b'] },
							weight: { kind: 'number', optional: true }
						}
					}
				},
				stock: { kind: 'int', default: 0 }
			},
			check: {
				stock_not_negative: {
					where: { stock: { gte: 0 } },
					message: 'Stock cannot go below zero.'
				},
				bare: { stock: { lte: 1000 } }
			}
		},
		quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' } } },
		activities: {
			description: 'An activity',
			label: 'subject',
			fields: { subject: { kind: 'text' } }
		},
		notes: { description: 'A note', label: 'body', fields: { body: { kind: 'text' } } }
	},
	relationships: {
		...manifest.relationships,
		'activities.regarding': { to: ['projects', 'quotes'], optional: true, inverse: 'activities' },
		'projects.owner': { to: 'sys_user', optional: true, default: { var: 'requestor.id' } },
		'notes.line': { to: 'lines', inverse: 'notes' }
	},
	exposures: {
		...manifest.exposures,
		projects: {
			read: { projects: { fields: 'all' } },
			create: { columns: { projects: ['title', 'profile', 'stock', 'owner'] } }
		},
		quotes: { read: { quotes: { fields: 'all' } }, create: { columns: { quotes: ['title'] } } },
		activities: {
			read: { activities: { fields: 'all' } },
			create: { columns: { activities: ['subject', 'regarding'] } },
			update: { columns: { activities: ['regarding'] } }
		},
		notes: {
			read: { notes: { fields: 'all' } },
			create: { columns: { notes: ['body', 'line'] } }
		}
	}
} satisfies EngineManifest;
// one schema for the file: `ext` holds every model `manifest` does, so plain acts run on it unchanged
const fixture = fixtureFor(ext);

/** Observe the actual source's pulls and finalizer, including a bounded chunk's early close. */
const outsideBatch = <A, E, R>(source: Stream.Stream<A, E, R>) =>
	Stream.unwrap(
		Effect.sync(() => {
			expect(native.active).toBe(0);
			native.streams++;
			return source.pipe(
				Stream.tap(() => Effect.sync(() => expect(native.active).toBe(0))),
				Stream.ensuring(
					Effect.sync(() => {
						expect(native.active).toBe(0);
						native.streams--;
					})
				)
			);
		})
	);

type Over = Partial<ActRequest> & Pick<ActRequest, 'verb' | 'input'>;
/**
 * A write engine whose guest answers each policy `check` (`kind: 'policy'`, `'<policy>.<model>.<op>'`) with the verdict
 * data `verdict` gives, recording every invocation; it runs no other body.
 */
const checking = (
	verdict: (inv: Invocation) => Json,
	calls: Invocation[] = []
): Partial<WriteEngine> => ({
	guest: {
		invokeProgram: () =>
			Effect.die(new Error('This fixture does not execute supplied guest programs.')),
		invoke: (inv) =>
			Effect.sync((): GuestOutcome => {
				calls.push(inv);
				return { kind: 'ok', output: inv.kind === 'policy' ? verdict(inv) : null };
			})
	}
});
const orderColumns = manifest.exposures['orders']?.update?.columns ?? {};
const run = (over: Over, engine: Partial<WriteEngine> = {}) =>
	act(
		{ manifest, db, ...engine },
		{
			model: 'orders',
			mode: { _tag: 'Direct' },
			key: `key-${n}`,
			issuedAt: NOW,
			authority: admin,
			bindings: { now: NOW, today: TODAY, tz: 'UTC' },
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
	const o = committed((yield* run({ verb: 'create', input: [{ title, lines }] })).outcome);
	return o.records.find((r) => r.model === 'orders')!.id;
});

describe('engine/write: one statement per act (rule 20)', () => {
	it.effect(
		'a plain create commits in one write statement with its seq, roll-ups and history',
		() =>
			Effect.gen(function* () {
				const { outcome, captured } = yield* run({
					verb: 'create',
					input: [
						{
							title: 'desk',
							lines: [
								{ label: 'a', amount: '40' },
								{ label: 'b', amount: '110.50' }
							]
						}
					]
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
					input: [{ title: 'desk' }],
					key: 'same',
					invocationId: 'a'
				});
				const again = yield* run({
					verb: 'create',
					input: [{ title: 'desk' }],
					key: 'same',
					invocationId: 'b'
				});
				expect(JSON.stringify(again.outcome)).toBe(JSON.stringify(first.outcome));
				expect(again.captured).toEqual([]);
				expect(yield* one(`select count(*)::int n from orders`)).toEqual({ n: 1 });
				expect(yield* one(`select value from bolt_seq`)).toEqual({ value: 1 });
				const marked = yield* run({
					verb: 'create',
					input: [{ title: 'desk' }],
					key: 'same',
					retry: true
				});
				expect(JSON.stringify(marked.outcome)).toBe(JSON.stringify(first.outcome));
				expect(
					(yield* run({ verb: 'create', input: [{ title: 'chair' }], key: 'same' })).outcome
				).toMatchObject({ kind: 'refused', code: 'keyReuse' });
			}).pipe(Effect.provide(fixture))
	);

	it.effect(
		'rateLimited at the commit re-check is a failed commit and is never recorded (rule 38)',
		() =>
			Effect.gen(function* () {
				const rate = [{ rule: 'act', bucket: 'a', limit: 1, windowStart: NOW }];
				committed((yield* run({ verb: 'create', input: [{ title: 'a' }], rate })).outcome);
				expect(
					(yield* run({ verb: 'create', input: [{ title: 'b' }], rate, key: 'r2' })).outcome
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
					(yield* run({ verb: 'update', input: [{ target: id, set: { note: 'n', lines: {} } }] }))
						.outcome
				);
				expect(yield* one(`select count(*)::int n from lines`)).toEqual({ n: 2 });
				const { captured } = yield* run({
					verb: 'update',
					input: [
						{
							target: id,
							set: {
								note: 'm',
								lines: { update: [{ target: String(a!['id']), set: { amount: '140' } }] }
							}
						}
					]
				});
				expect(captured.filter((c) => c.model === 'orders').map((c) => c.cause)).toEqual([
					'direct'
				]);
				expect(yield* one(`select total::text, big_lines, revision from orders`)).toEqual({
					total: '200',
					big_lines: 1,
					revision: 3
				});
				committed(
					(yield* run({
						model: 'lines',
						verb: 'update',
						input: [{ target: String(a!['id']), set: { amount: '1' } }]
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
		'a moved revision is a conflict (rule 25); a no-op update names what held its values; upsert matches by id, creates without one, and keep writes nothing (rule 28)',
		() =>
			Effect.gen(function* () {
				const id = yield* order('desk');
				committed(
					(yield* run({
						verb: 'update',
						input: [{ target: id, set: { note: 'x' } }],
						observed: { [id]: 1 }
					})).outcome
				);
				expect(
					(yield* run({
						verb: 'update',
						input: [{ target: id, set: { note: 'b' } }],
						observed: { [id]: 1 }
					})).outcome
				).toEqual({ kind: 'conflict', records: [{ model: 'orders', id, fields: [] }] });
				expect(
					(yield* run({ verb: 'update', input: [{ target: id, set: { note: 'x' } }] })).outcome
				).toEqual({
					kind: 'committed',
					output: null,
					records: [],
					unchanged: [{ model: 'orders', id }]
				});
				const kept = committed(
					(yield* run({ verb: 'upsert', input: [{ id, note: 'y' }], onConflict: 'keep' })).outcome
				);
				expect(kept).toMatchObject({ output: [id], records: [] });
				const updated = committed(
					(yield* run({ verb: 'upsert', input: [{ id, note: 'y' }], onConflict: 'update' })).outcome
				);
				expect(updated).toMatchObject({ output: [id], records: [{ id, revision: 3 }] });
				const made = (yield* run({
					verb: 'upsert',
					input: [{ title: 'chair' }],
					onConflict: 'update'
				})).outcome;
				if (made.kind !== 'committed') throw new Error(JSON.stringify(made));
				expect(made.output).toEqual([made.records[0]!.id]);
				expect(
					(yield* run({
						verb: 'upsert',
						input: [{ id: '0199a000-0000-7000-8000-0000000000aa', note: 'x' }],
						onConflict: 'update'
					})).outcome
				).toMatchObject({ code: 'notFound', field: 'id' });
			}).pipe(Effect.provide(fixture))
	);
});

describe('engine/write: model rules (rules 34, 40, 41)', () => {
	it.effect(
		'a create lands in initial; a state moves along `to` and only along the edges a grant lists; per-state edit locks administrators too; a delete is not locked',
		() =>
			Effect.gen(function* () {
				expect(
					(yield* run({ verb: 'create', input: [{ title: 'x', status: 'submitted' }] })).outcome
				).toMatchObject({ code: 'invalidInput', field: 'status' });
				const id = yield* order('desk', [{ label: 'a', amount: '1' }]);
				expect(
					(yield* run({
						verb: 'update',
						input: [{ target: id, set: { status: 'submitted' } }],
						authority: authority({ orders: grants('orders', { moves: {} }) })
					})).outcome
				).toMatchObject({ code: 'forbidden', field: 'status' });
				committed(
					(yield* run({ verb: 'update', input: [{ target: id, set: { status: 'submitted' } }] }))
						.outcome
				);
				expect(
					(yield* run({ verb: 'update', input: [{ target: id, set: { title: 'y' } }] })).outcome
				).toMatchObject({ code: 'locked', field: 'title' });
				committed(
					(yield* run({ verb: 'update', input: [{ target: id, set: { note: 'allowed' } }] }))
						.outcome
				);
				// the owned child re-tests its parent's state under FOR SHARE inside the statement: a recorded refusal
				const [line] = yield* rows(`select id::text from lines`);
				count.writes = 0;
				expect(
					(yield* run({
						model: 'lines',
						verb: 'update',
						input: [{ target: String(line!['id']), set: { amount: '2' } }]
					})).outcome
				).toMatchObject({ code: 'locked' });
				expect(count.writes).toBe(2);
				committed((yield* run({ verb: 'delete', input: [{ target: id }] })).outcome);
			}).pipe(Effect.provide(fixture))
	);
});

describe('engine/write: the caller (rules 13, 19, 35)', () => {
	it.effect(
		'out of read scope is notFound; a column outside `columns` is forbidden before any check; a denying check refuses',
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
						input: [{ target: id, set: { note: 'x' } }],
						authority: authority({
							orders: grants('orders', { read: { default: { orders: [arm(notMine)] } } })
						})
					})).outcome
				).toMatchObject({ code: 'notFound' });
				const calls: Invocation[] = [];
				const deny = checking(() => ({ kind: 'deny', message: 'Not this order.' }), calls);
				expect(
					(yield* run(
						{
							verb: 'update',
							input: [{ target: id, set: { note: 'x' } }],
							authority: authority({
								orders: grants('orders', { update: [writeArm({ orders: ['title'] }, true)] })
							})
						},
						deny
					)).outcome
				).toMatchObject({ code: 'forbidden', field: 'note' });
				expect(calls).toEqual([]);
				expect(
					(yield* run(
						{
							verb: 'update',
							input: [{ target: id, set: { note: 'x' } }],
							authority: authority({
								orders: grants('orders', { update: [writeArm(orderColumns, true)] })
							})
						},
						deny
					)).outcome
				).toMatchObject({
					kind: 'refused',
					code: 'refused',
					message: 'Not this order.',
					rule: 'p.orders.update'
				});
				expect(calls.map(({ kind, target }) => [kind, target])).toEqual([
					['policy', 'p.orders.update']
				]);
				expect(yield* one(`select note from orders where id = '${id}'`)).toEqual({ note: null });
			}).pipe(Effect.provide(fixture))
	);

	it.effect('a create check judges the whole batch, nested layers included, in one call', () =>
		Effect.gen(function* () {
			const calls: Invocation[] = [];
			const upperOnly = checking((inv) => {
				const rows = Schema.decodeUnknownSync(
					Schema.Array(Schema.Struct({ title: Schema.String }))
				)(inv.input);
				const row = rows.findIndex((r) => r.title !== r.title.toUpperCase());
				return row < 0
					? { kind: 'allow' }
					: { kind: 'deny', message: 'Titles are upper case.', at: { row, field: 'title' } };
			}, calls);
			const caller = authority({
				orders: grants('orders', {
					create: [writeArm(manifest.exposures['orders']?.create?.columns ?? {}, true)]
				})
			});
			const batch = [
				{ title: 'DESK', lines: [{ label: 'a', amount: '1' }] },
				{ title: 'chair', lines: [{ label: 'b', amount: '2' }] }
			];
			expect(
				(yield* run({ verb: 'create', input: batch, authority: caller }, upperOnly)).outcome
			).toMatchObject({ kind: 'refused', code: 'refused', row: 1, field: 'title' });
			expect(yield* rows(`select title from orders`)).toEqual([]);
			expect(calls).toHaveLength(1);
			expect(calls[0]).toMatchObject({ kind: 'policy', target: 'p.orders.create', input: batch });
			committed(
				(yield* run(
					{
						verb: 'create',
						input: [batch[0]!, { ...batch[1]!, title: 'CHAIR' }],
						authority: caller
					},
					upperOnly
				)).outcome
			);
			expect(calls).toHaveLength(2);
			expect(yield* rows(`select label from lines order by label`)).toEqual([
				{ label: 'a' },
				{ label: 'b' }
			]);
		}).pipe(Effect.provide(fixture))
	);
});

const callbackRows = (invocation: Invocation) =>
	invocation.kind === 'update'
		? Schema.decodeUnknownSync(
				Schema.Array(
					Schema.Struct({
						before: Schema.Record(Schema.String, Schema.Json),
						set: Schema.Record(Schema.String, Schema.Json)
					})
				)
			)(invocation.input).map((change) => change.set)
		: Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Json)))(
				invocation.input
			);

function callbackEngine(
	body: (inv: Invocation) => GuestOutcome,
	calls: Invocation[] = []
): Partial<WriteEngine> {
	const orders = manifest.exposures['orders'];
	if (orders?.create === undefined || orders.update === undefined)
		throw new Error('The callback fixture needs create and update contracts');
	return {
		manifest: {
			...manifest,
			exposures: {
				...manifest.exposures,
				orders: {
					...orders,
					create: { ...orders.create, transform: true },
					update: { ...orders.update, transform: true }
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

describe('engine/write: per-verb callbacks (rules 19, 27)', () => {
	it.effect('a refusal is recorded, so a replay answers it without running guest code again', () =>
		Effect.gen(function* () {
			const calls: Invocation[] = [];
			const engine = callbackEngine(
				() => ({ kind: 'refused', message: 'no desks', field: 'title' }),
				calls
			);
			const first = yield* run({ verb: 'create', input: [{ title: 'desk' }], key: 'g' }, engine);
			expect(first.outcome).toEqual({
				kind: 'refused',
				code: 'refused',
				message: 'no desks',
				field: 'title',
				rule: 'orders.create'
			});
			const replay = yield* run(
				{ verb: 'create', input: [{ title: 'desk' }], key: 'g', retry: true },
				engine
			);
			expect(replay.outcome).toEqual(first.outcome);
			expect(calls).toHaveLength(1);
		}).pipe(Effect.provide(fixture))
	);
});

describe('engine/write: locks and queued pieces (rules 26, 49)', () => {
	it.effect(
		'a callback that read takes one sorted SHARE ROW EXCLUSIVE lock over write and read tables',
		() =>
			Effect.gen(function* () {
				const locks: (Lock | undefined)[] = [];
				const inner = db;
				db = TenantDbService.typed({
					read: inner.read,
					write: (statement, lock) => (locks.push(lock), inner.write(statement, lock)),
					transaction: (batch) => (locks.push(batch.lock), inner.transaction(batch)),
					session: inner.session
				});
				const engine = {
					...callbackEngine((inv) => ({ kind: 'ok', output: callbackRows(inv) })),
					bridge: () => ({ cross: () => Effect.succeed([]), tables: () => ['tags'] })
				};
				committed((yield* run({ verb: 'create', input: [{ title: 'a' }] }, engine)).outcome);
				expect(locks).toEqual([{ tables: ['orders', 'tags'], mode: 'SHARE ROW EXCLUSIVE' }]);
			}).pipe(Effect.provide(fixture))
	);

	it.effect('queued runs and notices are pieces of the statement, behind the gate', () =>
		Effect.gen(function* () {
			const x: Commit = {
				key: 'q',
				digest: 'd',
				issuedAt: NOW,
				now: NOW,
				today: TODAY,
				actor: admin.actor,
				writer: { starter: null, actor: 'test', depth: 0 },
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
				notices: [
					{
						id: 'n1',
						to: [{ user: 'u' }],
						via: ['mail'],
						title: 'Hi',
						body: null,
						link: null,
						once: 'notice-once',
						attachments: []
					}
				]
			};
			yield* executeCommit(db, manifest, catalogOf(manifest), x);
			yield* executeCommit(db, manifest, catalogOf(manifest), {
				...x,
				runs: [{ ...x.runs[0]!, id: 'r2' }]
			});
			// the mail notice queues its own delivery run, once, like the rest
			expect(
				yield* one(`select (select count(*)::int from sys_run where automation = 'remind') r, (select count(*)::int from sys_run where automation = 'notifications.deliver') d,
			(select count(*)::int from sys_notification) n`)
			).toEqual({ r: 1, d: 1, n: 1 });
		}).pipe(Effect.provide(fixture))
	);
});

describe('engine/write: approval hook points (rules 44–46, P3)', () => {
	it.effect(
		'a create its check approves commits provisionally under the request the hook opens',
		() =>
			Effect.gen(function* () {
				const requestId = '0199a000-0000-7000-8000-0000000000aa';
				const snapshot: Extract<ApprovalSnapshot, { kind: 'steps' }> = {
					kind: 'steps',
					steps: [{ name: 'Finance', teams: ['finance'], users: [] }],
					superseded_by: []
				};
				const routed = authority({
					orders: grants('orders', {
						create: [writeArm(manifest.exposures['orders']?.create?.columns ?? {}, true)]
					})
				});
				const routes: Parameters<ApprovalHook['route']>[0][] = [];
				const approval: ApprovalHook = {
					route: (request) =>
						Effect.sync(() => {
							routes.push(request);
							return { requestId, route: request.snapshot, pieces: () => {} };
						}),
					resubmit: () => Effect.die('This create does not resubmit an approval request')
				};
				const calls: Invocation[] = [];
				const engine: Partial<WriteEngine> = {
					guest: {
						invokeProgram: () => Effect.die('The approval hook test does not execute programs'),
						invoke: (invocation) =>
							Effect.sync(() => {
								calls.push(invocation);
								return { kind: 'ok', output: { kind: 'approve', flow: snapshot } };
							})
					},
					approval
				};
				const o = (yield* run(
					{ verb: 'create', input: [{ title: 'held' }], authority: routed },
					engine
				)).outcome;
				expect(o).toMatchObject({ kind: 'pendingApproval', requestId });
				const [created] = yield* rows(`select id::text from orders`);
				expect(calls.map(({ kind, target }) => [kind, target])).toEqual([
					['policy', 'p.orders.create']
				]);
				expect(routes).toHaveLength(1);
				expect(routes[0]).toMatchObject({
					model: 'orders',
					record: created?.['id'],
					action: 'create',
					snapshot,
					records: [{ id: created?.['id'], action: 'create', values: { title: 'held' } }]
				});
				expect(o).toMatchObject({
					records: [{ model: 'orders', id: created?.['id'], revision: 1 }]
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
				// each model is read once, as it is restored, in relationship order (a pack is never in memory whole)
				const reads: string[] = [];
				const streamed = restoreSource(pack);
				const batches = native.batches;
				expect(
					yield* seed(
						manifest,
						db,
						{
							models: ['lines', 'orders'],
							rows: (c, from) =>
								outsideBatch(
									Stream.unwrap(Effect.sync(() => (reads.push(c), streamed.rows(c, from))))
								)
						},
						NOW
					)
				).toEqual({ inserted: 2 });
				expect(reads).toEqual(['orders', 'lines']);
				expect(native.batches).toBeGreaterThan(batches);
				expect(native.active).toBe(0);
				expect(native.streams).toBe(0);
				expect(yield* seed(manifest, db, restoreSource(pack), NOW)).toEqual({ inserted: 0 });
				expect(yield* one(`select status, total::text from orders`)).toEqual({
					status: 'submitted',
					total: '5'
				});
				expect(
					(yield* Effect.flip(
						seed(
							manifest,
							db,
							restoreSource({
								orders: [
									{
										...pack.orders[0]!,
										id: '0199a000-0000-4000-8000-000000000003',
										title: 'x',
										number: 'PO-2026-0001',
										total: '9'
									}
								]
							}),
							NOW
						)
					)).message
				).toMatch(/SeedDrift|total/);
				committed((yield* run({ verb: 'create', input: [{ title: 'next' }] })).outcome);
				expect(yield* one(`select number from orders where title = 'next'`)).toEqual({
					number: 'PO-2026-0043'
				});
			}).pipe(Effect.provide(fixture))
	);
	it.effect(
		'restores in bounded 1 MiB steps, admitting an oversized row alone, then derives roll-ups and counters',
		() =>
			Effect.gen(function* () {
				const o = '0199a000-0000-4000-8000-000000000011';
				// Each row just over the 1 MiB byte target owns its own chunk.
				const label = 'x'.repeat(1024 * 1024 + 1);
				const pack = {
					orders: [
						{ id: o, title: 'stepped', number: 'PO-2026-0007', status: 'submitted', total: '2.00' }
					],
					lines: [1, 2].map((i) => ({
						id: `0199a000-0000-4000-8000-00000000002${i}`,
						label,
						amount: '1',
						order: o
					}))
				};
				const reads: (readonly [string, number])[] = [];
				const streamed = restoreSource(pack);
				const restore = yield* restorer(
					manifest,
					db,
					{
						models: ['lines', 'orders'],
						rows: (c, from) =>
							outsideBatch(
								Stream.unwrap(Effect.sync(() => (reads.push([c, from]), streamed.rows(c, from))))
							)
					},
					NOW
				);
				const steps: boolean[] = [];
				let more = true;
				while (more) {
					more = yield* restore.step;
					steps.push(more);
					expect(native.active).toBe(0);
					expect(native.streams).toBe(0);
				}
				expect(steps).toEqual([true, true, true, false]);
				expect(reads).toEqual([
					['orders', 0],
					['lines', 0],
					['lines', 1]
				]);
				expect(restore.inserted()).toBe(3);
				expect(yield* restore.step).toBe(false);
				// The given total spans both chunks.
				expect(yield* one(`select total::text from orders`)).toEqual({ total: '2' });
			}).pipe(Effect.provide(fixture))
	);
});

describe('engine/write: references read scopes; mutations answer to their own check (rules 35, 36)', () => {
	it.effect(
		'loads only read scopes for a reference, while real mutations still answer to their check',
		() =>
			Effect.gen(function* () {
				const parent = yield* order('draft-parent', [{ label: 'a', amount: '1' }]);
				const line = String(
					(yield* one(`select id::text from lines where "order" = '${parent}'`))['id']
				);
				// the lines check stands in for a read of the parent's status, once it is no longer a draft
				const lines = checking(() => ({
					kind: 'deny',
					message: 'The order is no longer a draft.'
				}));
				const caller = authority({
					lines: grants('lines', {
						create: [writeArm({ lines: ['label', 'amount', 'order'] }, true)],
						delete: [{ policy: 'p', check: true }]
					}),
					notes: grants('notes', { create: [writeArm({ notes: ['body', 'line'] })] })
				});
				const reference = (body: string) =>
					run(
						{
							model: 'notes',
							verb: 'create',
							input: [{ body, line }],
							authority: caller
						},
						{ manifest: ext }
					);
				count.reads = 0;
				expect((yield* reference('draft reference')).outcome.kind).toBe('committed');
				expect(count.reads).toBe(1);
				committed(
					(yield* run({
						verb: 'update',
						input: [{ target: parent, set: { status: 'submitted' } }]
					})).outcome
				);
				count.reads = 0;
				expect((yield* reference('locked reference')).outcome.kind).toBe('committed');
				expect(count.reads).toBe(1);
				const result = yield* run(
					{ model: 'lines', verb: 'delete', input: [{ target: line }], authority: caller },
					{ manifest: ext, ...lines }
				);
				expect(result.outcome).toMatchObject({
					kind: 'refused',
					code: 'refused',
					rule: 'p.lines.delete'
				});
				expect(result.captured).toEqual([]);
				expect(yield* rows('SELECT body FROM notes ORDER BY body')).toEqual([
					{ body: 'draft reference' },
					{ body: 'locked reference' }
				]);
				expect(yield* rows('SELECT amount::text FROM lines')).toEqual([{ amount: '1' }]);
			}).pipe(Effect.provide(fixture))
	);
});

describe('engine/write: field kinds the template migration found (arcs, json shapes, checks, sys_user refs)', () => {
	if (member.kind !== 'member') throw new Error('The write fixture actor is a member');
	const owner = member;
	const extended = Effect.gen(function* () {
		yield* Effect.tryPromise({
			try: () =>
				pg.query(`INSERT INTO sys_user (id, email, name) VALUES ($1, $2, 'Ana')`, [
					owner.id,
					owner.email
				]),
			catch: dbError
		});
	});
	const write = (model: string, verb: 'create' | 'update', input: readonly Json[]) =>
		run({ model, verb, input }, { manifest: ext }).pipe(Effect.map((r) => r.outcome));
	const created = (o: Outcome) => {
		const id = committed(o).records[0]?.id;
		if (id === undefined) throw new Error('create returned no record');
		return id;
	};

	it.effect(
		'a batch create answers in input order; an exclusive arc takes either target only; json shapes and model checks refuse; a sys_user ref defaults to the actor',
		() =>
			Effect.gen(function* () {
				yield* extended;
				const titles = ['B', 'C', 'A'];
				const out = committed(
					yield* write(
						'quotes',
						'create',
						titles.map((title) => ({ title }))
					)
				);
				const byId = new Map(
					(yield* rows(`select id::text, title from quotes`)).map((r) => [r['id'], r['title']])
				);
				expect(out.records.map((r) => byId.get(r.id))).toEqual(titles);
				const q = out.records[0]!.id;
				const p = created(
					yield* write('projects', 'create', [{ title: 'p', profile: { grade: 'a', weight: 2 } }])
				);
				expect(yield* one(`select owner::text from projects where id = '${p}'`)).toEqual({
					owner: owner.id
				});
				const a = created(
					yield* write('activities', 'create', [
						{ subject: 's', regarding: { model: 'quotes', id: q } }
					])
				);
				committed(
					yield* write('activities', 'update', [
						{ target: a, set: { regarding: { model: 'projects', id: p } } }
					])
				);
				expect(
					yield* write('activities', 'create', [
						{ subject: 's', regarding: { model: 'cases', id: q } }
					])
				).toMatchObject({ kind: 'refused', code: 'invalidInput', field: 'regarding' });
				expect(
					yield* write('activities', 'create', [
						{ subject: 's', regarding: { model: 'projects', id: q } }
					])
				).toMatchObject({ kind: 'refused', code: 'notFound', field: 'regarding' });
				expect(
					yield* write('projects', 'create', [{ title: 'p2', profile: { grade: 'a', extra: 1 } }])
				).toMatchObject({ kind: 'refused', code: 'invalidInput', field: 'profile' });
				expect(yield* write('projects', 'create', [{ title: 'p3', stock: -1 }])).toMatchObject({
					kind: 'refused',
					code: 'check',
					message: 'Stock cannot go below zero.'
				});
				expect(yield* write('projects', 'create', [{ title: 'p4', stock: 1001 }])).toMatchObject({
					kind: 'refused',
					code: 'check',
					message: "the record breaks the rule 'bare'"
				});
			}).pipe(Effect.provide(fixture))
	);
});

it.live(
	'callback-read-race (rule 26): the loser replays once, re-reads the moved quota, and refuses',
	() =>
		Effect.gen(function* () {
			const { db } = yield* open(ext);
			const orders = manifest.exposures['orders'];
			if (orders?.create === undefined)
				throw new Error('The race fixture has no orders create contract');
			const callbacks: EngineManifest = {
				...manifest,
				exposures: {
					...manifest.exposures,
					orders: { ...orders, create: { ...orders.create, transform: true } }
				}
			};
			// orders are capped at two: the create callback counts them and refuses the third
			let invoked = 0,
				arrived = 0;
			const both = yield* Deferred.make<void>();
			const guest: GuestShape = {
				invokeProgram: () =>
					Effect.die(new Error('This fixture does not execute supplied guest programs.')),
				invoke: (inv, bridge) =>
					Effect.gen(function* () {
						const racing = ++invoked === 2 || invoked === 3;
						const [a] = yield* bridge.cross([
							{
								_tag: 'read',
								read: yield* aggregate(catalogOf(callbacks), 'orders', { count: true }).pipe(
									Effect.mapError(fromStore)
								)
							}
						]);
						if (a?.ok !== true)
							return yield* Effect.fail(
								BoltError.make('badAnswer', 'guest', 'The quota read failed.')
							);
						const { count: n } = yield* Schema.decodeUnknownEffect(
							Schema.Struct({ count: Schema.Number })
						)(a.value).pipe(
							Effect.mapError((error) => BoltError.make('badAnswer', 'guest', error.message, error))
						);
						if (racing) {
							if (++arrived === 2) yield* Deferred.succeed(both, undefined);
							yield* Deferred.await(both);
						}
						const outcome: GuestOutcome =
							n >= 2 ? { kind: 'refused', message: 'quota' } : { kind: 'ok', output: inv.input };
						return outcome;
					}).pipe(Effect.orDie)
			};
			const e = { manifest: callbacks, db, guest, bridge: bridgeOn(db, callbacks) };
			const create = (title: string) =>
				act(e, {
					model: 'orders',
					verb: 'create',
					mode: { _tag: 'Direct' },
					input: [{ title }],
					key: title,
					issuedAt: NOW,
					authority: admin,
					bindings: { now: NOW, today: TODAY, tz: 'UTC' },
					invocationId: `inv-${title}`
				});
			yield* create('first');
			const [a, b] = yield* Effect.all([create('a'), create('b')], { concurrency: 'unbounded' });
			expect(
				[a.outcome, b.outcome]
					.map((o) => (o.kind === 'refused' ? `refused:${o.message}` : o.kind))
					.sort()
			).toEqual(['committed', 'refused:quota']);
			expect(
				yield* db.value(Schema.Number, {
					text: 'select count(*)::int as n from orders',
					params: []
				})
			).toBe(2);
			expect(invoked).toBe(4); // 'first', a, b, and b's one replay
		})
);
