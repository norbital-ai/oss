// End to end through `/__bolt/act`, the engine entry and the test kit: a collection action writing two collections in
// one statement, idempotent under its key (rules 31, 33), its commit published to the live lane.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { PgliteDb } from '../src/engine/db/pglite.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Callables, Live } from '../src/engine/services.ts';
import { ActReply } from '../src/protocol/schema.ts';
import { KitInvalid, TestWorkspace } from '../src/test/index.ts';
import { qReply, routeFixture } from './support/route-fixture.ts';
import { program } from './support/guest-fixture.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		orders: { description: 'An order', label: 'title', fields: { title: { kind: 'text' } } },
		notes: { description: 'A note', label: 'text', fields: { text: { kind: 'text' } } }
	},
	relationships: { 'notes.order': { to: 'orders', inverse: 'notes' } },
	collections: {
		orders: {
			read: { fields: 'all' },
			create: { input: { columns: ['title'] } },
			actions: {
				place: {
					description: 'Place',
					input: { title: { kind: 'text' } },
					output: { kind: 'text' }
				}
			}
		},
		notes: { read: { fields: 'all' }, create: { input: { columns: ['text', 'order'] } } }
	},
	policies: {
		rep: {
			description: 'Rep',
			grants: {
				orders: { read: true, create: true, actions: ['place'] },
				notes: { read: true, create: true }
			}
		}
	},
	integrations: {},
	pipelines: {},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
} satisfies EngineManifest;
const guest = program(`export default { collection: { orders: { bodies: { actions: {
	place: function* (input, ctx) {
		const id = (yield* ctx.act('orders.create', { title: input.title })).records[0].id;
		yield* ctx.act('notes.create', { text: 'placed ' + input.title, order: id });
		return id;
	},
} } } } };`);
const json = (response: Response) =>
	Effect.tryPromise({
		try: () => response.json(),
		catch: (error) => new KitInvalid({ message: String(error) })
	});
const count = (db: TenantDb['Service'], collection: string) =>
	db.value(Schema.Number, { text: `SELECT count(*)::int AS n FROM ${collection}`, params: [] });

describe('a collection action over /__bolt/act', () => {
	it.live(
		'writes two collections in one statement; the same key replays the outcome and writes nothing',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(
						TestWorkspace.layer({ manifest, guest: yield* guest })
					);
					const t = Context.get(context, TestWorkspace),
						live = Context.get(context, Live);
					const rep = t.as(t.member(['rep'])).authority,
						route = yield* routeFixture(context);
					const post = () =>
						route.handle(
							rep,
							new Request('http://cell/__bolt/act', {
								method: 'POST',
								headers: { 'Idempotency-Key': 'k1' },
								body: JSON.stringify({
									callable: 'orders.place',
									input: { title: 'desk' },
									issuedAt: t.clock.now()
								})
							})
						);
					t.count.reset();
					const first = yield* post();
					expect(first.status).toBe(200);
					const reply = yield* Schema.decodeUnknownEffect(ActReply)(yield* json(first));
					expect(reply.outcome).toMatchObject({ kind: 'committed' });
					expect(reply.v).toBeGreaterThan(0);
					expect(reply.v).toBe(yield* live.v);
					expect(t.count.writes).toBe(1);
					expect(yield* json(yield* post())).toMatchObject({ outcome: reply.outcome });
					expect([yield* count(t.db, 'orders'), yield* count(t.db, 'notes')]).toEqual([1, 1]);
				})
			)
	);
});

describe('a keyed read (`ctx.read({ … })`)', () => {
	const keyed = {
		...manifest,
		models: {
			...manifest.models,
			orders: {
				description: 'An order',
				label: 'title',
				fields: { title: { kind: 'text' }, status: { kind: 'text' } }
			}
		},
		collections: {
			...manifest.collections,
			orders: {
				...manifest.collections.orders,
				queries: { board: { description: 'Board', input: {}, output: { kind: 'json' } } }
			}
		},
		policies: {
			rep: {
				description: 'Rep',
				grants: {
					orders: { read: { where: { status: { eq: 'open' } } }, create: true, queries: ['board'] },
					notes: { read: true, create: true }
				}
			}
		}
	} satisfies EngineManifest;
	const board = program(`export default { collection: { orders: { bodies: { queries: {
		board: function* (_, ctx) {
			const { orders, notes, first } = yield* ctx.read({
				orders: { collection: 'orders', all: true, select: { title: true } },
				notes: { collection: 'notes', where: { text: { eq: 'b' } }, all: true },
				first: { collection: 'orders', id: '00000000-0000-4000-8000-000000000001' },
			});
			return { orders: orders.rows.map((r) => r.title).sort(), notes: notes.rows.length, first: first === null ? null : first.title };
		},
	} } } } };`);

	it.live(
		"reads every member in one round trip and one statement, each under the caller's read policy",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let statements = 0;
					const db = Layer.effect(
						TenantDb,
						Effect.gen(function* () {
							const inner = yield* TenantDb;
							return TenantDb.typed({
								...inner,
								read: (batch) =>
									Effect.suspend(() => {
										statements += batch.length;
										return inner.read(batch);
									})
							});
						})
					).pipe(Layer.provide(PgliteDb.layer()));
					const context = yield* Layer.build(
						TestWorkspace.layer({ manifest: keyed, guest: yield* board, db })
					);
					const t = Context.get(context, TestWorkspace),
						route = yield* routeFixture(context);
					const rows = [
						['00000000-0000-4000-8000-000000000001', 'closed', 'closed'],
						['00000000-0000-4000-8000-000000000002', 'open a', 'open'],
						['00000000-0000-4000-8000-000000000003', 'open b', 'open']
					] as const;
					for (const [id, title, status] of rows)
						yield* t.db.write({
							text: 'INSERT INTO orders (id, title, status) VALUES ($1, $2, $3)',
							params: [id, title, status]
						});
					yield* t.db.write({
						text: `INSERT INTO notes (id, text, "order") VALUES ('00000000-0000-4000-8000-000000000009', 'b', '00000000-0000-4000-8000-000000000002')`,
						params: []
					});
					const rep = t.as(t.member(['rep']));
					yield* qReply(route, rep.authority, {
						reads: [{ m: 'query', a: ['orders', 'board', {}] }]
					});
					t.count.reset();
					const s0 = statements;
					expect(
						(yield* qReply(route, rep.authority, {
							reads: [{ m: 'query', a: ['orders', 'board', {}] }]
						})).answers[0]
					).toEqual({ orders: ['open a', 'open b'], notes: 1, first: null });
					expect([t.count.reads, statements - s0]).toEqual([1, 1]);
				})
			)
	);
});

describe('several verbs as one act (`calls.acts`, `ctx.act.many`)', () => {
	it.live(
		'plans every act at once — one read round trip and statement — and commits them in one statement',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let statements = 0;
					const db = Layer.effect(
						TenantDb,
						Effect.gen(function* () {
							const inner = yield* TenantDb;
							return TenantDb.typed({
								...inner,
								read: (batch) =>
									Effect.suspend(() => {
										statements += batch.length;
										return inner.read(batch);
									})
							});
						})
					).pipe(Layer.provide(PgliteDb.layer()));
					const context = yield* Layer.build(
						TestWorkspace.layer({ manifest, guest: yield* guest, db })
					);
					const t = Context.get(context, TestWorkspace),
						calls = Context.get(context, Callables);
					const order = '00000000-0000-4000-8000-0000000000a1';
					yield* t.db.write({
						text: `INSERT INTO orders (id, title) VALUES ('${order}', 'desk')`,
						params: []
					});
					const rep = t.as(t.member(['rep'])).authority;
					t.count.reset();
					const s0 = statements;
					const r = yield* calls.acts({
						name: 'probe',
						key: 'k-acts',
						issuedAt: t.clock.now(),
						authority: rep,
						invocationId: 'k-acts',
						from: 'Server',
						bindings: {
							now: t.clock.now(),
							today: t.clock.now().slice(0, 10),
							tz: 'UTC',
							params: {}
						},
						acts: [
							{
								collection: 'notes',
								verb: 'create',
								input: [
									{ text: 'a', order },
									{ text: 'b', order }
								]
							},
							{ collection: 'orders', verb: 'create', input: { title: 'chair' } },
							{ collection: 'notes', verb: 'create', input: { text: 'c', order } }
						]
					});
					expect(r.outcome, JSON.stringify(r.outcome)).toMatchObject({ kind: 'committed' });
					expect([t.count.reads, statements - s0, t.count.writes]).toEqual([1, 1, 1]);
					expect([yield* count(t.db, 'orders'), yield* count(t.db, 'notes')]).toEqual([2, 3]);
				})
			)
	);
});
