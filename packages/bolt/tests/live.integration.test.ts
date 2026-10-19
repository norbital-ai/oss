// The browser path end to end on PGlite: $bolt → fetch → the /__bolt handler → engine → live hub → SSE → $bolt.
// One guarantee per test (rules 25, 32, 64–67).
import { randomUUID } from 'node:crypto';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { describe, expect, it } from '@effect/vitest';
import {
	Config,
	Context,
	Deferred,
	Effect,
	FiberSet,
	Layer,
	Option,
	Predicate,
	Queue,
	Schema,
	Stream
} from 'effect';
import { DbError } from '../src/engine/errors.ts';
import { TestWorkspace, type TestOptions } from '../src/test/index.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { EngineLive } from '../src/engine/host.ts';
import { Agents, Live, Reads, Writes, type LiveView } from '../src/engine/services.ts';
import { routeFixture } from './support/route-fixture.ts';
import { sse } from './support/live-bolt.ts';
import { program } from './support/guest-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import { createBolt, patched } from '../src/page/bolt.ts';
import type { Authority, Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { PgliteDb } from '../src/engine/db/pglite.ts';
import { PostgresDb } from '../src/engine/db/postgres.ts';
import { lowerRead } from '../src/engine/query/engine.ts';
import type { Frame } from '../src/protocol/wire.ts';
import type { ReadIR } from '../src/protocol/ir-types.ts';
import { Chain, noticeCaptures, noticeInsert } from '../src/engine/write/sql.ts';
import { ACME, guest, manifest as base, seed, SHADY } from './engine-fixture.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const NOW = '2026-09-25T10:00:00.000Z';
const manifest = { ...base, teams: { finance: { name: 'Finance', policies: [] } } };
const bindings = () => ({ now: NOW, today: NOW.slice(0, 10), tz: 'UTC', params: {} });
const Row = Schema.Record(Schema.String, Schema.Json);
const Rows = Schema.Struct({ rows: Schema.Array(Row) });
const BrowserPage = Schema.Struct({
	rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	next: Schema.NullOr(Schema.String)
});
const Captures = Schema.Array(
	Schema.Struct({
		collection: Schema.String,
		id: Schema.String,
		op: Schema.Literals(['create', 'update', 'delete']),
		revision: Schema.Number,
		old: Schema.NullOr(Row),
		new: Schema.NullOr(Row),
		cause: Schema.Literals(['direct', 'cascade', 'derived', 'erased'])
	})
);

const compiledGuest = program(guest.source);
const cell = (
	dbLayer: NonNullable<TestOptions['db']> = PgliteDb.layer(),
	m: EngineManifest = manifest
) =>
	Effect.gen(function* () {
		let reads = 0;
		const db = Layer.effect(
			TenantDb,
			Effect.gen(function* () {
				const inner = yield* TenantDb;
				return TenantDb.typed({
					...inner,
					read: (statements) =>
						Effect.suspend(() => {
							reads += statements.length;
							return inner.read(statements);
						})
				});
			})
		).pipe(Layer.provide(dbLayer));
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest: m,
				guest: yield* compiledGuest,
				transforms: ['orders'],
				seed,
				now: NOW,
				db
			})
		);
		const t = Context.get(context, TestWorkspace),
			live = Context.get(context, Live),
			writes = Context.get(context, Writes),
			queries = Context.get(context, Reads),
			agents = Context.get(context, Agents),
			route = yield* routeFixture(context);
		const rep = t.as(t.member(['rep'])).authority;
		const run = yield* FiberSet.makeRuntimePromise().pipe(Effect.provide(context));
		const fetch: typeof globalThis.fetch = (input, init) => {
			const request = new Request(
				new URL(
					typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
					'http://cell'
				),
				input instanceof Request ? input : init
			);
			return run(route.handle(rep, request), { signal: request.signal });
		};
		const openStream = yield* sse((url) =>
			route.handle(rep, new Request(new URL(url, 'http://cell')))
		).pipe(Effect.provide(context));
		const client = yield* createBolt({
			actor: null,
			locale: 'en',
			base: 'http://cell',
			fetch,
			openStream
		}).pipe(Effect.provide(context));
		const bolt = {
			...client,
			act: (...args: Parameters<typeof client.act>) =>
				client.act(...args).pipe(Effect.provide(context))
		};
		const orders = () =>
			Effect.gen(function* () {
				const seen: (readonly Readonly<Record<string, unknown>>[])[] = [],
					answered = yield* Queue.unbounded<typeof BrowserPage.Type>();
				let current: typeof BrowserPage.Type | undefined;
				yield* bolt.live<unknown>(bolt.read('orders', { all: true })).pipe(
					Stream.runForEach((page) =>
						Effect.gen(function* () {
							if (!Schema.is(BrowserPage)(page)) throw new Error('Invalid live order page');
							current = page;
							seen.push(page.rows);
							yield* Queue.offer(answered, page);
						})
					),
					Effect.forkScoped
				);
				yield* Queue.take(answered);
				return {
					seen,
					rows: () => {
						if (current === undefined) throw new Error('Missing live order page');
						return current.rows;
					}
				};
			});
		const flushes: (() => Effect.Effect<void>)[] = [];
		const watcher = (authority: Authority) =>
			Effect.gen(function* () {
				const held = new Map<string, Json | undefined>(),
					frames: Frame[] = [],
					received = yield* Queue.unbounded<Frame>(),
					hello = yield* Deferred.make<string>();
				yield* live.connect(authority).pipe(
					Stream.runForEach((frame) =>
						Effect.gen(function* () {
							frames.push(frame);
							if (frame.t === 'answer') held.set(frame.view, frame.value);
							if (frame.t === 'patch')
								held.set(frame.view, patched(held.get(frame.view), frame.ops));
							yield* Queue.offer(received, frame);
							if (frame.t === 'hello') yield* Deferred.succeed(hello, frame.conn);
						})
					),
					Effect.forkScoped
				);
				const conn = yield* Deferred.await(hello);
				const flush = () =>
					Effect.gen(function* () {
						const v = yield* live.v;
						while (!frames.some((frame) => 'v' in frame && frame.v >= v))
							yield* Queue.take(received);
					});
				flushes.push(flush);
				return { conn, held, frames, received };
			});
		const register = (
			watch: Effect.Success<ReturnType<typeof watcher>>,
			view: string,
			read: LiveView
		) =>
			Effect.gen(function* () {
				yield* live.register(watch.conn, view, read);
				while (!watch.frames.some((frame) => frame.t === 'answer' && frame.view === view))
					yield* Queue.take(watch.received);
			});
		const settled = Effect.gen(function* () {
			yield* live.settled;
			for (const flush of flushes) yield* flush();
		});
		const write = (authority: Authority, verb: 'create' | 'update' | 'delete', input: Json) =>
			Effect.gen(function* () {
				const result = yield* writes.act({
					collection: 'orders',
					verb,
					input,
					mode: { _tag: 'Direct' },
					key: randomUUID(),
					issuedAt: NOW,
					authority,
					bindings: bindings(),
					invocationId: randomUUID()
				});
				expect(result.outcome.kind).toBe('committed');
				yield* settled;
				if (result.outcome.kind !== 'committed') throw new Error(JSON.stringify(result.outcome));
				return result.outcome.records.map((record) => record.id);
			});
		const other = () =>
			Layer.build(
				EngineLive(m).pipe(
					Layer.provide(Layer.mergeAll(NodeCrypto.layer, Layer.succeedContext(context)))
				)
			).pipe(Effect.map((context) => Context.get(context, Writes)));
		return {
			t,
			context,
			bolt,
			rep,
			live,
			writes,
			queries,
			agents,
			count: {
				get reads() {
					return reads;
				},
				reset: () => {
					reads = 0;
				}
			},
			orders,
			watcher,
			register,
			settled,
			write,
			other
		};
	});
const kind = (o: Pick<Outcome, 'kind'>) => o.kind;

describe('live + protocol + $bolt on PGlite', () => {
	it.live('an act resolves only once its committed row is on the live read (rule 66)', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { bolt, orders } = yield* cell();
				const view = yield* orders();
				expect(
					kind(yield* bolt.act('orders.create', { title: 'desk', region: 'north', customer: ACME }))
				).toBe('committed');
				expect(view.rows().map((r) => r['title'])).toEqual(['desk']);
				expect(present(view.rows()[0])['id']).not.toMatch(/^pending:/);
			})
		)
	);

	it.live(
		'a refused optimistic write painted while in flight and leaves no painted row (rule 67)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { bolt, orders } = yield* cell();
					const view = yield* orders();
					const o = yield* bolt
						.act('orders.create', { title: 'shady', region: 'north', customer: SHADY })
						.pipe(Effect.flip);
					expect(o).toMatchObject({
						_tag: 'ActRefused',
						message: 'Shady is blocked',
						field: 'customer'
					});
					expect(view.seen.some((rows) => rows.some((r) => r['title'] === 'shady'))).toBe(true);
					expect(view.rows()).toEqual([]);
				})
			)
	);

	it.live('a 202 puts the held row on the live read at once, carrying its `$approval`', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { create, ...grant } = manifest.policies.rep.grants.orders;
				void create;
				const proposed = {
					...manifest,
					policies: {
						...manifest.policies,
						rep: {
							...manifest.policies.rep,
							grants: {
								...manifest.policies.rep.grants,
								orders: { ...grant, approval: { create: [{ steps: [['finance']] }] } }
							}
						}
					}
				};
				const { t, bolt, orders } = yield* cell(PgliteDb.layer(), proposed);
				const view = yield* orders();
				expect(
					yield* bolt.act('orders.create', { title: 'held', region: 'north', customer: ACME })
				).toMatchObject({ kind: 'pendingApproval', records: [{ collection: 'orders' }] });
				expect(view.rows()).toMatchObject([
					{ title: 'held', $approval: { state: 'Pending', step: 0, steps: 1 } }
				]);
				expect(
					(yield* t.db.read([
						{ text: "SELECT title FROM orders WHERE title = 'held'", params: [] }
					]))[0]?.rows
				).toEqual([{ title: 'held' }]);
			})
		)
	);

	it.live(
		'an update carries the revision the page read; a row that moved since is conflict and the paint lifts (rule 25)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { bolt, rep, orders, other } = yield* cell();
					const view = yield* orders();
					yield* bolt.act('orders.create', { title: 'desk', region: 'north', customer: ACME });
					const id = String(present(view.rows()[0])['id']);
					// another cell's writer moves the row: this cell's live lane never sees it
					const moved = yield* (yield* other()).act({
						collection: 'orders',
						verb: 'update',
						mode: { _tag: 'Direct' },
						input: { target: id, set: { title: 'moved' } },
						key: randomUUID(),
						issuedAt: NOW,
						authority: rep,
						bindings: bindings(),
						invocationId: randomUUID()
					});
					expect(kind(moved.outcome)).toBe('committed');
					expect(
						yield* bolt
							.act('orders.update', { target: id, set: { title: 'mine' } })
							.pipe(Effect.flip)
					).toMatchObject({ _tag: 'ActConflict' });
					expect(present(view.rows()[0])['title']).toBe('desk');
				})
			)
	);

	it.live('await q reads once through /q', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { bolt } = yield* cell();
				yield* bolt.act('orders.create', { title: 'desk', region: 'north', customer: ACME });
				const page = yield* bolt.read<typeof BrowserPage.Type>('orders', { all: true });
				expect(yield* bolt.get('orders', String(present(page.rows[0])['id']))).toMatchObject({
					title: 'desk'
				});
				expect(yield* bolt.read('nope', { all: true }).pipe(Effect.flip)).toMatchObject({
					code: expect.any(String)
				});
			})
		)
	);
});

describe('live deltas on PGlite (rule 65)', () => {
	const b = () => bindings();

	it.live('a commit that hits a simple view is patched with 0 view reads', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { rep, live, queries, count, watcher, register, settled, other } = yield* cell();
				const w = yield* watcher(rep);
				yield* register(w, 'simple', {
					read: lowerRead(manifest, 'read', [
						'orders',
						{ select: { title: true, status: true }, all: true }
					])
				});
				// another cell's writer commits; its RETURNING set is then routed through this hub alone
				const another = yield* other();
				const r = yield* another.act({
					collection: 'orders',
					verb: 'create',
					mode: { _tag: 'Direct' },
					input: { title: 'desk', region: 'north', customer: ACME },
					key: randomUUID(),
					issuedAt: NOW,
					authority: rep,
					bindings: b(),
					invocationId: randomUUID()
				});
				count.reset();
				live.publish(r.captured);
				yield* settled;
				expect(count.reads).toBe(0);
				expect(w.frames.at(-2)).toMatchObject({ t: 'patch', view: 'simple' });
				expect(w.held.get('simple')).toEqual(
					(yield* queries.run(
						[
							lowerRead(manifest, 'read', [
								'orders',
								{ select: { title: true, status: true }, all: true }
							])
						],
						{ as: 'caller', authority: rep },
						b()
					))[0]
				);
			})
		)
	);

	it.live(
		'the inbox refreshes its complete unread count and marks only committed arrivals (L-BOLT-354)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, bolt, rep, live, queries, count, watcher, register, settled } = yield* cell();
					if (rep.actor.kind !== 'member') throw new Error('Expected a member');
					const me = rep.actor.id;
					yield* t.db.write({
						text: `INSERT INTO sys_user (id, email, name) VALUES ($1, 'rep@acme.test', 'rep') ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, name=EXCLUDED.name`,
						params: [me]
					});
					const w = yield* watcher(rep);
					const inbox: ReadIR = { kind: 'inbox', collection: 'sys_notification', member: me };
					yield* register(w, 'inbox', { read: inbox });
					const fresh = () =>
						queries
							.run([inbox], { as: 'caller', authority: rep }, b())
							.pipe(Effect.map(([answer]) => answer));
					expect(w.held.get('inbox')).toEqual({ rows: [], unread: 0 });
					// the one writer (L-BOLT-356) hands its inserted rows to the lane, as every writer's statement does
					const c = new Chain();
					noticeInsert(
						c,
						'n',
						[
							{ id: 'n1', to: { user: me }, title: 'To you' },
							{ id: 'n2', to: { team: 'nobody' }, title: 'Nobody' }
						],
						NOW,
						'true',
						manifest.teams
					);
					count.reset();
					live.publish(
						yield* Schema.decodeUnknownEffect(Captures)(
							(yield* t.db.write(c.sql(`${noticeCaptures(c)} AS notices`))).rows[0]?.['notices']
						)
					);
					yield* settled;
					expect(count.reads).toBe(2);
					expect(w.frames.at(-2)).toMatchObject({
						t: 'answer',
						view: 'inbox',
						arrivals: [{ id: `n1:${me}` }]
					});
					expect(Schema.decodeUnknownSync(Rows)(w.held.get('inbox')).rows).toMatchObject([
						{ id: `n1:${me}`, title: 'To you', read: false }
					]);
					expect(w.held.get('inbox')).toEqual(yield* fresh());
					expect(w.held.get('inbox')).toMatchObject({ unread: 1 });
					// markRead publishes the member's changed rows: `read` flips without a reload
					expect(kind(yield* bolt.act('sys_notification.markRead', { ids: [`n1:${me}`] }))).toBe(
						'committed'
					);
					yield* settled;
					expect(Schema.decodeUnknownSync(Rows)(w.held.get('inbox')).rows).toMatchObject([
						{ id: `n1:${me}`, read: true }
					]);
					expect(w.held.get('inbox')).toEqual(yield* fresh());
					expect(w.held.get('inbox')).toMatchObject({ unread: 0 });
					expect(w.frames.at(-2)).not.toHaveProperty('arrivals');
				})
			)
	);

	it.live(
		'unread count includes notices beyond the inbox page and mark all read covers them without touching another member',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, bolt, rep, watcher, register, settled } = yield* cell();
					if (rep.actor.kind !== 'member') throw new Error('Expected a member');
					const me = rep.actor.id;
					yield* t.db.write({
						text: `INSERT INTO sys_notification (id, member, recipient, title, at)
			SELECT 'bulk-' || n, $1, '{}'::jsonb, 'Historical', $2::timestamptz FROM generate_series(1, 250) n`,
						params: [me, NOW]
					});
					yield* t.db.write({
						text: `INSERT INTO sys_notification (id, member, recipient, title, at) VALUES ('other-notice', 'someone-else', '{}', 'Private', $1)`,
						params: [NOW]
					});
					const w = yield* watcher(rep),
						inbox: ReadIR = { kind: 'inbox', collection: 'sys_notification', member: me };
					yield* register(w, 'inbox', { read: inbox });
					expect(w.held.get('inbox')).toMatchObject({ unread: 250 });
					expect(Schema.decodeUnknownSync(Rows)(w.held.get('inbox')).rows.length).toBe(200);
					expect(w.frames.at(-1)).not.toHaveProperty('arrivals');
					expect(kind(yield* bolt.act('sys_notification.markRead', { all: true }))).toBe(
						'committed'
					);
					yield* settled;
					expect(w.held.get('inbox')).toMatchObject({ unread: 0 });
					const [other] = yield* t.db.read([
						{ text: "SELECT read_at FROM sys_notification WHERE id = 'other-notice'", params: [] }
					]);
					expect(other?.rows[0]?.['read_at']).toBeNull();
				})
			)
	);

	it.live(
		'a decimal and a roll-up sum keep their scale in the patch, with 0 reads (numerics cross the RETURNING image as text)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { rep, live, queries, count, watcher, register, settled, other } = yield* cell();
					const w = yield* watcher(rep);
					const totals = lowerRead(manifest, 'read', [
						'orders',
						{ select: { title: true, total: true }, all: true }
					]);
					yield* register(w, 'totals', { read: totals });
					const another = yield* other();
					const r = yield* another.act({
						collection: 'orders',
						verb: 'create',
						mode: { _tag: 'Direct' },
						input: {
							title: 'desk',
							region: 'north',
							customer: ACME,
							lines: {
								create: [
									{ label: 'a', amount: '1.20' },
									{ label: 'b', amount: '2.00' }
								]
							}
						},
						key: randomUUID(),
						issuedAt: NOW,
						authority: rep,
						bindings: b(),
						invocationId: randomUUID()
					});
					expect(r.captured.find((x) => x.collection === 'lines')?.new?.['amount']).toBe('1.20');
					count.reset();
					live.publish(r.captured);
					yield* settled;
					expect(count.reads).toBe(0);
					expect(
						Schema.decodeUnknownSync(Rows)(w.held.get('totals')).rows.map((x) => x['total'])
					).toEqual([{ $dec: '3.20' }]);
					expect(w.held.get('totals')).toEqual(
						(yield* queries.run([totals], { as: 'caller', authority: rep }, b()))[0]
					);
				})
			)
	);

	/** Every view shape stays equal to a fresh read through creates, moves, masks, filters and deletes. */
	const shapes = (fixture: Effect.Success<ReturnType<typeof cell>>) =>
		Effect.gen(function* () {
			const { t, rep, live, writes, queries, watcher, register, settled, write } = fixture;
			const both = t.as({ actor: rep.actor, policies: ['rep', 'auditor'], admin: false }).authority;
			const w = yield* watcher(both);
			const shapes: { [view: string]: readonly Json[] } = {
				newest: [
					'orders',
					{
						select: { title: true, note: true, status: true, created_at: true },
						orderBy: { created_at: 'desc' },
						all: true
					}
				],
				drafts: [
					'orders',
					{ where: { status: { eq: 'draft' } }, select: { title: true, note: true }, limit: 2 }
				],
				whole: ['orders', { all: true }],
				related: [
					'orders',
					{ select: { title: true, customer: { select: { name: true } } }, all: true }
				],
				byTitle: ['orders', { select: { title: true }, orderBy: { title: 'asc' }, limit: 10 }]
			};
			const irs: { [view: string]: ReadIR } = Object.fromEntries(
				Object.entries(shapes).map(([k, a]) => [k, lowerRead(manifest, 'read', a)])
			);
			for (const [view, read] of Object.entries(irs)) yield* register(w, view, { read });
			const check = () =>
				Effect.gen(function* () {
					for (const [view, read] of Object.entries(irs))
						expect([view, w.held.get(view)]).toEqual([
							view,
							(yield* queries.run([read], { as: 'caller', authority: both }, b()))[0]
						]);
				});
			const a = present(
				(yield* write(both, 'create', { title: 'desk', region: 'north', customer: ACME }))[0]
			);
			const c = present(
				(yield* write(both, 'create', {
					title: 'chair',
					region: 'north',
					note: 'mine',
					customer: ACME
				}))[0]
			);
			yield* write(both, 'create', { title: 'lamp', region: 'north', customer: ACME });
			yield* check();
			yield* write(both, 'update', { target: a, set: { title: 'bench' } });
			yield* check();
			yield* write(both, 'update', { target: c, set: { status: 'submitted' } });
			yield* check();
			yield* write(both, 'update', { target: c, set: { note: 'edited' } });
			yield* check();
			yield* write(both, 'delete', { target: a });
			yield* check();
			// then a seeded random walk: every commit, whatever it does, leaves every view equal to a fresh read
			let seed = 7;
			const pick = <T>(xs: readonly T[]): T =>
				present(xs[(seed = (seed * 48_271) % 2_147_483_647) % xs.length]);
			for (let i = 0; i < 16; i++) {
				const ids = Schema.decodeUnknownSync(
					Schema.Struct({ rows: Schema.Array(Schema.Struct({ id: Schema.String })) })
				)(
					(yield* queries.run([present(irs['whole'])], { as: 'caller', authority: both }, b()))[0]
				).rows.map((r) => r.id);
				const input: Json =
					ids.length === 0 || pick([0, 1, 2]) === 0
						? { title: pick(['oak', 'Ash', 'elm', 'fir']), region: 'north', customer: ACME }
						: pick([
								{ target: pick(ids), set: { title: pick(['yew', 'Box', 'ash']) } },
								{ target: pick(ids), set: { status: 'submitted' } },
								{ target: pick(ids), set: { note: pick(['n1', 'n2']) } },
								{ target: pick(ids) }
							]);
				const verb =
					Predicate.isObject(input) && 'set' in input
						? 'update'
						: Predicate.isObject(input) && 'target' in input
							? 'delete'
							: 'create';
				yield* writes.act({
					collection: 'orders',
					verb,
					input,
					mode: { _tag: 'Direct' },
					key: randomUUID(),
					issuedAt: NOW,
					authority: both,
					bindings: b(),
					invocationId: randomUUID()
				});
				yield* settled;
				yield* check();
			}
			const patchedViews = new Set(w.frames.flatMap((f) => (f.t === 'patch' ? [f.view] : [])));
			expect([...patchedViews].sort()).toEqual(['byTitle', 'drafts', 'newest', 'related', 'whole']);
		});
	it.live('every view shape stays equal to a fresh read (PGlite)', () =>
		Effect.scoped(
			Effect.gen(function* () {
				yield* shapes(yield* cell());
			})
		)
	);

	it.live(
		'every view shape stays equal to a fresh read (Postgres, BOLT_TEST_PG)',
		(test) =>
			Effect.scoped(
				Effect.gen(function* () {
					const configured = yield* Config.option(Config.string('BOLT_TEST_PG'));
					if (Option.isNone(configured)) return test.skip();
					const { default: pg } = yield* Effect.tryPromise({
						try: () => import('pg'),
						catch: (error) => new DbError({ message: String(error), sqlstate: '08006' })
					});
					const edge = <A>(call: () => Promise<A>) =>
						Effect.tryPromise({
							try: call,
							catch: (error) => new DbError({ message: String(error), sqlstate: '08006' })
						});
					const name = `bolt_live_${randomUUID().replaceAll('-', '')}`;
					const admin = yield* Effect.acquireRelease(
						Effect.sync(() => new pg.Pool({ connectionString: configured.value, max: 1 })),
						(pool) => edge(() => pool.end()).pipe(Effect.orDie)
					);
					yield* Effect.acquireRelease(
						edge(() => admin.query(`create database ${name}`)),
						() =>
							edge(() => admin.query(`drop database if exists ${name} with (force)`)).pipe(
								Effect.orDie
							)
					);
					const target = new URL(configured.value);
					target.pathname = `/${name}`;
					const pool = yield* Effect.acquireRelease(
						Effect.sync(
							() =>
								new pg.Pool({
									connectionString: target.toString(),
									max: 4,
									options: '-c TimeZone=UTC'
								})
						),
						(pool) => edge(() => pool.end()).pipe(Effect.orDie)
					);
					pool.on('error', () => {});
					yield* shapes(yield* cell(PostgresDb.layer(pool)));
				})
			),
		60_000
	);

	it.live('the agent transcript takes each written message as a patch, with no re-read', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { rep, agents, count, watcher, register, settled } = yield* cell();
				const id = yield* agents.start({
					owner: rep.actor.kind === 'member' ? rep.actor.id : null
				});
				const w = yield* watcher(rep);
				yield* register(w, 't', {
					read: { kind: 'transcript', collection: 'sys_message', conversation: id, thread: false }
				});
				expect(w.held.get('t')).toEqual({ status: 'idle', rows: [] });
				count.reset();
				const row = yield* agents.post({
					conversation: id,
					as: { member: 'someone' },
					text: 'hello',
					author: 'Ann'
				});
				yield* settled;
				yield* agents.stop(id); // cancels the queued input: it leaves the transcript
				yield* settled;
				expect(count.reads).toBe(0);
				expect(w.frames.flatMap((frame) => (frame.t === 'patch' ? [frame.ops] : []))).toEqual([
					[
						{
							op: 'upsert',
							index: 0,
							row: expect.objectContaining({
								id: row.id,
								role: 'user',
								text: 'hello',
								state: 'queued',
								author: 'Ann'
							})
						}
					],
					// the stop sets the conversation's status beside the rows: a patch, not a re-read
					[
						{ op: 'meta', key: 'status', value: 'stopped' },
						{ op: 'remove', id: row.id }
					]
				]);
				expect(w.held.get('t')).toEqual({ status: 'stopped', rows: [] });
			})
		)
	);

	it.live(
		'a transcript window `from` a seq holds only the messages from it on; older ones are read by page',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { rep, agents, watcher, register, settled } = yield* cell();
					const id = yield* agents.start({
						owner: rep.actor.kind === 'member' ? rep.actor.id : null
					});
					const a = yield* agents.post({
						conversation: id,
						as: { member: 'someone' },
						text: 'first',
						author: 'Ann'
					});
					const seqA = Number(
						present((yield* agents.transcript(id)).find((r) => r.id === a.id)).seq
					);
					const w = yield* watcher(rep);
					yield* register(w, 'w', {
						read: {
							kind: 'transcript',
							collection: 'sys_message',
							conversation: id,
							thread: false,
							from: seqA + 1
						}
					});
					expect(w.held.get('w')).toEqual({ status: 'idle', rows: [], from: seqA + 1 });
					const b = yield* agents.post({
						conversation: id,
						as: { member: 'someone' },
						text: 'second',
						author: 'Ann'
					});
					yield* settled;
					expect(
						Schema.decodeUnknownSync(
							Schema.Struct({ rows: Schema.Array(Schema.Struct({ id: Schema.String })) })
						)(w.held.get('w')).rows.map((r) => r.id)
					).toEqual([b.id]);
					const seqB = Number(
						present((yield* agents.transcript(id)).find((r) => r.id === b.id)).seq
					);
					expect(
						(yield* agents.transcript(id, { before: seqB, limit: 1 })).map((r) => r.id)
					).toEqual([a.id]);
					yield* agents.stop(id);
				})
			)
	);
});
