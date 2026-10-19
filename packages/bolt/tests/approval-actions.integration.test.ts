import { afterEach, beforeEach, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option } from 'effect';
import { Writes, Callables, Approvals } from '../src/engine/services.ts';
import { acquireEngine } from './effect-engine.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import {
	TenantDb as TenantDbService,
	type TenantDbShape as TenantDb
} from '../src/engine/db/tenant-db.ts';
import { dbError } from '../src/engine/db/wire.ts';
import type { PGlite } from '@electric-sql/pglite';
import type { Authority, Outcome } from '../src/engine/contracts.ts';
type Engine = Effect.Success<ReturnType<typeof acquireEngine>>;
import { Authorities } from '../src/engine/identity/actor.ts';
import { PgliteDb, Pristine } from '../src/engine/db/pglite.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { NOW, TODAY } from './write-fixture.ts';
import { program } from './support/guest-fixture.ts';

const salesId = '0199a000-0000-7000-8000-000000000001',
	financeId = '0199a000-0000-7000-8000-000000000002';
const left = '0199a000-0000-7000-8000-000000000011',
	right = '0199a000-0000-7000-8000-000000000012';
const grant = {
	read: true,
	actions: ['bundle'],
	approval: { update: [{ fields: ['note'], steps: [['Finance']] }] }
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
			actions: {
				bundle: {
					description: 'Update two orders',
					input: { left: { kind: 'id', of: 'orders' }, right: { kind: 'id', of: 'orders' } },
					output: { kind: 'object', fields: { done: { kind: 'bool' } } }
				}
			}
		}
	},
	teams: { Sales: ['seller'], Finance: ['reviewer'] },
	policies: {
		seller: { description: 'Seller', grants: { orders: grant }, automations: ['followup'] },
		reviewer: { description: 'Reviewer', grants: { orders: { read: true } } }
	},
	automations: {
		followup: { description: 'Followup', input: { count: { kind: 'int' } }, runAs: ['seller'] }
	},
	integrations: {},
	pipelines: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
const guest = (second = 'second') =>
	program(`export default {collection:{orders:{bodies:{actions:{bundle:function*(input,ctx){
 yield* ctx.act('orders.update',{target:input.left,set:{note:'first'}});
 yield* ctx.act('orders.update',{target:input.right,set:{note:${JSON.stringify(second)}}});
 yield* ctx.schedule('followup',{count:2});
 yield* ctx.notify({to:[{user:ctx.actor.id}],title:'Bundle committed'});
 return {done:true};
}}}}}};`);
let pg: PGlite, db: TenantDb, e: Engine, sales: Authority, finance: Authority;
const query = (...args: Parameters<PGlite['query']>) =>
	Effect.tryPromise({ try: () => pg.query(...args), catch: dbError });
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
const action = Effect.fn('Test.body')(function* () {
	const result = yield* Context.get(e, Callables).action({
		collection: 'orders',
		action: 'bundle',
		input: { left, right },
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
const approve = (requestId: string) =>
	Context.get(e, Approvals).process({
		requestId,
		status: 'APPROVED',
		authority: finance,
		now: NOW
	});
const fixture = Layer.effectDiscard(
	Effect.gen(function* () {
		pg = yield* PgliteDb.open();
		db = PgliteDb.make(pg);
		yield* applyPlan(db, plan(null, manifest), { accept: true });
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
		e = yield* acquireEngine(manifest, db, yield* guest());
	})
).pipe(Layer.provide(Pristine.layer));

it.effect(
	'one request holds the complete action: its writes and queued effects commit at once, approval keeps them',
	() =>
		Effect.gen(function* () {
			const result = yield* action();
			const id = pending(result.outcome);
			expect(result.outcome.kind === 'pendingApproval' ? result.outcome.records : []).toHaveLength(
				2
			);
			expect(yield* rows('SELECT note FROM orders ORDER BY title')).toEqual([
				{ note: 'first' },
				{ note: 'second' }
			]);
			expect(yield* rows('SELECT automation FROM sys_run')).toEqual([{ automation: 'followup' }]);
			expect(yield* rows('SELECT title FROM sys_notification')).toEqual([
				{ title: 'Bundle committed' }
			]);
			expect(
				yield* rows('SELECT jsonb_array_length(records) n, state FROM bolt_approvals')
			).toEqual([{ n: 2, state: 'Pending' }]);
			expect((yield* view(id, finance, () => Effect.succeed(true)))?.records).toHaveLength(2);
			expect(yield* approve(id)).toMatchObject({ kind: 'decided', status: 'APPROVED' });
			expect(yield* rows('SELECT note FROM orders ORDER BY title')).toEqual([
				{ note: 'first' },
				{ note: 'second' }
			]);
			expect(yield* approve(id)).toMatchObject({ kind: 'refused', code: 'invalidInput' });
			expect(yield* rows('SELECT automation FROM sys_run')).toHaveLength(1);
			expect(yield* rows('SELECT title FROM sys_notification')).toHaveLength(1);
		}).pipe(Effect.provide(fixture))
);
it.effect('rejecting the action rolls back both writes; its committed side effects stay', () =>
	Effect.gen(function* () {
		const id = pending((yield* action()).outcome);
		expect(
			yield* Context.get(e, Approvals).process({
				requestId: id,
				status: 'REJECTED',
				authority: finance,
				now: NOW
			})
		).toMatchObject({ kind: 'decided', status: 'REJECTED' });
		expect(yield* rows('SELECT note FROM orders ORDER BY title')).toEqual([
			{ note: null },
			{ note: null }
		]);
		expect(yield* rows('SELECT automation FROM sys_run')).toEqual([{ automation: 'followup' }]);
		expect(
			yield* rows("SELECT count(*)::int n FROM bolt_history WHERE cause = 'restored'")
		).toEqual([{ n: 2 }]);
	}).pipe(Effect.provide(fixture))
);
it.effect('the requester cannot change the records its pending action holds', () =>
	Effect.gen(function* () {
		const id = pending((yield* action()).outcome);
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
		expect(yield* rows('SELECT count(*)::int n FROM sys_run')).toEqual([{ n: 1 }]);
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
		expect(yield* approve(id)).toMatchObject({ kind: 'decided', status: 'APPROVED' });
		expect(yield* rows('SELECT note FROM orders ORDER BY title')).toEqual([
			{ note: 'one' },
			{ note: 'two' }
		]);
	}).pipe(Effect.provide(fixture))
);
