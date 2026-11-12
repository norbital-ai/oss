import { randomUUID } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import { afterAll } from 'vitest';
import { Context, Effect, Exit, Layer, Result, Schema, Scope } from 'effect';
import { decode_acts, parse_callable } from '../src/engine/callables/index.ts';
import { Approvals, Callables } from '../src/engine/services.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { manifest as base } from './write-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const inputs = (acts: Readonly<Record<string, Json>>) => acts;
const manifest: EngineManifest = {
	...base,
	models: {
		customers: {
			description: 'Customers',
			record_label: 'record.name',
			key: ['name'],
			unique: [{ fields: ['name'], name: 'customers_name_key', import_key: true }],
			fields: { name: { kind: 'text' }, note: { kind: 'text', optional: true } }
		},
		orders: {
			description: 'Orders',
			record_label: 'record.title',
			fields: { title: { kind: 'text' } }
		}
	},
	relationships: {},
	exposures: {
		customers: {
			outputs: { default: { customers: { fields: 'all' } } },
			create: { columns: { customers: ['name', 'note'] } },
			update: { columns: { customers: ['name', 'note'] } }
		},
		orders: {
			outputs: { default: { orders: { fields: 'all' } } },
			create: { columns: { orders: ['title'] } }
		}
	},
	policies: {
		writer: {
			description: 'Writes both models',
			capabilities: { automations: ['followup'] },
			grants: {
				customers: { outputs: { default: {} }, create: {}, update: {} },
				orders: { outputs: { default: {} }, create: {} }
			}
		},
		restricted: {
			description: 'Writes customers only',
			grants: {
				customers: { outputs: { default: {} }, create: {}, update: {} },
				orders: { outputs: { default: {} } }
			}
		},
		requester: {
			description: 'Requests customer creation',
			grants: { customers: { outputs: { default: {} }, create: { verdict: true } } }
		},
		reviewer: {
			description: 'Reviews requests',
			grants: { customers: { outputs: { default: {} } } }
		}
	},
	teams: { Requesters: { policies: ['requester'] }, Reviewers: { policies: ['reviewer'] } },
	automations: {
		followup: {
			description: 'Checked batch in a run',
			input: { operations: { kind: 'json' } },
			output: { kind: 'json' },
			policies: ['writer']
		}
	}
};
const guest = program(`import { Effect } from 'effect';
export default {
 automation:{
  followup:{body:function*(input,ctx){return yield* ctx.act(input.operations);}}
 },
 policy:{requester:{grants:{customers:{create:{verdict:function*(_rows,ctx){return ctx.approve({ steps: [{ name: 'Review', teams: ['Reviewers'] }] });}}}}}}
};`);
// One workspace for the file: the second case reads only the row it names.
const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const fixture = Effect.gen(function* () {
	const context = yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* guest }));
	const t = Context.get(context, TestWorkspace);
	const writer = t.member(['writer']);
	const restricted = t.member(['restricted']);
	const requester = t.member(['requester'], { teams: ['Requesters'], team_path: ['Requesters'] });
	const reviewer = t.member(['reviewer'], { teams: ['Reviewers'], team_path: ['Reviewers'] });
	yield* (yield* t.as(t.admin)).query({ customers: {} });
	const calls = Context.get(context, Callables);
	const writerAuthority = (yield* t.as(writer)).authority;
	const bindings = () => ({
		now: t.clock.now(),
		today: t.clock.now().slice(0, 10),
		tz: 'UTC'
	});
	const batch = (acts: Parameters<typeof calls.acts>[0]['acts']) => {
		const key = randomUUID();
		return calls.acts({
			name: 'act',
			acts,
			authority: writerAuthority,
			bindings: bindings(),
			key,
			invocationId: key,
			issuedAt: t.clock.now(),
			from: 'Server'
		});
	};
	const count = (model: 'customers' | 'orders') =>
		t.db.value(Schema.Number, {
			text: `SELECT count(*)::int FROM ${model}`,
			params: []
		});
	// Malformed dynamic batches enter through actual guest JSON, rather than bypassing the typed DSL.
	const dynamic_json = (operations: Json) =>
		Effect.gen(function* () {
			const id = randomUUID();
			expect(
				yield* calls.start({
					automation: 'followup',
					runs: [{ id, input: { operations } }],
					authority: (yield* t.as(writer)).authority,
					bindings: bindings()
				})
			).toMatchObject({ kind: 'committed' });
			yield* t.run_due();
			return yield* t.db.one(
				Schema.Struct({ state: Schema.String, error: Schema.NullOr(Schema.Json) }),
				{
					text: 'select state,error from sys_run where id=$1',
					params: [id]
				}
			);
		});
	return {
		context,
		t,
		writer,
		restricted,
		requester,
		reviewer,
		calls,
		bindings,
		batch,
		count,
		dynamic_json
	};
}).pipe(Scope.provide(fileScope), Effect.cached, Effect.runSync);

it.effect('the atomic map accepts generated writes and rejects retired batch shapes', () =>
 Effect.gen(function* () {
  for (const verb of ['create', 'update', 'delete', 'import', 'erase'])
   expect(Result.isSuccess(parse_callable(`customers.${verb}`, manifest))).toBe(true);
  for (const name of ['customers.upsert', 'customers.unknown', 'customers.sync.sheet'])
   expect(Result.isSuccess(parse_callable(name, manifest))).toBe(false);
  expect(yield* Effect.flip(decode_acts(manifest, [{ callable: 'customers.create', input: [] }]))).toMatchObject({ code: 'invalid_input' });
  expect(yield* Effect.flip(decode_acts(manifest, { followup: {} }))).toMatchObject({ code: 'invalid_input' });
 })
);

it.live(
	'native and queued atomic maps retain validation, authority, import modes and revision conflicts',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture;
				const committed = yield* f.batch([
					{ model: 'customers', verb: 'create', input: [{ name: 'First' }] },
					{ model: 'orders', verb: 'create', input: [{ title: 'First order' }] }
				]);
				expect(committed.outcome).toMatchObject({ kind: 'committed', output: [null, null] });
				expect(yield* f.count('customers')).toBe(1);
				expect(yield* f.count('orders')).toBe(1);
				const malformed = yield* f.batch([
					{ model: 'customers', verb: 'create', input: [{ name: 'Must roll back' }] },
					{ model: 'orders', verb: 'create', input: [{}] }
				]);
				expect(malformed.outcome.kind).toBe('refused');
				expect(yield* f.count('customers')).toBe(1);
				expect(yield* f.count('orders')).toBe(1);
				const denied = yield* Effect.flip(
					(yield* f.t.body_acts(f.restricted))(inputs({
						'customers.create': [{ name: 'Also roll back' }],
						'orders.create': [{ title: 'Forbidden' }]
					}))
				);
				expect(denied).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
				expect(yield* f.count('customers')).toBe(1);
				// Retired operation lists fail at the guest JSON boundary.
				expect(yield* f.dynamic_json([{ callable: 'customers.import', input: {} }])).toMatchObject({
					_tag: 'Some',
					value: { state: 'failed', error: { code: 'invalid_input' } }
				});
				expect(yield* f.count('customers')).toBe(1);
				const id = randomUUID();
				expect(
					yield* f.calls.start({
						automation: 'followup',
						runs: [
							{
								id,
								input: {
									operations: { 'customers.create': [{ name: 'From a run' }] }
								}
							}
						],
						authority: (yield* f.t.as(f.writer)).authority,
						bindings: f.bindings()
					})
				).toMatchObject({ kind: 'committed' });
				yield* f.t.run_due();
				expect(yield* f.count('customers')).toBe(2);
				expect(
					yield* f.t.db.value(Schema.Json, {
						text: 'SELECT output FROM sys_run WHERE id = $1',
						params: [id]
					})
				).toMatchObject({ kind: 'committed', output: { 'customers.create': null } });
				const created = yield* f.batch([
                    { model: 'customers', verb: 'create', input: [{ name: 'Second', note: 'Original' }] }
                ]);
                if (created.outcome.kind !== 'committed') throw new Error('The customer did not commit.');
                const record = created.outcome.records[0];
                if (record === undefined) throw new Error('The batch returned no customer.');
                const acts = yield* f.t.body_acts(f.writer);
                const atomic = (input: Readonly<Record<string, Json>>) => acts(input);
                expect(yield* atomic({ 'customers.import': {
                    rows: [{ name: 'Second', note: 'Updated' }], on_conflict: 'update'
                } })).toMatchObject({ kind: 'committed' });
                expect(yield* atomic({ 'customers.import': {
                    rows: [{ name: 'Second', note: 'Ignored' }], on_conflict: 'keep'
                } })).toMatchObject({ kind: 'committed' });
                expect(yield* f.dynamic_json({ 'customers.upsert': [{ name: 'Second' }] })).toMatchObject({
                    _tag: 'Some', value: { state: 'failed', error: { code: 'unknown_callable' } }
                });
                expect(yield* Effect.flip(atomic({ 'customers.update': [{
                    target: { id: record.id, revision: 1 }, set: { note: 'Stale' }
                }] }))).toMatchObject({ _tag: 'ActConflict' });
				expect(
					yield* f.t.db.value(Schema.String, {
						text: 'select note from customers where id=$1::uuid',
						params: [record.id]
					})
				).toBe('Updated');
				expect(yield* f.count('customers')).toBe(3);
			})
		)
);

it.live(
	'a checked batch reports held success until review, and rejection rolls back provisional rows',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture;
				const checked = yield* (yield* f.t.body_acts(f.requester))(inputs({ 'customers.create': [{ name: 'Held checked' }] }));
				for (const result of [checked]) {
					expect(result.kind).toBe('pending_approval');
					expect('output' in result).toBe(false);
					if (result.kind !== 'pending_approval') throw new Error('The batch bypassed review.');
					expect(
						yield* f.t.db.value(Schema.String, {
							text: 'SELECT state FROM bolt_approvals WHERE id = $1',
							params: [result.request_id]
						})
					).toBe('Pending');
					expect(
						yield* Context.get(f.context, Approvals).decide({
							request_id: result.request_id,
							decision: 'reject',
							reason: 'Not approved',
							authority: (yield* f.t.as(f.reviewer)).authority,
							now: f.t.clock.now()
						})
					).toMatchObject({ kind: 'decided', status: 'Rejected' });
				}
				expect(
					yield* f.t.db.value(Schema.Number, {
						text: `SELECT count(*)::int FROM customers WHERE name = 'Held checked'`,
						params: []
					})
				).toBe(0);
			})
		)
);
