// Queries, generated atomic batches, queued automations, visitors and refusal scoping on PGlite.
import { describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { Context, Effect, Layer, Option, Result, Schema } from 'effect';
import { decodeManifest } from '../src/engine/manifest.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TenantDb, type DbBatch } from '../src/engine/db/tenant-db.ts';
import { Callables } from '../src/engine/services.ts';
import { row } from '../src/engine/system/rows.ts';
import { program } from './support/guest-fixture.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import { HEADERS, uuidv7 } from '../src/protocol/wire.ts';
import type { Json } from '../src/decl/values.ts';
import type { Authority } from '../src/engine/contracts.ts';
import { DbError } from '../src/engine/errors.ts';
import type { ActOutcome as Outcome } from '../src/engine/contracts.ts';
import { ActConflict, actFailure } from '../src/decl/errors.ts';
import { forActor } from '../src/engine/callables/index.ts';
import { KitInvalid, TestWorkspace, type ActOptions, type TestOptions } from '../src/test/index.ts';

const ACME = '0199a000-0000-4000-8000-0000000000c1';
const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			customers: { description: 'A customer', label: 'name', fields: { name: { kind: 'text' } } },
			orders: {
				description: 'An order',
				label: 'title',
				fields: {
					title: { kind: 'text' },
					region: { kind: 'enum', values: ['north', 'south'] },
					status: {
						kind: 'state',
						initial: 'draft',
						states: { draft: { to: ['submitted'] }, submitted: {} }
					}
				}
			},
			notes: { description: 'A note', label: 'text', fields: { text: { kind: 'text' } } }
		},
		relationships: {
			'orders.customer': { to: 'customers', inverse: 'orders' },
			'notes.order': { to: 'orders', inverse: 'notes' }
		},
		collections: {
			customers: { read: { fields: 'all' } },
			orders: {
				read: { fields: 'all' },
				create: { input: { columns: ['title', 'region', 'customer'] }, transform: true },
				update: { input: { columns: ['title', 'status'] } },
				queries: {
					mine: { description: 'My orders', input: {}, output: { kind: 'int' } },
					secret: { description: 'Internal', input: {}, output: { kind: 'int' }, internal: true }
				}
			},
			notes: { read: { fields: 'all' }, create: { input: { columns: ['text', 'order'] } } }
		},
		integrations: {},
		policies: {
			rep: {
				description: 'Rep',
				automations: ['followup', 'place', 'submit', 'revise', 'boom'],
				grants: {
					customers: { read: true },
					orders: {
						read: { created_by: { eq: { actor: 'id' } } },
						create: true,
						update: 'read',
						moves: { status: ['draft->submitted'] },
						queries: ['mine', 'secret']
					},
					notes: { read: true, create: true }
				}
			},
			// A trigger-run automation keeps this caller's grants; starting it grants no order writes.
			clerk: {
				description: 'Clerk',
				automations: ['place'],
				grants: { customers: { read: true }, orders: { read: true } }
			}
		},
		teams: { Rep: ['rep'], Clerk: ['clerk'] },
		automations: {
			place: {
				description: 'Place an order',
				input: { title: { kind: 'text' }, customer: { kind: 'id', of: 'customers' } },
				output: { kind: 'text' },
				runAs: 'trigger'
			},
			submit: {
				description: 'Submit an order',
				input: { order: { kind: 'id', of: 'orders' } },
				output: { kind: 'text' },
				runAs: 'trigger'
			},
			revise: {
				description: 'Apply an observed extraction',
				input: { order: { kind: 'id', of: 'orders' }, revision: { kind: 'int' } },
				output: { kind: 'text' },
				runAs: 'trigger'
			},
			boom: { description: 'Throws', input: {}, runAs: 'trigger' },
			followup: {
				description: 'Follow up',
				input: { order: { kind: 'id', of: 'orders' } },
				runAs: ['rep']
			}
		},
		connections: {},
		envoys: {},
		mcp: {},
		customFields: {},
		agent: { skills: {} },
		apps: {}
	})
);

const guest = program(`import { Effect } from 'effect';
import { ActRefused } from '@norbital-ai/bolt/errors';
export default {
 collection: { orders: { bodies: {
  create: function* (inputs, ctx) {
   for (const [row, input] of inputs.entries())
    if (input.title === 'no') return yield* ctx.refuse('not that one', { field: 'title', row });
   return inputs;
  },
  queries: {
   mine: function* (input, ctx) { return (yield* ctx.query('orders', { all: true })).rows.length; },
   secret: function* () { return 42; }
  }
 } } },
 automation: {
  place: { body: function* (input, ctx) {
   if (input.title === 'no') return yield* Effect.fail(new ActRefused({code:'refused', message:'not that one', field:'title', rule:'place'}));
   const o = yield* ctx.act('orders.create', { title: input.title, region: 'north', customer: input.customer });
   const id = o.records[0].id;
   yield* ctx.act('notes.create', { text: 'placed ' + input.title, order: id });
   const run = yield* ctx.schedule('followup', { order: id }, { at: { now: '+1h' } });
   yield* ctx.notify({ to: [{ policy: 'rep' }], title: 'Placed' });
   return id + ':' + run.automation + ':' + (yield* ctx.query('orders.secret', {}));
  } },
  submit: { body: function* (input, ctx) {
   const target = yield* ctx.query('orders', { id: input.order });
   yield* ctx.act('orders.update', { target: input.order, set: { status: 'submitted' } });
   return target.title;
  } },
  revise: { body: function* (input, ctx) {
   yield* ctx.act('orders.update', {target:input.order, set:{title:'extracted'}}, {observed:{[input.order]:input.revision}});
   return 'extracted';
  } },
  boom: { body: function* () { throw new Error('a bug'); } },
  followup: { body: function* (input) { return input.order; } }
 }
};`);
const fixture = (options: Extract<TestOptions, { artifact?: never }> = {}) =>
	Effect.gen(function* () {
		const defaults =
			options.root === undefined
				? {
						manifest,
						guest: yield* guest,
						now: '2026-09-25T10:00:00.000Z',
						seed: { customers: [{ id: ACME, name: 'Acme' }] }
					}
				: {};
		const context = yield* Layer.build(TestWorkspace.layer({ ...defaults, ...options }));
		return {
			t: Context.get(context, TestWorkspace),
			calls: Context.get(context, Callables),
			context,
			route: yield* routeFixture(context)
		};
	});
type Fixture = Effect.Success<ReturnType<typeof fixture>>;
const ok = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return o;
};
const rows = (f: Fixture, sql: string) =>
	f.t.db.read([{ text: sql, params: [] }]).pipe(Effect.map((r) => r[0]?.rows ?? []));
const act = (
	f: Fixture,
	authority: Authority,
	callable: string,
	input: Json,
	options: ActOptions & { address?: string } = {}
) =>
	actReply(
		f.route,
		authority,
		{
			callable,
			input,
			issuedAt: f.t.clock.now(),
			...(options.observed === undefined ? {} : { observed: options.observed }),
			...(options.onConflict === undefined ? {} : { onConflict: options.onConflict })
		},
		{
			...(options.key === undefined ? {} : { 'Idempotency-Key': options.key }),
			...(options.retry ? { [HEADERS.retry]: '1' } : {})
		},
		options.address === undefined ? {} : { address: options.address }
	).pipe(
		Effect.flatMap((r) => {
			const failure = actFailure(r.outcome);
			return Option.isSome(failure) ? Effect.fail(failure.value) : Effect.succeed(r.outcome);
		})
	);
const answer = (f: Fixture, authority: Authority, a: readonly Json[]) =>
	qReply(f.route, authority, { reads: [{ m: 'query', a }] }).pipe(Effect.map((r) => r.answers[0]));
const read = (f: Fixture, authority: Authority, collection: string, q: Json) =>
	answer(f, authority, [collection, q]).pipe(
		Effect.flatMap(
			Schema.decodeUnknownEffect(
				Schema.Struct({
					rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
					next: Schema.NullOr(Schema.String)
				})
			)
		)
	);
const get = (f: Fixture, authority: Authority, collection: string, id: string) =>
	answer(f, authority, [collection, { id }]);
const query = (f: Fixture, authority: Authority, name: string, input: Json = {}) =>
	answer(f, authority, [name, input]);
const start = (
	f: Fixture,
	authority: Authority,
	automation: string,
	input: Json,
	options: { id?: string } = {}
) =>
	act(f, authority, 'start', {
		automation,
		input,
		id: options.id ?? uuidv7(Date.parse(f.t.clock.now()))
	});

const Run = row('sys_run', ['id', 'state', 'output', 'error', 'attempts']);
const run = (f: Fixture, id: string) =>
	f.t.db
		.one(Run, {
			text: 'SELECT id, state, output, error, attempts FROM sys_run WHERE id = $1',
			params: [id]
		})
		.pipe(Effect.map(Option.getOrThrow));
type Batch = Parameters<Fixture['calls']['acts']>[0]['acts'];
const batch = (f: Fixture, authority: Authority, acts: Batch, key: string = crypto.randomUUID()) =>
	f.calls
		.acts({
			name: 'act.many',
			acts,
			key,
			invocationId: key,
			issuedAt: f.t.clock.now(),
			authority,
			bindings: {
				now: f.t.clock.now(),
				today: f.t.clock.now().slice(0, 10),
				tz: 'UTC',
				params: {}
			},
			from: 'Client'
		})
		.pipe(
			Effect.flatMap(({ outcome }) => {
				const failure = actFailure(outcome);
				return Option.isSome(failure) ? Effect.fail(failure.value) : Effect.succeed(outcome);
			})
		);

// Retirement mapping: workflows use durable queued starts; observations, one-commit atomicity, late callback
// refusal, serialization replay and idempotency stay on native generated verbs/batches.
describe('generated batches and queued business workflows', () => {
	it.live(
		'queued ctx.act retains its observed revision, and generated batches keep their per-item guards',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture();
					const admin = f.t.as(f.t.admin);
					const created = ok(
						yield* act(f, admin.authority, 'orders.create', {
							title: 'original',
							region: 'north',
							customer: ACME
						})
					).records[0];
					if (created === undefined) throw new Error('Missing created order');
					const updated = ok(
						yield* act(f, admin.authority, 'orders.update', {
							target: created.id,
							set: { title: 'newer edit' }
						})
					).records[0];
					if (updated === undefined) throw new Error('Missing updated order');
					const stale = uuidv7(Date.parse(f.t.clock.now()));
					ok(
						yield* start(
							f,
							admin.authority,
							'revise',
							{ order: created.id, revision: created.revision },
							{ id: stale }
						)
					);
					expect((yield* run(f, stale)).state).toBe('queued');
					yield* f.t.runDue();
					expect(yield* run(f, stale)).toMatchObject({
						state: 'failed',
						error: { code: 'conflict' }
					});
					expect(
						yield* Effect.flip(
							act(
								f,
								admin.authority,
								'orders.update',
								{ target: created.id, set: { title: 'stale outer' } },
								{ observed: { [created.id]: created.revision } }
							)
						)
					).toMatchObject({ _tag: 'ActConflict' });
					expect(
						yield* Effect.flip(
							batch(f, admin.authority, [
								{
									collection: 'orders',
									verb: 'update',
									input: { target: created.id, set: { title: 'stale batch' } },
									observed: { [created.id]: created.revision }
								}
							])
						)
					).toMatchObject({ _tag: 'ActConflict' });
					expect(yield* get(f, admin.authority, 'orders', created.id)).toMatchObject({
						title: 'newer edit',
						revision: updated.revision
					});
					expect(
						yield* batch(f, admin.authority, [
							{
								collection: 'orders',
								verb: 'update',
								input: { target: created.id, set: { title: 'extracted' } },
								observed: { [created.id]: updated.revision }
							}
						])
					).toMatchObject({ kind: 'committed' });
					expect(yield* get(f, admin.authority, 'orders', created.id)).toMatchObject({
						title: 'extracted',
						revision: updated.revision + 1
					});
				})
			)
	);
	it.live(
		'a queued workflow creates its order and note, schedules followup and notifies before returning its run output',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t,
						rep = t.as(t.member(['rep']));
					yield* t.db.write({
						text: "INSERT INTO sys_user (id,name,team) VALUES ('u9','Rep','Rep')",
						params: []
					});
					const id = uuidv7(Date.parse(t.clock.now()));
					expect(
						yield* start(f, rep.authority, 'place', { title: 'desk', customer: ACME }, { id })
					).toMatchObject({ kind: 'committed', output: { id, automation: 'place', ids: [id] } });
					expect((yield* run(f, id)).state).toBe('queued');
					expect(yield* rows(f, 'SELECT id FROM orders')).toEqual([]);
					yield* t.runDue();
					const order = (yield* read(f, rep.authority, 'orders', { all: true })).rows[0];
					if (order === undefined || typeof order['id'] !== 'string')
						throw new Error('Missing workflow order');
					expect(yield* run(f, id)).toMatchObject({
						state: 'succeeded',
						output: order['id'] + ':followup:42',
						error: null
					});
					expect(
						(yield* read(f, rep.authority, 'notes', { all: true })).rows.map((n) => n['text'])
					).toEqual(['placed desk']);
					const [scheduled] = yield* rows(
						f,
						"SELECT automation,input,due_at,cause FROM sys_run WHERE automation='followup'"
					);
					expect(scheduled).toMatchObject({
						automation: 'followup',
						input: { order: order['id'] },
						cause: 'schedule'
					});
					expect(new Date(String(scheduled?.['due_at'])).toISOString()).toBe(
						'2026-09-25T11:00:00.000Z'
					);
					expect(
						t.fakes.deadlines.announced.map(({ scope, at }) => ({ scope, at: Date.parse(at) }))
					).toContainEqual({ scope: 'test', at: Date.parse('2026-09-25T10:00:00.000Z') });
					expect(yield* rows(f, 'SELECT title,member FROM sys_notification')).toEqual([
						{ title: 'Placed', member: 'u9' }
					]);
				})
			)
	);
	it.live('independent generated verbs across collections commit in one native batch', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture(),
					t = f.t,
					rep = t.as(t.member(['rep']));
				const parent = ok(
					yield* act(f, rep.authority, 'orders.create', {
						title: 'parent',
						region: 'north',
						customer: ACME
					})
				).records[0];
				if (parent === undefined) throw new Error('Missing parent');
				const commits = vi.spyOn(t.db, 'transaction');
				const placed = ok(
					yield* batch(f, rep.authority, [
						{
							collection: 'orders',
							verb: 'create',
							input: { title: 'desk', region: 'north', customer: ACME }
						},
						{
							collection: 'notes',
							verb: 'create',
							input: { text: 'placed desk', order: parent.id }
						}
					])
				);
				expect(commits).toHaveBeenCalledTimes(1);
				expect(placed.records.map((r) => r.collection).sort()).toEqual(['notes', 'orders']);
				expect(
					(yield* read(f, rep.authority, 'notes', { all: true })).rows.map((n) => n['text'])
				).toEqual(['placed desk']);
			})
		)
	);
	it.live(
		'a late generated callback refusal commits no partial rows and a replay adds no business writes',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t,
						rep = t.as(t.member(['rep']));
					const operations: Batch = [
						{
							collection: 'orders',
							verb: 'create',
							input: { title: 'accepted first', region: 'north', customer: ACME }
						},
						{
							collection: 'orders',
							verb: 'create',
							input: { title: 'no', region: 'north', customer: ACME }
						}
					];
					const commits = vi.spyOn(t.db, 'transaction');
					const first = yield* Effect.flip(batch(f, rep.authority, operations, 'refused-batch'));
					expect(first).toMatchObject({
						_tag: 'ActRefused',
						code: 'refused',
						message: 'not that one',
						field: 'title'
					});
					expect(commits).not.toHaveBeenCalled();
					expect(yield* Effect.flip(batch(f, rep.authority, operations, 'refused-batch'))).toEqual(
						first
					);
					expect(commits).not.toHaveBeenCalled();
					expect(yield* rows(f, 'SELECT id FROM orders')).toEqual([]);
					const id = uuidv7(Date.parse(t.clock.now()));
					ok(yield* start(f, rep.authority, 'place', { title: 'no', customer: ACME }, { id }));
					expect((yield* run(f, id)).state).toBe('queued');
					yield* t.runDue();
					expect(yield* run(f, id)).toMatchObject({
						state: 'failed',
						error: { code: 'refused', message: 'not that one', field: 'title', rule: 'place' }
					});
					expect(yield* rows(f, 'SELECT id FROM orders')).toEqual([]);
					expect(yield* rows(f, 'SELECT id FROM notes')).toEqual([]);
				})
			)
	);
	it.live(
		'records a terminal serialization conflict after one generated batch replay and returns it on retry',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const storage = yield* Layer.build(PgliteDb.layer()),
						inner = Context.get(storage, TenantDb);
					let armed = false,
						failures = 0;
					const attempts: DbBatch[] = [];
					const db = TenantDb.typed({
						read: inner.read,
						transaction: (batch) =>
							Effect.suspend(() => {
								if (armed) {
									attempts.push(batch);
									if (failures++ < 2)
										return Effect.fail(DbError.make('40001', 'serialization fixture'));
								}
								return inner.transaction(batch);
							}),
						session: inner.session,
						write: inner.write
					});
					const f = yield* fixture({ db: Layer.succeed(TenantDb, db) }),
						rep = f.t.as(f.t.member(['rep']));
					yield* f.t.db.read([]);
					armed = true;
					const operations: Batch = [
						{
							collection: 'orders',
							verb: 'create',
							input: { title: 'bounded callable', region: 'north', customer: ACME }
						}
					];
					const first = yield* Effect.flip(batch(f, rep.authority, operations, 'bounded-callable'));
					expect(first).toEqual(new ActConflict({ records: [] }));
					expect(attempts).toHaveLength(3);
					expect(attempts[1]?.statements).toEqual(attempts[0]?.statements);
					expect(yield* rows(f, 'SELECT id FROM orders')).toEqual([]);
					attempts.length = 0;
					expect(
						yield* Effect.flip(batch(f, rep.authority, operations, 'bounded-callable'))
					).toEqual(first);
					// A native replay checks the persisted outcome in one batch without adding business rows.
					expect(attempts).toHaveLength(1);
					expect(yield* rows(f, 'SELECT id FROM orders')).toEqual([]);
				})
			)
	);
	it.live(
		'a generated verb replay returns the first outcome and adds no rows; changed input is keyReuse',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						rep = f.t.as(f.t.member(['rep']));
					const input = { title: 'desk', region: 'north', customer: ACME };
					const first = yield* act(f, rep.authority, 'orders.create', input, { key: 'same' });
					expect(yield* act(f, rep.authority, 'orders.create', input, { key: 'same' })).toEqual(
						first
					);
					expect(yield* rows(f, 'SELECT count(*)::int AS n FROM orders')).toEqual([{ n: 1 }]);
					expect(
						yield* Effect.flip(
							act(f, rep.authority, 'orders.create', { ...input, title: 'other' }, { key: 'same' })
						)
					).toMatchObject({ _tag: 'ActRefused', code: 'keyReuse' });
				})
			)
	);
	it.live('a queued trigger-run workflow retains a clerk’s grants and cannot write orders', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture(),
					id = uuidv7(Date.parse(f.t.clock.now()));
				ok(
					yield* start(
						f,
						f.t.as(f.t.member(['clerk'])).authority,
						'place',
						{ title: 'desk', customer: ACME },
						{ id }
					)
				);
				expect((yield* run(f, id)).state).toBe('queued');
				yield* f.t.runDue();
				expect(yield* run(f, id)).toMatchObject({ state: 'failed', error: { code: 'forbidden' } });
				expect(yield* rows(f, 'SELECT id FROM orders')).toEqual([]);
			})
		)
	);
	it.live('automation admission and internal queries require their policy grants', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture(),
					rep = f.t.as(f.t.member(['rep']));
				expect(
					yield* Effect.flip(
						start(f, f.t.as(f.t.member([])).authority, 'place', { title: 'x', customer: ACME })
					)
				).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
				expect(yield* Effect.flip(query(f, rep.authority, 'orders.secret'))).toMatchObject({
					code: 'forbidden'
				});
			})
		)
	);
	it.live(
		'a start decodes its declared input and readable refs before queuing or invoking guest code',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						rep = f.t.as(f.t.member(['rep']));
					expect(
						yield* Effect.flip(start(f, rep.authority, 'place', { title: 1, customer: ACME }))
					).toMatchObject({ _tag: 'ActRefused', code: 'invalidInput', field: 'title' });
					expect(
						yield* Effect.flip(
							start(f, rep.authority, 'place', {
								title: 'x',
								customer: '0199a000-0000-4000-8000-00000000dead'
							})
						)
					).toMatchObject({ _tag: 'ActRefused', code: 'notFound', field: 'customer' });
					expect(yield* rows(f, 'SELECT id FROM sys_run')).toEqual([]);
				})
			)
	);
	it.live(
		'a queued submit reads its explicit order input and preserves caller target visibility',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						rep = f.t.as(f.t.member(['rep']));
					const order = ok(
						yield* act(f, rep.authority, 'orders.create', {
							title: 'chair',
							region: 'north',
							customer: ACME
						})
					).records[0];
					if (order === undefined) throw new Error('Missing created order');
					const id = uuidv7(Date.parse(f.t.clock.now()));
					ok(yield* start(f, rep.authority, 'submit', { order: order.id }, { id }));
					expect((yield* run(f, id)).state).toBe('queued');
					yield* f.t.runDue();
					expect(yield* run(f, id)).toMatchObject({ state: 'succeeded', output: 'chair' });
					expect(yield* get(f, rep.authority, 'orders', order.id)).toMatchObject({
						status: 'submitted'
					});
					expect(
						yield* Effect.flip(
							start(f, f.t.as(f.t.member(['rep'])).authority, 'submit', { order: order.id })
						)
					).toMatchObject({ _tag: 'ActRefused', code: 'notFound', field: 'order' });
				})
			)
	);
	it.live(
		'a queued guest failure is recorded on its run and restarting the same id never invokes it twice',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						rep = f.t.as(f.t.member(['rep'])),
						id = uuidv7(Date.parse(f.t.clock.now()));
					const first = yield* start(f, rep.authority, 'boom', {}, { id });
					expect(first).toMatchObject({ kind: 'committed' });
					expect((yield* run(f, id)).state).toBe('queued');
					yield* f.t.runDue();
					expect(yield* run(f, id)).toMatchObject({
						state: 'failed',
						attempts: 1,
						error: { code: 'guestError', message: 'a bug' }
					});
					expect(yield* start(f, rep.authority, 'boom', {}, { id })).toEqual(first);
					yield* f.t.runDue();
					expect(yield* run(f, id)).toMatchObject({ state: 'failed', attempts: 1 });
					expect(yield* rows(f, 'SELECT id FROM orders')).toEqual([]);
				})
			)
	);
});

describe('collection queries (rule 31: a /q read)', () => {
	it.live('reads as the caller, writes nothing, and is reachable only by policy', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture(),
					t = f.t;
				const a = t.as(t.member(['rep'])),
					b = t.as(t.member(['rep']));
				ok(
					yield* act(f, a.authority, 'orders.create', {
						title: 'x',
						region: 'north',
						customer: ACME
					})
				);
				t.count.reset();
				expect(yield* query(f, a.authority, 'orders.mine')).toBe(1);
				expect(yield* query(f, b.authority, 'orders.mine')).toBe(0);
				expect(t.count.writes).toBe(0);
				expect(
					yield* Effect.flip(query(f, t.as(t.member(['clerk'])).authority, 'orders.mine'))
				).toMatchObject({ code: 'forbidden' });
				expect(
					yield* Effect.flip(query(f, a.authority, 'orders.mine', { extra: 1 }))
				).toMatchObject({ code: 'invalidInput' });
			})
		)
	);
});

describe('start (rules 31, 33, 51)', () => {
	it.live(
		'the client-minted id is the key: same input is the same run, other input keyReuse, and only policy.automations may start',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					const rep = t.as(t.member(['rep']));
					const order = ok(
						yield* act(f, rep.authority, 'orders.create', {
							title: 'x',
							region: 'north',
							customer: ACME
						})
					).records[0]!.id;
					const order2 = ok(
						yield* act(f, rep.authority, 'orders.create', {
							title: 'y',
							region: 'north',
							customer: ACME
						})
					).records[0];
					if (order2 === undefined) throw new Error('Missing second order');
					const id = uuidv7(Date.parse(t.clock.now()));
					const first = yield* start(f, rep.authority, 'followup', { order }, { id });
					expect(first).toEqual({
						kind: 'committed',
						output: { id, automation: 'followup', ids: [id] },
						records: []
					});
					expect(yield* start(f, rep.authority, 'followup', { order }, { id })).toEqual(first);
					expect(
						yield* Effect.flip(start(f, rep.authority, 'followup', { order: order2.id }, { id }))
					).toMatchObject({ _tag: 'ActRefused', code: 'keyReuse' });
					expect(yield* rows(f, 'SELECT due_at, cause FROM sys_run')).toHaveLength(1);
					// a bulk start queues one run per record in one request, and a retry of it is the same start
					const ids = [uuidv7(Date.parse(t.clock.now())), uuidv7(Date.parse(t.clock.now()))];
					const bulk = {
						automation: 'followup',
						runs: [
							{ id: ids[0]!, input: { order } },
							{ id: ids[1]!, input: { order: order2.id } }
						]
					};
					expect(yield* act(f, rep.authority, 'start', bulk)).toEqual({
						kind: 'committed',
						output: { id: ids[0], automation: 'followup', ids },
						records: []
					});
					expect(yield* act(f, rep.authority, 'start', bulk)).toMatchObject({ kind: 'committed' });
					expect(yield* rows(f, 'SELECT id FROM sys_run')).toHaveLength(3);
					expect(
						yield* Effect.flip(start(f, t.as(t.member(['clerk'])).authority, 'followup', { order }))
					).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
				})
			)
	);
});

describe('the kit: signIn and the clock', () => {
	it.live('signIn resolves source policy membership by email; the clock binds every call', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture(),
					t = f.t;
				yield* t.db.write({
					text: `INSERT INTO sys_user (id, email, name,team) VALUES ('u1', 'Rep@Example.com', 'Rep','Rep')`,
					params: []
				});
				const rep = t.as(yield* t.signIn('rep@example.com'));
				expect(rep.authority.policies).toEqual(['rep']);
				t.clock.advance('2h');
				expect(t.clock.now()).toBe('2026-09-25T12:00:00.000Z');
				ok(yield* start(f, rep.authority, 'place', { title: 'desk', customer: ACME }));
				yield* t.runDue();
				const [run] = yield* rows(f, "SELECT due_at FROM sys_run WHERE automation = 'followup'");
				expect(new Date(String(run!['due_at'])).toISOString()).toBe('2026-09-25T13:00:00.000Z');
				expect((yield* Effect.flip(t.signIn('nobody@example.com'))).message).toBeTruthy();
			})
		)
	);
});

describe('refusal messages by actor (rule 32)', () => {
	it('public and API-key actors receive codes only', () => {
		const no: Outcome = {
			kind: 'refused',
			code: 'refused',
			message: 'Shady is blocked',
			field: 'customer'
		};
		expect(forActor(no, { kind: 'apiKey', key: 'k' })).toEqual({
			kind: 'refused',
			code: 'refused',
			message: 'refused'
		});
		expect(
			forActor(no, { kind: 'envoy', envoy: 'e', instance: 'c', sender: 's', member: null })
		).toEqual({ kind: 'refused', code: 'refused', message: 'refused' });
		expect(
			forActor(no, {
				kind: 'member',
				id: 'u',
				email: null,
				phone: null,
				external: false,
				teams: [],
				teamPath: [],
				admin: false,
				party: null
			})
		).toEqual(no);
	});
});

// ── rule 38d: the careers recipe (§6.3) ──
const OPEN = '0199a000-0000-4000-8000-00000000000a',
	CLOSED = '0199a000-0000-4000-8000-00000000000b';
const careers = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			openings: {
				description: 'Roles',
				label: 'title',
				fields: {
					title: { kind: 'text' },
					location: { kind: 'text' },
					description: { kind: 'text' },
					status: { kind: 'enum', values: ['draft', 'open', 'closed'] }
				}
			},
			applications: {
				description: 'Applications',
				label: 'name',
				fields: {
					name: { kind: 'text' },
					email: { kind: 'text', format: 'email' },
					cv: { kind: 'file', accept: ['application/pdf'], max: '5MiB', optional: true }
				}
			}
		},
		relationships: { 'applications.opening': { to: 'openings', inverse: 'applications' } },
		collections: {
			openings: {
				read: { fields: 'all' },
				queries: { count: { description: 'Count', input: {}, output: { kind: 'int' } } }
			},
			applications: {
				read: { fields: 'all' },
				create: { input: { columns: ['opening', 'name', 'email', 'cv'] } }
			}
		},
		integrations: {},
		policies: {
			applicant: {
				description: 'Apply',
				grants: {
					openings: {
						read: {
							where: { status: { eq: 'open' } },
							fields: ['title', 'location', 'description']
						},
						queries: ['count']
					},
					applications: { create: { opening: { is: { status: { eq: 'open' } } } } }
				},
				limits: { register: { rate: '10/h', per: 'ip' } }
			}
		},
		apps: {
			careers: {
				title: 'Careers',
				description: 'Jobs',
				icon: 'x',
				audience: { public: ['applicant'] },
				pages: {}
			}
		},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		customFields: {},
		agent: { skills: {} }
	})
);

describe('visitors (rule 38d)', () => {
	it.live(
		'lists open roles masked to the granted fields, applies to an open role, and nothing else',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture({
							manifest: careers,
							seed: {
								openings: [
									{
										id: OPEN,
										title: 'Engineer',
										location: 'SG',
										description: 'Build',
										status: 'open'
									},
									{
										id: CLOSED,
										title: 'Old',
										location: 'KL',
										description: 'Gone',
										status: 'closed'
									}
								]
							}
						}),
						v = f.t;
					const me = v.visitor('careers');
					const open = (yield* read(f, me.authority, 'openings', { all: true })).rows;
					expect(open).toHaveLength(1);
					expect(open[0]).toMatchObject({
						id: OPEN,
						title: 'Engineer',
						location: 'SG',
						description: 'Build',
						status: { $masked: true }
					});
					ok(
						yield* act(f, me.authority, 'applications.create', {
							opening: OPEN,
							name: 'Ada',
							email: 'ada@example.com'
						})
					);
					expect(
						yield* Effect.flip(
							act(f, me.authority, 'applications.create', {
								opening: CLOSED,
								name: 'Ada',
								email: 'ada@example.com'
							})
						)
					).toMatchObject({ _tag: 'ActRefused', code: 'notFound', field: 'opening' });
					expect(
						yield* Effect.flip(
							act(f, me.authority, 'applications.create', {
								opening: '0199a000-0000-4000-8000-00000000dead',
								name: 'A',
								email: 'a@x.io'
							})
						)
					).toMatchObject({ code: 'notFound', field: 'opening' });
					expect(
						yield* Effect.flip(read(f, me.authority, 'applications', { all: true }))
					).toMatchObject({ code: 'forbidden' });
					expect(yield* Effect.flip(query(f, me.authority, 'openings.count'))).toMatchObject({
						code: 'forbidden'
					});
					expect(
						yield* Effect.flip(
							act(f, me.authority, 'applications.update', { target: OPEN, set: {} })
						)
					).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
				})
			)
	);

	it.live(
		'the 11th attempt in an hour from one IP is rateLimited, whatever the first ten were; a new visitor id does not reset it',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture({
							manifest: careers,
							seed: {
								openings: [
									{
										id: OPEN,
										title: 'Engineer',
										location: 'SG',
										description: 'Build',
										status: 'open'
									},
									{
										id: CLOSED,
										title: 'Old',
										location: 'KL',
										description: 'Gone',
										status: 'closed'
									}
								]
							}
						}),
						v = f.t;
					const attempt = (ip: string, input: Json) =>
						act(f, v.visitor('careers', { ip }).authority, 'applications.create', input, {
							address: ip
						});
					for (let i = 0; i < 10; i++) {
						const input =
							i % 3 === 0
								? { opening: OPEN, name: `A${i}`, email: 'a@x.io' }
								: i % 3 === 1
									? { opening: CLOSED, name: 'A', email: 'a@x.io' }
									: { nope: true };
						const result = yield* Effect.result(attempt('198.51.100.1', input));
						expect(Result.isSuccess(result) ? result.success.kind : result.failure._tag).not.toBe(
							'pendingApproval'
						);
					}
					expect(
						yield* Effect.flip(
							attempt('198.51.100.1', { opening: OPEN, name: 'Z', email: 'z@x.io' })
						)
					).toMatchObject({ _tag: 'ActRefused', code: 'rateLimited' });
					ok(yield* attempt('198.51.100.2', { opening: OPEN, name: 'Z', email: 'z@x.io' }));
				})
			)
	);

	it.live('uploads persist one sys_file row per client-minted id; a resend adds none', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture({
						manifest: careers,
						seed: {
							openings: [
								{
									id: OPEN,
									title: 'Engineer',
									location: 'SG',
									description: 'Build',
									status: 'open'
								},
								{ id: CLOSED, title: 'Old', location: 'KL', description: 'Gone', status: 'closed' }
							]
						}
					}),
					v = f.t;
				const me = v.visitor('careers');
				const file = {
					name: 'cv.pdf',
					mime: 'application/pdf',
					bytes: new Uint8Array([1, 2, 3]),
					id: '0199a000-0000-7000-8000-0000000000f1'
				};
				const first = yield* me.upload('applications.cv', file);
				if (first.kind !== 'committed') throw new Error(JSON.stringify(first));
				expect(first.output).toMatchObject({
					id: file.id,
					name: 'cv.pdf',
					mime: 'application/pdf',
					bytes: 3
				});
				expect(yield* me.upload('applications.cv', file)).toEqual(first);
				expect(
					yield* v.db
						.read([{ text: 'SELECT count(*)::int AS n FROM sys_file', params: [] }])
						.pipe(Effect.map((r) => r[0]?.rows ?? []))
				).toEqual([{ n: 1 }]);
				const { id: _id, ...otherFile } = file;
				expect(
					yield* Effect.flip(me.upload('applications.cv', { ...otherFile, mime: 'image/png' }))
				).toMatchObject({ _tag: 'ActRefused', code: 'invalidInput' });
				expect(yield* Effect.flip(me.upload('applications.name', file))).toMatchObject({
					_tag: 'ActRefused',
					code: 'forbidden'
				});
			})
		)
	);
});

describe('the kit compiles a workspace directory (root)', () => {
	it.live(
		'bolt check → engine → a transform act and a collection query through the built guest',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { mkdirSync, writeFileSync, rmSync } = yield* Effect.tryPromise({
						try: () => import('node:fs'),
						catch: (error) => new KitInvalid({ message: String(error) })
					});
					const { tmpdir } = yield* Effect.tryPromise({
						try: () => import('node:os'),
						catch: (error) => new KitInvalid({ message: String(error) })
					});
					const { dirname, join } = yield* Effect.tryPromise({
						try: () => import('node:path'),
						catch: (error) => new KitInvalid({ message: String(error) })
					});
					const root = yield* Effect.acquireRelease(
						Effect.sync(() => {
							const path = join(tmpdir(), 'norbital-scratch', `kit-${crypto.randomUUID()}`);
							mkdirSync(path, { recursive: true });
							return path;
						}),
						(path) => Effect.sync(() => rmSync(path, { recursive: true, force: true }))
					);
					const files: { [p: string]: string } = {
						'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
						'src/data/model/orders/+model.ts': `import { model } from '@norbital-ai/bolt';
export default model('orders', {
	description: 'Orders', label: 'title', fields: { title: { kind: 'text' } },
	read: { fields: 'all' },
	create: {
		columns: ['title'],
		transform: function* (rows) { return rows.map((r) => ({ ...r, title: r.title.trim() })); },
	},
	queries: { count: {
		description: 'Count', input: {}, output: { kind: 'int' },
		run: function* (input, ctx) { return (yield* ctx.query('orders', { all: true })).rows.length; },
	} },
});`,
						'src/access_control/policy/+rep.policy.ts': `export default { description: 'Rep', grants: { orders: { read: true, create: true, queries: ['count'] } } };`
					};
					for (const [p, text] of Object.entries(files)) {
						mkdirSync(dirname(join(root, p)), { recursive: true });
						writeFileSync(join(root, p), text);
					}
					const fk = yield* fixture({
						root,
						seed: { orders: [{ id: '0199a000-0000-4000-8000-000000000001', title: 'seeded' }] }
					});
					const k = fk.t;
					const rep = k.as(k.member(['rep']));
					const id = ok(yield* act(fk, rep.authority, 'orders.create', { title: '  desk ' }))
						.records[0]!.id;
					expect(yield* get(fk, rep.authority, 'orders', id)).toMatchObject({ title: 'desk' });
					expect(yield* query(fk, rep.authority, 'orders.count')).toBe(2);
				})
			)
	);

	it.live(
		"a custom field's validate runs on every write and refuses with the field and its message (§3.3.2)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { mkdirSync, writeFileSync, rmSync } = yield* Effect.tryPromise({
						try: () => import('node:fs'),
						catch: (error) => new KitInvalid({ message: String(error) })
					});
					const { tmpdir } = yield* Effect.tryPromise({
						try: () => import('node:os'),
						catch: (error) => new KitInvalid({ message: String(error) })
					});
					const { dirname, join } = yield* Effect.tryPromise({
						try: () => import('node:path'),
						catch: (error) => new KitInvalid({ message: String(error) })
					});
					const root = yield* Effect.acquireRelease(
						Effect.sync(() => {
							const path = join(tmpdir(), 'norbital-scratch', `kit-${crypto.randomUUID()}`);
							mkdirSync(path, { recursive: true });
							return path;
						}),
						(path) => Effect.sync(() => rmSync(path, { recursive: true, force: true }))
					);
					const files: { [p: string]: string } = {
						'src/+workspace.ts': `export default { tz: 'UTC', locale: 'en' };`,
						'src/data/custom_field/code/+definition.ts': `import { customField } from '@norbital-ai/bolt';
export default customField('code', {
	description: 'An upper-case code', shape: { kind: 'text' },
	validate: (v) => /^[A-Z]+$/.test(v) ? undefined : 'Use capital letters only.',
});`,
						'src/data/model/orders/+model.ts': `import { model } from '@norbital-ai/bolt';
export default model('orders', {
	description: 'Orders', label: 'title', fields: { title: { kind: 'text' },
		code: { kind: 'custom', of: 'code', optional: true }, codes: { kind: 'custom', of: 'code', many: true, optional: true } },
	read: 'all', create: { columns: ['title', 'code', 'codes'] }, update: { columns: ['code'] },
});`,
						'src/access_control/policy/+rep.policy.ts': `export default { description: 'Rep', grants: { orders: { read: true, create: true, update: true } } };`
					};
					for (const [p, text] of Object.entries(files)) {
						mkdirSync(dirname(join(root, p)), { recursive: true });
						writeFileSync(join(root, p), text);
					}
					const fk = yield* fixture({ root, seed: 'none' });
					const k = fk.t;
					const rep = k.as(k.member(['rep']));
					const id = ok(
						yield* act(fk, rep.authority, 'orders.create', {
							title: 'a',
							code: 'ABC',
							codes: ['X', 'Y']
						})
					).records[0]!.id;
					expect(
						yield* Effect.flip(act(fk, rep.authority, 'orders.create', { title: 'b', code: 'abc' }))
					).toMatchObject({
						_tag: 'ActRefused',
						code: 'invalidInput',
						field: 'code',
						message: 'Use capital letters only.'
					});
					expect(
						yield* Effect.flip(
							act(fk, rep.authority, 'orders.create', { title: 'c', codes: ['X', 'y'] })
						)
					).toMatchObject({ _tag: 'ActRefused', field: 'codes' });
					expect(
						yield* Effect.flip(
							act(fk, rep.authority, 'orders.update', { target: id, set: { code: 'lower' } })
						)
					).toMatchObject({
						_tag: 'ActRefused',
						field: 'code',
						message: 'Use capital letters only.'
					});
					expect(
						yield* Effect.flip(
							act(fk, k.as(k.admin).authority, 'orders.create', { title: 'd', code: 'x1' })
						)
					).toMatchObject({ _tag: 'ActRefused', field: 'code' });
					expect(yield* get(fk, rep.authority, 'orders', id)).toMatchObject({ code: 'ABC' });
				})
			)
	);
});

it.live('binds today to the workspace day when UTC is in the previous month', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fk = yield* fixture({
				manifest: { ...manifest, workspace: { ...manifest.workspace, tz: 'Asia/Singapore' } },
				now: '2026-09-30T16:30:00Z',
				guest: yield* program(`export default { collection: { orders: { bodies: { queries: {
			mine: function* (input, ctx) { return Number(ctx.today.replaceAll('-', '')); }
		} } } } };`)
			});
			expect(yield* query(fk, fk.t.as(fk.t.admin).authority, 'orders.mine')).toBe(20261001);
		})
	)
);
