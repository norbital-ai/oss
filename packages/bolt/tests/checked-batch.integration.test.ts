import { randomUUID } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import { afterAll } from 'vitest';
import { Context, Effect, Exit, Layer, Result, Schema, Scope } from 'effect';
import { isBatchCallable, parseCallable } from '../src/engine/callables/index.ts';
import { Approvals, Callables } from '../src/engine/services.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { manifest as base } from './write-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const manifest: EngineManifest = {
	...base,
	models: {
		customers: {
			description: 'Customers',
			label: 'name',
			key: ['name'],
			fields: { name: { kind: 'text' }, note: { kind: 'text', optional: true } }
		},
		orders: { description: 'Orders', label: 'title', fields: { title: { kind: 'text' } } }
	},
	relationships: {},
	exposures: {
		customers: {
			read: { customers: { fields: 'all' } },
			create: { columns: { customers: ['name', 'note'] } },
			update: { columns: { customers: ['name', 'note'] } }
		},
		orders: { read: { orders: { fields: 'all' } }, create: { columns: { orders: ['title'] } } }
	},
	policies: {
		writer: {
			description: 'Writes both models',
			automations: ['followup'],
			grants: {
				customers: { read: true, create: true, update: true },
				orders: { read: true, create: true }
			}
		},
		restricted: {
			description: 'Writes customers only',
			grants: {
				customers: { read: true, create: true, update: true },
				orders: { read: true }
			}
		},
		requester: {
			description: 'Requests customer creation',
			grants: { customers: { read: true, create: { check: true } } }
		},
		reviewer: { description: 'Reviews requests', grants: { customers: { read: true } } }
	},
	teams: { Requesters: ['requester'], Reviewers: ['reviewer'] },
	automations: {
		followup: {
			description: 'Checked batch in a run',
			input: { operations: { kind: 'json' } },
			policies: ['writer']
		}
	}
};
const guest = program(`import { Effect } from 'effect';
export default {
 automation:{
  followup:{body:function*(input,ctx){return yield* ctx.act.checked(input.operations);}}
 },
 policy:{requester:{grants:{customers:{create:{check:function*(_rows,ctx){return ctx.approve((flow)=>flow.step('Review',{teams:['Reviewers']}));}}}}}}
};`);
// One workspace for the file: the second case reads only the row it names.
const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const fixture = Effect.gen(function* () {
	const context = yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* guest }));
	const t = Context.get(context, TestWorkspace);
	const writer = t.member(['writer']);
	const restricted = t.member(['restricted']);
	const requester = t.member(['requester'], { teams: ['Requesters'], teamPath: ['Requesters'] });
	const reviewer = t.member(['reviewer'], { teams: ['Reviewers'], teamPath: ['Reviewers'] });
	yield* t.as(t.admin).query({ customers: {} });
	const calls = Context.get(context, Callables);
	const bindings = () => ({
		now: t.clock.now(),
		today: t.clock.now().slice(0, 10),
		tz: 'UTC'
	});
	const batch = (acts: Parameters<typeof calls.acts>[0]['acts']) => {
		const key = randomUUID();
		return calls.acts({
			name: 'act.many',
			acts,
			authority: t.as(writer).authority,
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
	const checkedJson = (operations: Json) =>
		Effect.gen(function* () {
			const id = randomUUID();
			expect(
				yield* calls.start({
					automation: 'followup',
					runs: [{ id, input: { operations } }],
					authority: t.as(writer).authority,
					bindings: bindings()
				})
			).toMatchObject({ kind: 'committed' });
			yield* t.runDue();
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
		checkedJson
	};
}).pipe(Scope.provide(fileScope), Effect.cached, Effect.runSync);

it('batch admission accepts exactly the four generated verbs', () => {
	for (const verb of ['create', 'update', 'upsert', 'delete'] as const)
		expect(isBatchCallable({ _tag: 'Verb', model: 'customers', verb })).toBe(true);
	for (const verb of ['import', 'erase'] as const)
		expect(isBatchCallable({ _tag: 'Verb', model: 'customers', verb })).toBe(false);
	expect(Result.isSuccess(parseCallable('customers.unknown', manifest))).toBe(false);
	expect(isBatchCallable({ _tag: 'Automation', automation: 'followup' })).toBe(false);
	expect(isBatchCallable({ _tag: 'Sync', model: 'customers', sync: 'sheet' })).toBe(false);
});

it.live(
	'native and queued checked batches use validation, authority, per-item upsert modes and observed revisions, and one atomic commit',
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
					f.t.bodyActs(f.restricted).checked([
						{ callable: 'customers.create', input: [{ name: 'Also roll back' }] },
						{ callable: 'orders.create', input: [{ title: 'Forbidden' }] }
					])
				);
				expect(denied).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
				expect(yield* f.count('customers')).toBe(1);
				// a verb outside the four generated ones is refused through guest JSON (admission: the unit test above)
				expect(yield* f.checkedJson([{ callable: 'customers.import', input: {} }])).toMatchObject({
					_tag: 'Some',
					value: { state: 'failed', error: { code: 'invalidInput' } }
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
									operations: [{ callable: 'customers.create', input: [{ name: 'From a run' }] }]
								}
							}
						],
						authority: f.t.as(f.writer).authority,
						bindings: f.bindings()
					})
				).toMatchObject({ kind: 'committed' });
				yield* f.t.runDue();
				expect(yield* f.count('customers')).toBe(2);
				expect(
					yield* f.t.db.value(Schema.Json, {
						text: 'SELECT output FROM sys_run WHERE id = $1',
						params: [id]
					})
				).toMatchObject({ kind: 'committed', output: [null] });
				// each upsert item names its own mode; an update item keeps its observed revision
				const created = yield* f.batch([
					{ model: 'customers', verb: 'create', input: [{ name: 'Second', note: 'Original' }] }
				]);
				if (created.outcome.kind !== 'committed')
					throw new Error('The batch fixture did not commit.');
				const record = created.outcome.records[0];
				if (record === undefined) throw new Error('The batch fixture returned no customer.');
				const checked = f.t.bodyActs(f.writer).checked;
				expect(
					yield* checked([
						{
							callable: 'customers.upsert',
							input: [{ name: 'Second', note: 'Updated' }],
							onConflict: 'update'
						}
					])
				).toMatchObject({ kind: 'committed' });
				expect(
					yield* checked([
						{
							callable: 'customers.upsert',
							input: [{ name: 'Second', note: 'Ignored' }],
							onConflict: 'keep'
						}
					])
				).toMatchObject({ kind: 'committed' });
				expect(
					yield* f.checkedJson([
						{ callable: 'customers.upsert', input: [{ name: 'Second', note: 'Missing mode' }] }
					])
				).toMatchObject({
					_tag: 'Some',
					value: { state: 'failed', error: { code: 'invalidInput' } }
				});
				expect(
					yield* Effect.flip(
						checked([
							{
								callable: 'customers.update',
								input: [{ target: record.id, set: { note: 'Stale' } }],
								observed: { [record.id]: 1 }
							}
						])
					)
				).toMatchObject({ _tag: 'ActConflict' });
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
				const checked = yield* f.t
					.bodyActs(f.requester)
					.checked([{ callable: 'customers.create', input: [{ name: 'Held checked' }] }]);
				for (const result of [checked]) {
					expect(result.kind).toBe('pendingApproval');
					expect('output' in result).toBe(false);
					if (result.kind !== 'pendingApproval') throw new Error('The batch bypassed review.');
					expect(
						yield* f.t.db.value(Schema.String, {
							text: 'SELECT state FROM bolt_approvals WHERE id = $1',
							params: [result.requestId]
						})
					).toBe('Pending');
					expect(
						yield* Context.get(f.context, Approvals).decide({
							requestId: result.requestId,
							decision: 'reject',
							reason: 'Not approved',
							authority: f.t.as(f.reviewer).authority,
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
