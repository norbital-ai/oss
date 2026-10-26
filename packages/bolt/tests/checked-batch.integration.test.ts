import { randomUUID } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import { isBatchCallable, parseCallable } from '../src/engine/callables/index.ts';
import { Approvals, Callables } from '../src/engine/services.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { manifest as base } from './write-fixture.ts';
import { program } from './support/guest-fixture.ts';

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
	collections: {
		customers: {
			read: { fields: 'all' },
			create: { input: { columns: ['name', 'note'] } },
			update: { input: { columns: ['name', 'note'] } }
		},
		orders: { read: { fields: 'all' }, create: { input: { columns: ['title'] } } }
	},
	policies: {
		writer: {
			description: 'Writes both models',
			automations: ['followup', 'refusal'],
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
			grants: { customers: { read: true, create: { approval: true } } }
		},
		reviewer: { description: 'Reviews requests', grants: { customers: { read: true } } }
	},
	teams: { Requesters: ['requester'], Reviewers: ['reviewer'] },
	automations: {
		followup: {
			description: 'Checked batch in a run',
			input: { operations: { kind: 'json' } },
			runAs: 'trigger'
		},
		refusal: { description: 'Keep native refusal metadata', input: {}, runAs: 'trigger' }
	}
};
const guest = program(`import { Effect } from 'effect';
import { ActRefused } from '@norbital-ai/bolt/errors';
export default {
 automation:{
  followup:{body:function*(input,ctx){return yield* ctx.act.checked(input.operations);}},
  refusal:{body:function*(){return yield* Effect.fail(new ActRefused({
   code:'forbidden',message:'Native refusal details',field:'name',row:1,rows:[1,3],
   rule:'customers.checked',data:{requestId:'0199a000-0000-7000-8000-000000000099'}
  }));}}
 },
 policy:{requester:{grants:{customers:{create:{approval:(_write,flow)=>flow.step('Review',{teams:['Reviewers']})}}}}}
};`);
const fixture = Effect.gen(function* () {
	const context = yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* guest }));
	const t = Context.get(context, TestWorkspace);
	const writer = t.member(['writer']);
	const restricted = t.member(['restricted']);
	const requester = t.member(['requester'], { teams: ['Requesters'], teamPath: ['Requesters'] });
	const reviewer = t.member(['reviewer'], { teams: ['Reviewers'], teamPath: ['Reviewers'] });
	yield* t.as(t.admin).query('customers', { all: true });
	const calls = Context.get(context, Callables);
	const bindings = () => ({
		now: t.clock.now(),
		today: t.clock.now().slice(0, 10),
		tz: 'UTC',
		params: {}
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
});

it('batch admission accepts exactly the four generated verbs', () => {
	for (const verb of ['create', 'update', 'upsert', 'delete'] as const)
		expect(isBatchCallable({ _tag: 'Verb', collection: 'customers', verb })).toBe(true);
	for (const verb of ['import', 'erase'] as const)
		expect(isBatchCallable({ _tag: 'Verb', collection: 'customers', verb })).toBe(false);
	expect(Result.isSuccess(parseCallable('customers.unknown', manifest))).toBe(false);
	expect(isBatchCallable({ _tag: 'Automation', automation: 'followup' })).toBe(false);
	expect(isBatchCallable({ _tag: 'Sync', collection: 'customers', sync: 'sheet' })).toBe(false);
});

it.live('native and queued checked batches use validation, authority and one atomic commit', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const f = yield* fixture;
			const committed = yield* f.batch([
				{ collection: 'customers', verb: 'create', input: { name: 'First' } },
				{ collection: 'orders', verb: 'create', input: { title: 'First order' } }
			]);
			expect(committed.outcome).toMatchObject({ kind: 'committed', output: [null, null] });
			expect(yield* f.count('customers')).toBe(1);
			expect(yield* f.count('orders')).toBe(1);
			const malformed = yield* f.batch([
				{ collection: 'customers', verb: 'create', input: { name: 'Must roll back' } },
				{ collection: 'orders', verb: 'create', input: {} }
			]);
			expect(malformed.outcome.kind).toBe('refused');
			expect(yield* f.count('customers')).toBe(1);
			expect(yield* f.count('orders')).toBe(1);
			const denied = yield* Effect.flip(
				f.t.bodyActs(f.restricted).checked([
					{ callable: 'customers.create', input: { name: 'Also roll back' } },
					{ callable: 'orders.create', input: { title: 'Forbidden' } }
				])
			);
			expect(denied).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
			expect(yield* f.count('customers')).toBe(1);
			for (const callable of ['customers.unknown', 'customers.import', 'customers.erase']) {
				const refused = yield* f.checkedJson([{ callable, input: {} }]);
				expect(refused).toMatchObject({
					_tag: 'Some',
					value: {
						state: 'failed',
						error: { code: callable === 'customers.unknown' ? 'unknownCallable' : 'invalidInput' }
					}
				});
				expect(yield* f.count('customers')).toBe(1);
			}
			const id = randomUUID();
			expect(
				yield* f.calls.start({
					automation: 'followup',
					runs: [
						{
							id,
							input: {
								operations: [{ callable: 'customers.create', input: { name: 'From a run' } }]
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
		})
	)
);

it.live('checked batch items require their own upsert mode and retain observed revisions', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const f = yield* fixture;
			const created = yield* f.batch([
				{ collection: 'customers', verb: 'create', input: { name: 'First', note: 'Original' } }
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
						input: { name: 'First', note: 'Updated' },
						onConflict: 'update'
					}
				])
			).toMatchObject({ kind: 'committed' });
			expect(
				yield* checked([
					{
						callable: 'customers.upsert',
						input: { name: 'First', note: 'Ignored' },
						onConflict: 'keep'
					}
				])
			).toMatchObject({ kind: 'committed' });
			for (const operation of [
				{ callable: 'customers.upsert', input: { name: 'First', note: 'Missing mode' } },
				{ callable: 'customers.create', input: { name: 'Second' }, onConflict: 'update' }
			]) {
				expect(yield* f.checkedJson([operation])).toMatchObject({
					_tag: 'Some',
					value: { state: 'failed', error: { code: 'invalidInput' } }
				});
			}
			expect(
				yield* Effect.flip(
					checked([
						{
							callable: 'customers.update',
							input: { target: record.id, set: { note: 'Stale' } },
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
			expect(yield* f.count('customers')).toBe(1);
		})
	)
);

it.live('a queued automation preserves every native guest refusal detail', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const f = yield* fixture;
			const id = randomUUID();
			expect(
				yield* f.calls.start({
					automation: 'refusal',
					runs: [{ id, input: {} }],
					authority: f.t.as(f.writer).authority,
					bindings: f.bindings()
				})
			).toMatchObject({ kind: 'committed' });
			yield* f.t.runDue();
			expect(
				yield* f.t.db.value(Schema.String, {
					text: 'select state from sys_run where id=$1',
					params: [id]
				})
			).toBe('failed');
			expect(
				yield* f.t.db.value(Schema.Json, {
					text: 'select error from sys_run where id=$1',
					params: [id]
				})
			).toEqual({
				code: 'forbidden',
				message: 'Native refusal details',
				field: 'name',
				row: 1,
				rows: [1, 3],
				rule: 'customers.checked',
				data: { requestId: '0199a000-0000-7000-8000-000000000099' }
			});
			expect(yield* f.count('customers')).toBe(0);
		})
	)
);

it.live(
	'literal and checked batches report held success until review, and rejection rolls back provisional rows',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture;
				const literal = yield* f.t
					.bodyActs(f.requester)
					.many([{ callable: 'customers.create', input: { name: 'Held literal' } }]);
				const checked = yield* f.t
					.bodyActs(f.requester)
					.checked([{ callable: 'customers.create', input: { name: 'Held checked' } }]);
				for (const result of [literal, checked]) {
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
				expect(yield* f.count('customers')).toBe(0);
			})
		)
);
