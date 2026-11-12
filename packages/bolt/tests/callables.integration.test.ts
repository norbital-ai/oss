// Queries, generated atomic batches, queued automations, visitors and refusal scoping on PGlite.
import { describe, expect, it, layer } from '@effect/vitest';
import { vi } from 'vitest';
import { Context, Effect, Layer, Option, Result, Schema } from 'effect';
import { decode_projected_manifest } from '../src/engine/manifest.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TenantDb, type DbBatch } from '../src/engine/db/tenant-db.ts';
import { Callables } from '../src/engine/services.ts';
import { row } from '../src/engine/system/rows.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { act_reply, q_reply, route_fixture } from './support/route-fixture.ts';
import { HEADERS, uuidv7 } from '../src/protocol/wire.ts';
import type { Json } from '../src/decl/values.ts';
import type { Authority } from '../src/engine/contracts.ts';
import { DbError } from '../src/engine/errors.ts';
import type { ActOutcome as Outcome } from '../src/engine/contracts.ts';
import { ActConflict } from '../src/decl/errors.ts';
import { act_failure } from '../src/decl/errors/act.ts';
import { for_actor } from '../src/engine/callables/index.ts';
import { TestWorkspace, type TestOptions } from '../../bolt-cli/src/test/index.ts';
import type { ActOptions } from '../src/decl/ctx.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const ACME = '0199a000-0000-4000-8000-0000000000c1';
const manifest = Result.getOrThrow(
	decode_projected_manifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			customers: {
				description: 'A customer',
				record_label: 'record.name',
				fields: { name: { kind: 'text' } }
			},
			orders: {
				description: 'An order',
				record_label: 'record.title',
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
			notes: {
				description: 'A note',
				record_label: 'record.text',
				fields: { text: { kind: 'text' } }
			},
			// rule 38d: the careers recipe (§6.3)
			openings: {
				description: 'Roles',
				record_label: 'record.title',
				fields: {
					title: { kind: 'text' },
					location: { kind: 'text' },
					description: { kind: 'text' },
					status: { kind: 'enum', values: ['draft', 'open', 'closed'] }
				}
			},
			applications: {
				description: 'Applications',
				record_label: 'record.name',
				fields: {
					name: { kind: 'text' },
					email: { kind: 'text', format: 'email' },
					cv: { kind: 'file', accept: ['application/pdf'], max: '5MiB', optional: true }
				}
			}
		},
		relationships: {
			'orders.customer': { to: 'customers', inverse: 'orders' },
			'notes.order': { to: 'orders', inverse: 'notes' },
			'applications.opening': { to: 'openings', inverse: 'applications' }
		},
		exposures: {
			customers: { outputs: { default: { customers: { fields: 'all' } } } },
			orders: {
				outputs: { default: { orders: { fields: 'all' } } },
				create: { columns: { orders: ['title', 'region', 'customer'] }, transform: true },
				update: { columns: { orders: ['title', 'status'] } },
				delete: {}
			},
			notes: {
				outputs: { default: { notes: { fields: 'all' } } },
				create: { columns: { notes: ['text', 'order'] } }
			},
			openings: {
				outputs: {
					default: { openings: { fields: 'all' } },
					listing: { openings: { fields: ['title', 'location', 'description'] } }
				}
			},
			applications: {
				outputs: { default: { applications: { fields: 'all' } } },
				create: { columns: { applications: ['opening', 'name', 'email', 'cv'] } }
			}
		},
		integrations: {},
		policies: {
			rep: {
				description: 'Rep',
				capabilities: { automations: ['followup', 'place', 'revise'] },
				grants: {
					customers: { outputs: { default: {} } },
					orders: {
						outputs: {
							default: { scopes: { orders: { created_by: { eq: { var: 'requestor.id' } } } } }
						},
						create: {},
						update: { moves: { status: ['draft->submitted'] } }
					},
					notes: { outputs: { default: {} }, create: {} }
				}
			},
			// the runs' own: a run is the system identity, so the rep's own-orders scope would match nothing there
			ordering: {
				description: 'Place and revise orders',
				grants: {
					customers: { outputs: { default: {} } },
					orders: {
						outputs: { default: {} },
						create: {},
						update: { moves: { status: ['draft->submitted'] } }
					},
					notes: { outputs: { default: {} }, create: {} }
				}
			},
			applicant: {
				description: 'Apply',
				grants: {
					openings: { outputs: { listing: { scopes: { openings: { status: { eq: 'open' } } } } } },
					// a closed opening is no ref this visitor reads, so no write `where` is needed
					applications: { create: {} }
				},
				limits: { act: { rate: '3/h', per: 'ip' } }
			}
		},
		teams: { Rep: { policies: ['rep'] } },
		automations: {
			place: {
				description: 'Place an order',
				input: { title: { kind: 'text' }, customer: { kind: 'ref', to: 'customers' } },
				output: { kind: 'text' },
				policies: ['ordering']
			},
			revise: {
				description: 'Apply an observed extraction',
				input: { order: { kind: 'ref', to: 'orders' }, revision: { kind: 'int' } },
				output: { kind: 'text' },
				policies: ['ordering']
			},
			followup: {
				description: 'Follow up',
				input: { order: { kind: 'ref', to: 'orders' } },
				policies: ['ordering']
			}
		},

		mcp: {},
		custom_fields: {},
		agent: { skills: {} },
		apps: {
			careers: {
				title: 'Careers',
				description: 'Jobs',
				icon: 'x',
				audience: { public: ['applicant'] },
				pages: {}
			}
		}
	})
);
const OPEN = '0199a000-0000-4000-8000-00000000000a',
	CLOSED = '0199a000-0000-4000-8000-00000000000b';

const guest = program(`import { Effect } from 'effect';
import { ActRefused } from '@norbital-ai/bolt/errors';
export default {
 model: { orders: { bodies: {
  create: function* (changes, ctx) {
   for (const [row, { after: input }] of changes.entries())
    if (input.title === 'no') return yield* ctx.refuse('not that one', { field: 'title', row });
   return changes.map(({ set }) => set);
  }
 } } },
 automation: {
  place: { body: function* (input, ctx) {
   if (input.title === 'no') return yield* Effect.fail(new ActRefused({code:'refused', message:'not that one', field:'title', rule:'place'}));
   const o = yield* ctx.act({ 'orders.create': [{ title: input.title, region: 'north', customer: input.customer }] });
   const id = o.records[0].id;
   yield* ctx.act({ 'notes.create': [{ text: 'placed ' + input.title, order: id }] });
   const run = yield* ctx.schedule('followup', { order: id }, { at: { var: 'now + hours(1)' } });
   yield* ctx.notify({ to: [{ policy: 'rep' }], title: 'Placed' });
   const { orders } = yield* ctx.query({ orders: { fields: ['title'] } });
   return id + ':' + run.automation + ':' + orders.rows.length;
  } },
  revise: { body: function* (input, ctx) {
   yield* ctx.act({ 'orders.update': [{target:{id:input.order,revision:input.revision}, set:{title:'extracted'}}] });
   return 'extracted';
  } },
  followup: { body: function* (input) { return input.order; } }
 }
};`);
const fixture = (options: Extract<TestOptions, { artifact?: never }> = {}) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				guest: yield* guest,
				now: '2026-09-25T10:00:00.000Z',
				seed: {
					customers: [{ id: ACME, name: 'Acme' }],
					openings: [
						{ id: OPEN, title: 'Engineer', location: 'SG', description: 'Build', status: 'open' },
						{ id: CLOSED, title: 'Old', location: 'KL', description: 'Gone', status: 'closed' }
					]
				},
				...options
			})
		);
		return {
			t: Context.get(context, TestWorkspace),
			calls: Context.get(context, Callables),
			context,
			route: yield* route_fixture(context)
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
	act_reply(
		f.route,
		authority,
		/\.(?:create|update|delete|import|erase)$/.test(callable)
			? { acts: { [callable]: input }, issued_at: f.t.clock.now() }
			: { callable, input, issued_at: f.t.clock.now() },
		{
			...(options.key === undefined ? {} : { 'Idempotency-Key': options.key }),
		},
		options.address === undefined ? {} : { address: options.address }
	).pipe(
		Effect.flatMap((r) => {
			const failure = act_failure(r.outcome);
			return Option.isSome(failure) ? Effect.fail(failure.value) : Effect.succeed(r.outcome);
		})
	);
const answer = (f: Fixture, authority: Authority, a: readonly Json[]) =>
	q_reply(f.route, authority, { reads: [{ m: 'query', a }] }).pipe(Effect.map((r) => r.answers[0]));
const Pages = Schema.Record(
	Schema.String,
	Schema.Struct({
		rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
		next: Schema.optionalKey(Schema.NullOr(Schema.String))
	})
);
/** A read request's answer per root, its decode a fixture defect (a refused read stays a failure). */
const pages = (f: Fixture, authority: Authority, request: Json) =>
	answer(f, authority, [request]).pipe(
		Effect.flatMap((value) => Schema.decodeUnknownEffect(Pages)(value).pipe(Effect.orDie))
	);
/** Every row of one model the caller reads: a read request naming it alone. */
const read = (f: Fixture, authority: Authority, model: string, output?: string) =>
	pages(f, authority, { [model]: output === undefined ? {} : { output } }).pipe(
		Effect.map((answer) => answer[model] ?? { rows: [], next: null })
	);
/** One record the caller reads, or `null`. */
const get = (f: Fixture, authority: Authority, model: string, id: string) =>
	pages(f, authority, { [model]: { where: { id: { eq: id } } } }).pipe(
		Effect.map((answer) => answer[model]?.rows[0] ?? null)
	);
const start = (
	f: Fixture,
	authority: Authority,
	automation: string,
	input: Json,
	options: { id?: string } = {}
) =>
	act(f, authority, 'run', {
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
			name: 'act',
			acts,
			key,
			invocationId: key,
			issuedAt: f.t.clock.now(),
			authority,
			bindings: {
				now: f.t.clock.now(),
				today: f.t.clock.now().slice(0, 10),
				tz: 'UTC'
			},
			from: 'Client'
		})
		.pipe(
			Effect.flatMap(({ outcome }) => {
				const failure = act_failure(outcome);
				return Option.isSome(failure) ? Effect.fail(failure.value) : Effect.succeed(outcome);
			})
		);

class Fx extends Context.Service<Fx, Fixture>()('test/CallablesFixture') {}
// The suite's database fails its next serializable commits while armed: a replay, then a terminal conflict.
const serialization = { armed: false, failures: 0, attempts: new Array<DbBatch>() };
let customerReadFailure: DbError | undefined;
const interceptedDb = Layer.effect(
	TenantDb,
	Effect.gen(function* () {
		const inner = yield* TenantDb;
		return TenantDb.typed({
			read: (statements) =>
				Effect.suspend(() =>
					customerReadFailure !== undefined &&
					statements.some((s) => s.text.includes('"customers"'))
						? Effect.fail(customerReadFailure)
						: inner.read(statements)
				),
			transaction: (batch) =>
				Effect.suspend(() => {
					// the act's own batches (its orders and its recorded outcome); the member's bootstrap and audit pass through
					if (
						serialization.armed &&
						batch.statements.some(
							(s) => s.text.includes('"orders"') || s.text.includes('bolt_idem')
						)
					) {
						serialization.attempts.push(batch);
						if (serialization.failures++ < 2)
							return Effect.fail(DbError.make('40001', 'serialization fixture'));
					}
					return inner.transaction(batch);
				}),

			write: inner.write
		});
	})
).pipe(Layer.provide(TestDb.layer(manifest)));
const count = (f: Fixture, sql: string, params: Json[] = []) =>
	f.t.db
		.read([{ text: `SELECT count(*)::int AS n FROM ${sql}`, params }])
		.pipe(Effect.map((r) => Number(r[0]?.rows[0]?.['n'])));

// One workspace, its tests in order: each test reads only what it wrote (members are fresh per `t.member`), and the
// kit clock moves only in the last one.
layer(Layer.effect(Fx, fixture({ db: interceptedDb })), { excludeTestServices: true })(
	'callables',
	(it) => {
		it.effect('refuses a null update or delete row as invalid input', () =>
			Effect.gen(function* () {
				const f = yield* Fx;
				const authority = (yield* f.t.as(f.t.admin)).authority;
				for (const verb of ['update', 'delete']) {
					expect(yield* Effect.flip(act(f, authority, `orders.${verb}`, [null]))).toMatchObject({
						_tag: 'ActRefused',
						code: 'invalid_input',
						row: 0
					});
				}
			})
		);

		it.effect('reports a failed reference read when starting an automation', () =>
			Effect.gen(function* () {
				const f = yield* Fx;
				const now = f.t.clock.now();
				const outage = DbError.make('08006', 'customer reference read unavailable');
				customerReadFailure = outage;
				const result = yield* f.calls
					.start({
						automation: 'place',
						authority: (yield* f.t.as(f.t.member(['rep']))).authority,
						bindings: { now, today: now.slice(0, 10), tz: 'UTC' },
						runs: [{ id: uuidv7(Date.parse(now)), input: { title: 'Order', customer: ACME } }]
					})
					.pipe(
						Effect.result,
						Effect.ensuring(Effect.sync(() => void (customerReadFailure = undefined)))
					);
				expect(result).toMatchObject({ _tag: 'Failure', failure: outage });
			})
		);

		it.effect(
			'queued ctx.act retains its observed revision, and generated batches keep their per-item guards',
			() =>
				Effect.gen(function* () {
					const f = yield* Fx;
					const admin = yield* f.t.as(f.t.admin);
					const created = ok(
						yield* act(f, admin.authority, 'orders.create', [
							{ title: 'original', region: 'north', customer: ACME }
						])
					).records[0];
					if (created === undefined) throw new Error('Missing created order');
					const updated = ok(
						yield* act(f, admin.authority, 'orders.update', [
							{ target: created, set: { title: 'newer edit' } }
						])
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
					yield* f.t.run_due();
					expect(yield* run(f, stale)).toMatchObject({
						state: 'failed',
						error: { code: 'conflict' }
					});
					expect(
						yield* Effect.flip(
							batch(f, admin.authority, [
								{
									model: 'orders',
									verb: 'update',
									input: [{ target: created.id, set: { title: 'stale batch' } }],
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
								model: 'orders',
								verb: 'update',
								input: [{ target: created.id, set: { title: 'extracted' } }],
								observed: { [created.id]: updated.revision }
							}
						])
					).toMatchObject({ kind: 'committed' });
					expect(yield* get(f, admin.authority, 'orders', created.id)).toMatchObject({
						title: 'extracted',
						revision: updated.revision + 1
					});
				})
		);

		it.effect(
			'a late generated callback refusal commits no partial rows and a replay adds no business writes',
			() =>
				Effect.gen(function* () {
					const f = yield* Fx,
						t = f.t,
						rep = yield* t.as(t.member(['rep']));
					const orders = yield* count(f, 'orders'),
						notes = yield* count(f, 'notes');
					const operations: Batch = [
						{
							model: 'orders',
							verb: 'create',
							input: [{ title: 'accepted first', region: 'north', customer: ACME }]
						},
						{
							model: 'orders',
							verb: 'create',
							input: [{ title: 'no', region: 'north', customer: ACME }]
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
					const id = uuidv7(Date.parse(t.clock.now()));
					ok(yield* start(f, rep.authority, 'place', { title: 'no', customer: ACME }, { id }));
					expect((yield* run(f, id)).state).toBe('queued');
					yield* t.run_due();
					expect(yield* run(f, id)).toMatchObject({
						state: 'failed',
						error: { code: 'refused', message: 'not that one', field: 'title', rule: 'place' }
					});
					expect(yield* count(f, 'orders')).toBe(orders);
					expect(yield* count(f, 'notes')).toBe(notes);
				})
		);

		it.effect(
			'records a terminal serialization conflict after one generated batch replay and returns it on retry',
			() =>
				Effect.gen(function* () {
					const f = yield* Fx,
						rep = yield* f.t.as(f.t.member(['rep'])),
						{ attempts } = serialization;
					const operations: Batch = [
						{
							model: 'orders',
							verb: 'create',
							input: [{ title: 'bounded callable', region: 'north', customer: ACME }]
						}
					];
					const bounded = "orders WHERE title = 'bounded callable'";
					serialization.armed = true;
					const first = yield* Effect.flip(batch(f, rep.authority, operations, 'bounded-callable'));
					expect(first).toEqual(new ActConflict({ records: [] }));
					expect(attempts).toHaveLength(3);
					expect(attempts[1]?.statements).toEqual(attempts[0]?.statements);
					expect(yield* count(f, bounded)).toBe(0);
					attempts.length = 0;
					expect(
						yield* Effect.flip(batch(f, rep.authority, operations, 'bounded-callable'))
					).toEqual(first);
					// A native replay checks the persisted outcome in one batch without adding business rows.
					expect(attempts).toHaveLength(1);
					expect(yield* count(f, bounded)).toBe(0);
				}).pipe(Effect.ensuring(Effect.sync(() => void (serialization.armed = false))))
		);

		it.effect(
			'the client-minted id is the key: same input is the same run, other input key_reuse; a bulk start is one request',
			() =>
				Effect.gen(function* () {
					const f = yield* Fx,
						t = f.t;
					const rep = yield* t.as(t.member(['rep']));
					const order = present(ok(
						yield* act(f, rep.authority, 'orders.create', [
							{ title: 'x', region: 'north', customer: ACME }
						])
					).records[0]).id;
					const order2 = ok(
						yield* act(f, rep.authority, 'orders.create', [
							{ title: 'y', region: 'north', customer: ACME }
						])
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
					).toMatchObject({ _tag: 'ActRefused', code: 'key_reuse' });
					expect(yield* count(f, 'sys_run WHERE id = $1', [id])).toBe(1);
					// a bulk start queues one run per record in one request, and a retry of it is the same start
					const ids = [uuidv7(Date.parse(t.clock.now())), uuidv7(Date.parse(t.clock.now()))] as const;
					const bulk = {
						automation: 'followup',
						runs: [
							{ id: ids[0], input: { order } },
							{ id: ids[1], input: { order: order2.id } }
						]
					};
					expect(yield* act(f, rep.authority, 'run', bulk)).toEqual({
						kind: 'committed',
						output: { id: ids[0], automation: 'followup', ids },
						records: []
					});
					expect(yield* act(f, rep.authority, 'run', bulk)).toMatchObject({ kind: 'committed' });
					expect(
						yield* count(f, 'sys_run WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))', [
							[id, ...ids]
						])
					).toBe(3);
				})
		);

		// rule 38d on the same workspace: a public visitor of the careers app
		it.effect(
			'lists open roles through its narrow output only, applies to an open role, and nothing else',
			() =>
				Effect.gen(function* () {
					const f = yield* Fx,
						me = yield* f.t.visitor('careers');
					const open = (yield* read(f, me.authority, 'openings', 'listing')).rows;
					expect(open).toHaveLength(1);
					expect(open[0]).toMatchObject({
						id: OPEN,
						title: 'Engineer',
						location: 'SG',
						description: 'Build'
					});
					expect(open[0]).not.toHaveProperty('status');
					expect(yield* Effect.flip(read(f, me.authority, 'openings'))).toMatchObject({
						code: 'forbidden'
					});
					ok(
						yield* act(f, me.authority, 'applications.create', [
							{ opening: OPEN, name: 'Ada', email: 'ada@example.com' }
						])
					);
					expect(
						yield* Effect.flip(
							act(f, me.authority, 'applications.create', [
								{ opening: CLOSED, name: 'Ada', email: 'ada@example.com' }
							])
						)
					).toMatchObject({ _tag: 'ActRefused', code: 'not_found', field: 'opening' });
					expect(yield* Effect.flip(read(f, me.authority, 'applications'))).toMatchObject({
						code: 'forbidden'
					});
					expect(
						yield* Effect.flip(
							act(f, me.authority, 'applications.update', [{ target: { id: OPEN, revision: 1 }, set: {} }])
						)
					).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
				})
		);

		it.effect(
			'the 4th attempt in an hour from one IP is rate_limited, whatever the first three were; a new visitor id does not reset it',
			() =>
				Effect.gen(function* () {
					const f = yield* Fx;
					const attempt = (ip: string, input: Json) =>
						f.t.visitor('careers', { ip }).pipe(
							Effect.flatMap((me) => act(f, me.authority, 'applications.create', [input], { address: ip }))
						);
					for (let i = 0; i < 3; i++) {
						const input =
							i % 3 === 0
								? { opening: OPEN, name: `A${i}`, email: 'a@x.io' }
								: i % 3 === 1
									? { opening: CLOSED, name: 'A', email: 'a@x.io' }
									: { nope: true };
						const result = yield* Effect.result(attempt('198.51.100.1', input));
						expect(Result.isSuccess(result) ? result.success.kind : result.failure._tag).not.toBe(
							'pending_approval'
						);
					}
					expect(
						yield* Effect.flip(
							attempt('198.51.100.1', { opening: OPEN, name: 'Z', email: 'z@x.io' })
						)
					).toMatchObject({ _tag: 'ActRefused', code: 'rate_limited' });
					ok(yield* attempt('198.51.100.2', { opening: OPEN, name: 'Z', email: 'z@x.io' }));
				})
		);

		it.effect('uploads persist one sys_file row per client-minted id; a resend adds none', () =>
			Effect.gen(function* () {
				const f = yield* Fx,
					me = yield* f.t.visitor('careers');
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
				expect(yield* count(f, 'sys_file')).toBe(1);
				const { id: _id, ...otherFile } = file;
				expect(
					yield* Effect.flip(me.upload('applications.cv', { ...otherFile, mime: 'image/png' }))
				).toMatchObject({ _tag: 'ActRefused', code: 'invalid_input' });
				expect(yield* Effect.flip(me.upload('applications.name', file))).toMatchObject({
					_tag: 'ActRefused',
					code: 'forbidden'
				});
			})
		);
	}
);

describe('refusal messages by actor (rule 32)', () => {
	it('public and API-key actors receive codes only', () => {
		const no: Outcome = {
			kind: 'refused',
			code: 'refused',
			message: 'Shady is blocked',
			field: 'customer'
		};
		expect(for_actor(no, { kind: 'api_key', key: 'k' })).toEqual({
			kind: 'refused',
			code: 'refused',
			message: 'refused'
		});
		expect(
			for_actor(no, { kind: 'envoy', envoy: 'e', instance: 'c', sender: 's', member: null })
		).toEqual({ kind: 'refused', code: 'refused', message: 'refused' });
		expect(
			for_actor(no, {
				kind: 'member',
				id: 'u',
				email: null,
				phone: null,
				external: false,
				teams: [],
				team_path: [],
				admin: false,
				party: null
			})
		).toEqual(no);
	});
});
