import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { Callables, Approvals, RunHandlers } from '../src/engine/services.ts';
import { acquireEngine } from './effect-engine.ts';
import type { EngineManifest, GrantData } from '../src/engine/manifest.ts';
import type { TenantDbShape as TenantDb } from '../src/engine/db/tenant-db.ts';
import { dbError } from '../src/engine/db/wire.ts';
import type { PGlite } from '@electric-sql/pglite';
import type { Authority, Outcome } from '../src/engine/contracts.ts';
type Engine = Effect.Success<ReturnType<typeof acquireEngine>>;
import { Authorities } from '../src/engine/identity/actor.ts';
import { PgliteDb, Pristine } from '../src/node/db/pglite.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { NOW, TODAY } from './write-fixture.ts';
import { program } from './support/guest-fixture.ts';

const salesId = '0199a000-0000-7000-8000-000000000001',
	financeId = '0199a000-0000-7000-8000-000000000002';
const left = '0199a000-0000-7000-8000-000000000011',
	right = '0199a000-0000-7000-8000-000000000012';
const grant: GrantData = {
	read: true,
	update: { fields: ['note'], approval: true }
};
const manifest: EngineManifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		orders: {
			description: 'Order',
			label: 'title',
			fields: { title: { kind: 'text' }, note: { kind: 'text', optional: true } }
		}
	},
	relationships: {},
	collections: {
		orders: {
			read: { fields: 'all' },
			update: { input: { columns: ['note'] } },
			notify: true
		}
	},
	teams: { Sales: ['seller'], Finance: ['reviewer'] },
	policies: {
		seller: { description: 'Seller', grants: { orders: grant }, automations: ['followup'] },
		reviewer: { description: 'Reviewer', grants: { orders: { read: true } } }
	},
	automations: {
		followup: {
			description: 'Followup',
			on: { updated: 'orders', fields: ['note'], where: { note: { isNull: false } } },
			runAs: ['seller']
		}
	},
	integrations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
const guest = program(`export default {
 collection: { orders: { bodies: { notify: function*(event) {
  if(event.kind!=='write')return [];
  if(event.action!=='update'||event.records.length!==2)throw Error('Expected the complete committed batch');
  return [{to:[{user:'${salesId}'}],title:'Bundle committed'}];
 } } } },
 automation: { followup: { body: function*(){return null;} } },
 policy: { seller: { grants: { orders: { update: {
  approval: (_write,flow)=>flow.step('Finance',{teams:['Finance']})
 } } } } }
};`);
let pg: PGlite, db: TenantDb, e: Engine, sales: Authority, finance: Authority;
const exec = (text: string) => Effect.tryPromise({ try: () => pg.exec(text), catch: dbError });
const view = (...args: Parameters<ReturnType<typeof Approvals.of>['view']>) =>
	Context.get(e, Approvals)
		.view(...args)
		.pipe(Effect.map(Option.getOrNull));
const bindings = { now: NOW, today: TODAY, tz: 'UTC', params: {} };
const rows = (sql: string) =>
	Effect.map(db.read([{ text: sql, params: [] }]), (rows) => rows[0]?.rows ?? []);
const pending = (outcome: Outcome) => {
	if (outcome.kind !== 'pendingApproval') throw new Error(JSON.stringify(outcome));
	return outcome.requestId;
};
const submit = Effect.fn('Test.submitAtomicBatch')(function* () {
	const result = yield* Context.get(e, Callables).acts({
		name: 'orders.batch',
		acts: [
			{ collection: 'orders', verb: 'update', input: { target: left, set: { note: 'first' } } },
			{ collection: 'orders', verb: 'update', input: { target: right, set: { note: 'second' } } }
		],
		authority: sales,
		bindings,
		invocationId: 'bundle-invocation',
		key: 'bundle',
		issuedAt: NOW,
		from: 'Client'
	});
	if (result.error !== undefined) throw result.error;
	return result;
});
const notices = Effect.fn('Test.deliverBatchNotices')(function* () {
	const handler = yield* Context.get(e, RunHandlers).handler('bolt.notify');
	if (Option.isNone(handler)) throw new Error('Missing notification handler');
	const queued = yield* db.rows(Schema.Struct({ id: Schema.String, input: Schema.Json }), {
		text: "SELECT id,input FROM sys_run WHERE automation='bolt.notify' AND state='queued' ORDER BY id",
		params: []
	});
	for (const run of queued) {
		yield* handler.value(run.input, { id: run.id, starter: null });
		yield* handler.value(run.input, { id: run.id, starter: null });
		yield* db.write({ text: "UPDATE sys_run SET state='succeeded' WHERE id=$1", params: [run.id] });
	}
	return yield* rows('SELECT title FROM sys_notification');
});
const approve = (requestId: string) =>
	Context.get(e, Approvals).decide({
		requestId,
		decision: 'approve',
		authority: finance,
		now: NOW
	});
const fixture = Layer.effectDiscard(
	Effect.gen(function* () {
		pg = yield* PgliteDb.open();
		db = PgliteDb.make(pg);
		yield* applyPlan(db, yield* plan(null, manifest), { accept: true });
		yield* exec(
			`INSERT INTO sys_user(id,name,team) VALUES('${salesId}','Sales','Sales'),('${financeId}','Finance','Finance');INSERT INTO orders(id,title) VALUES('${left}','Left'),('${right}','Right');
			INSERT INTO bolt_history(collection,record,revision,op,cause,changes) SELECT 'orders',id,1,'create','seed',to_jsonb(o) FROM orders o`
		);
		const authorities = new Authorities(manifest, 'test');
		const seller = yield* authorities.member(db, salesId),
			reviewer = yield* authorities.member(db, financeId);
		if (seller === null || reviewer === null) throw new Error('Missing test actors');
		sales = seller;
		finance = reviewer;
		e = yield* acquireEngine(manifest, db, yield* guest);
	})
).pipe(Layer.provide(Pristine.layer));

it.effect(
	'one request holds the complete atomic batch and queues its effects once; approval keeps the writes',
	() =>
		Effect.gen(function* () {
			const result = yield* submit();
			const id = pending(result.outcome);
			expect(result.outcome.kind === 'pendingApproval' ? result.outcome.records : []).toHaveLength(
				2
			);
			expect(yield* rows('SELECT note FROM orders ORDER BY title')).toEqual([
				{ note: 'first' },
				{ note: 'second' }
			]);
			expect(yield* rows("SELECT automation FROM sys_run WHERE automation='followup'")).toEqual([
				{ automation: 'followup' }
			]);
			expect(yield* rows('SELECT title FROM sys_notification')).toEqual([]);
			expect(yield* notices()).toEqual([{ title: 'Bundle committed' }]);
			expect(
				yield* rows('SELECT jsonb_array_length(records) n, state FROM bolt_approvals')
			).toEqual([{ n: 2, state: 'Pending' }]);
			expect((yield* view(id, finance, () => Effect.succeed(true)))?.records).toHaveLength(2);
			expect((yield* submit()).outcome).toEqual(result.outcome);
			expect(yield* notices()).toHaveLength(1);
			expect(yield* approve(id)).toMatchObject({ kind: 'decided', status: 'Approved' });
			expect(yield* rows('SELECT note FROM orders ORDER BY title')).toEqual([
				{ note: 'first' },
				{ note: 'second' }
			]);
			expect(yield* approve(id)).toMatchObject({ kind: 'refused', code: 'invalidInput' });
			expect(
				yield* rows("SELECT automation FROM sys_run WHERE automation='followup'")
			).toHaveLength(1);
			expect(yield* notices()).toHaveLength(1);
		}).pipe(Effect.provide(fixture))
);
it.effect(
	'rejecting the batch restores both writes; its committed notification and queued followup stay',
	() =>
		Effect.gen(function* () {
			const id = pending((yield* submit()).outcome);
			expect(yield* notices()).toEqual([{ title: 'Bundle committed' }]);
			expect(
				yield* Context.get(e, Approvals).decide({
					requestId: id,
					decision: 'reject',
					reason: 'Rejected',
					authority: finance,
					now: NOW
				})
			).toMatchObject({ kind: 'decided', status: 'Rejected' });
			expect(yield* rows('SELECT note FROM orders ORDER BY title')).toEqual([
				{ note: null },
				{ note: null }
			]);
			expect(yield* rows("SELECT automation FROM sys_run WHERE automation='followup'")).toEqual([
				{ automation: 'followup' }
			]);
			expect(yield* notices()).toEqual([{ title: 'Bundle committed' }]);
			expect(
				yield* rows("SELECT count(*)::int n FROM bolt_history WHERE cause = 'restored'")
			).toEqual([{ n: 2 }]);
		}).pipe(Effect.provide(fixture))
);
it.effect('the requester cannot change the records its pending batch holds', () =>
	Effect.gen(function* () {
		const id = pending((yield* submit()).outcome);
		const again = yield* Context.get(e, Callables).acts({
			name: 'orders.batch',
			acts: [
				{ collection: 'orders', verb: 'update', input: { target: left, set: { note: 'again' } } }
			],
			authority: sales,
			bindings,
			invocationId: 'bundle-again',
			key: 'bundle-again',
			issuedAt: NOW,
			from: 'Client'
		});
		expect(again.outcome).toMatchObject({
			kind: 'refused',
			code: 'locked',
			data: { requestId: id }
		});
		expect(yield* rows("SELECT count(*)::int n FROM sys_run WHERE automation='followup'")).toEqual([
			{ n: 1 }
		]);
	}).pipe(Effect.provide(fixture))
);
it.effect('a batch of generated verbs opens one request over both writes', () =>
	Effect.gen(function* () {
		const result = yield* Context.get(e, Callables).acts({
			name: 'orders.batch',
			acts: [
				{ collection: 'orders', verb: 'update', input: { target: left, set: { note: 'one' } } },
				{ collection: 'orders', verb: 'update', input: { target: right, set: { note: 'two' } } }
			],
			authority: sales,
			bindings,
			invocationId: 'batch-invocation',
			key: 'batch',
			issuedAt: NOW,
			from: 'Client'
		});
		const id = pending(result.outcome);
		expect(yield* rows('SELECT note FROM orders ORDER BY title')).toEqual([
			{ note: 'one' },
			{ note: 'two' }
		]);
		expect(yield* approve(id)).toMatchObject({ kind: 'decided', status: 'Approved' });
		expect(yield* rows('SELECT note FROM orders ORDER BY title')).toEqual([
			{ note: 'one' },
			{ note: 'two' }
		]);
	}).pipe(Effect.provide(fixture))
);

it.effect('a refused item leaves every batch write, approval and queued effect absent', () =>
	Effect.gen(function* () {
		// the fixture's own raw inserts are audited too: the refusal must add nothing to that baseline
		const history = yield* rows('SELECT count(*)::int n FROM bolt_history');
		const result = yield* Context.get(e, Callables).acts({
			name: 'orders.batch',
			acts: [
				{
					collection: 'orders',
					verb: 'update',
					input: { target: left, set: { note: 'must roll back' } }
				},
				{
					collection: 'orders',
					verb: 'update',
					input: { target: '0199a000-0000-7000-8000-000000000099', set: { note: 'missing' } }
				}
			],
			authority: sales,
			bindings,
			invocationId: 'refused-batch',
			key: 'refused-batch',
			issuedAt: NOW,
			from: 'Client'
		});
		expect(result.outcome).toMatchObject({ kind: 'refused', code: 'notFound' });
		expect(result.captured).toEqual([]);
		expect(yield* rows('SELECT note FROM orders ORDER BY title')).toEqual([
			{ note: null },
			{ note: null }
		]);
		expect(yield* rows('SELECT id FROM bolt_approvals')).toEqual([]);
		expect(yield* rows('SELECT id FROM sys_run')).toEqual([]);
		expect(yield* rows('SELECT id FROM sys_notification')).toEqual([]);
		expect(yield* rows('SELECT count(*)::int n FROM bolt_history')).toEqual(history);
	}).pipe(Effect.provide(fixture))
);
