// End to end through `/__bolt/act`, the engine entry and the test kit: a generated nested create writing two models in
// one native batch, idempotent under its key (rules 31, 33), its commit published to the live lane.
import { describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Live } from '../src/engine/services.ts';
import { ActReply } from '../src/protocol/schema.ts';
import { KitInvalid, TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { uuidv7 } from '../src/protocol/wire.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		orders: { description: 'An order', label: 'title', fields: { title: { kind: 'text' } } },
		notes: { description: 'A note', label: 'text', fields: { text: { kind: 'text' } } }
	},
	relationships: { 'notes.order': { to: 'orders', inverse: 'notes' } },
	exposures: {
		orders: {
			read: { orders: { fields: 'all' } },
			create: {
				columns: { orders: ['title'], 'orders.notes': ['text'] }
			}
		},
		notes: { read: { notes: { fields: 'all' } }, create: { columns: { notes: ['text', 'order'] } } }
	},
	policies: {
		rep: {
			description: 'Rep',
			grants: {
				orders: { read: true, create: true },
				notes: { read: true, create: true }
			},
			automations: ['orders_place']
		}
	},
	integrations: {},
	teams: {},
	automations: {
		orders_place: {
			description: 'Place an order with its note',
			input: { title: { kind: 'text' } },
			output: { kind: 'text' },
			policies: ['rep']
		}
	},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;
const guest = program(`export default { automation: { orders_place: { body: function* (input, ctx) {
	const made = yield* ctx.act('orders.create', [{
		title: input.title, notes: [{ text: 'placed ' + input.title }],
	}]);
	return made.records.find((row) => row.model === 'orders').id;
} } } };`);
const json = (response: Response) =>
	Effect.tryPromise({
		try: () => response.json(),
		catch: (error) => new KitInvalid({ message: String(error) })
	});
const count = (db: TenantDb['Service'], model: string) =>
	db.value(Schema.Number, { text: `SELECT count(*)::int AS n FROM ${model}`, params: [] });

describe('a generated nested create over /__bolt/act', () => {
	it.live('writes two models in one native batch; the same key replays without adding rows', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* guest }));
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
								callable: 'orders.create',
								input: [{ title: 'desk', notes: [{ text: 'placed desk' }] }],
								issuedAt: t.clock.now()
							})
						})
					);
				const commits = vi.spyOn(t.db, 'transaction');
				const first = yield* post();
				expect(first.status).toBe(200);
				const reply = yield* Schema.decodeUnknownEffect(ActReply)(yield* json(first));
				expect(reply.outcome).toMatchObject({ kind: 'committed' });
				expect(reply.v).toBeGreaterThan(0);
				expect(reply.v).toBe(yield* live.v);
				expect(commits).toHaveBeenCalledTimes(1);
				expect(yield* json(yield* post())).toMatchObject({ outcome: reply.outcome });
				expect([yield* count(t.db, 'orders'), yield* count(t.db, 'notes')]).toEqual([1, 1]);
			})
		)
	);

	it.live('starts the order workflow as a queued run and records its result after execution', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* guest }));
				const t = Context.get(context, TestWorkspace);
				const queued = (yield* actReply(
					yield* routeFixture(context),
					t.as(t.member(['rep'])).authority,
					{
						callable: 'start',
						input: {
							automation: 'orders_place',
							runs: [{ id: uuidv7(Date.parse(t.clock.now())), input: { title: 'desk' } }]
						},
						issuedAt: t.clock.now()
					}
				)).outcome;
				if (queued.kind !== 'committed') throw new Error('Order workflow did not enqueue');
				const run = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
					queued.output
				);
				expect(yield* count(t.db, 'orders')).toBe(0);
				expect(
					yield* t.db.rows(Schema.Struct({ state: Schema.String }), {
						text: 'SELECT state FROM sys_run WHERE id = $1',
						params: [run.id]
					})
				).toEqual([{ state: 'queued' }]);
				yield* t.runDue();
				const order = (yield* t.db.rows(Schema.Struct({ id: Schema.String }), {
					text: 'SELECT id FROM orders',
					params: []
				}))[0];
				if (order === undefined) throw new Error('Missing workflow order');
				expect(
					yield* t.db.rows(Schema.Struct({ state: Schema.String, output: Schema.Json }), {
						text: 'SELECT state, output FROM sys_run WHERE id = $1',
						params: [run.id]
					})
				).toEqual([{ state: 'succeeded', output: order.id }]);
				expect([yield* count(t.db, 'orders'), yield* count(t.db, 'notes')]).toEqual([1, 1]);
			})
		)
	);
});

describe('a read request (`bolt.query({ … })`)', () => {
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
		exposures: {
			...manifest.exposures,
			orders: {
				...manifest.exposures.orders,
				read: { orders: { fields: 'all' }, 'orders.notes': { fields: 'all' } }
			}
		},
		policies: {
			rep: {
				description: 'Rep',
				grants: {
					orders: { read: { orders: { where: { status: { eq: 'open' } } } }, create: true },
					notes: { read: true, create: true }
				}
			}
		},
		needs: []
	} satisfies EngineManifest;
	const request = {
		orders: { fields: ['title'], orderBy: [{ title: 'asc' }] },
		'orders.notes': { fields: ['text'] },
		notes: { where: { text: { eq: 'b' } } }
	};

	it.live(
		"reads every root and layer in one round trip and one statement, each root under the caller's read policy",
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
					const context = yield* Layer.build(TestWorkspace.layer({ manifest: keyed, db }));
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
					yield* qReply(route, rep.authority, { reads: [{ m: 'query', a: [request] }] });
					t.count.reset();
					const s0 = statements;
					expect(
						(yield* qReply(route, rep.authority, { reads: [{ m: 'query', a: [request] }] }))
							.answers[0]
					).toMatchObject({
						// the closed order is outside the root's scope; its layer follows the root
						orders: {
							rows: [
								{ title: 'open a', notes: [{ text: 'b' }] },
								{ title: 'open b', notes: [] }
							],
							next: null
						},
						notes: { rows: [{ text: 'b' }], next: null }
					});
					expect([t.count.reads, statements - s0]).toEqual([1, 1]);
				})
			)
	);
});
