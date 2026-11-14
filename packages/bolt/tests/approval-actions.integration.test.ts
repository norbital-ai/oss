import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { Callables, Approvals, Runs } from '../src/engine/services.ts';
import { acquire_engine } from './effect-engine.ts';
import type { EngineManifest, GrantData } from '../src/engine/manifest.ts';
import { TenantDb, type TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { db_error } from '@norbital-ai/host-api';
import type { PGlite } from '@electric-sql/pglite';
import type { Authority, Outcome } from '../src/engine/contracts.ts';
type Engine = Effect.Success<ReturnType<typeof acquire_engine>>;
import { Authorities } from '../src/engine/identity/actor.ts';
import { PgliteDb } from '@norbital-ai/host-api/node';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { NOW, TODAY } from './write-fixture.ts';
import { actor_ref } from '../src/engine/access/actor.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const salesId = '0199a000-0000-7000-8000-000000000001',
	financeId = '0199a000-0000-7000-8000-000000000002';
const left = '0199a000-0000-7000-8000-000000000011',
	right = '0199a000-0000-7000-8000-000000000012';
const grant: GrantData = {
	outputs: { default: {} },
	update: { columns: { orders: ['note'] }, verdict: true }
};
const manifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		orders: {
			description: 'Order',
			record_label: 'record.title',
			fields: { title: { kind: 'text' }, note: { kind: 'text', optional: true } }
		}
	},
	relationships: {},
	exposures: {
		orders: {
			outputs: { default: { orders: { fields: 'all' } } },
			update: { columns: { orders: ['note'] }, effect: true }
		}
	},
	teams: { Sales: { policies: ['seller'] }, Finance: { policies: ['reviewer'] } },
	policies: {
		seller: { description: 'Seller', grants: { orders: grant } },
		reviewer: { description: 'Reviewer', grants: { orders: { outputs: { default: {} } } } }
	},
	automations: {},
	integrations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} }
};
const guest = program(`export default {
 model: { orders: { bodies: { effect: { update: function*(changes,ctx) {
  if(ctx.event.kind!=='write')return;
  if(changes.length!==2)throw Error('Expected the complete committed batch');
  yield* ctx.notify({to:[{user:'${salesId}'}],title:'Bundle committed'});
 } } } } },
 policy: { seller: { grants: { orders: { update: {
  verdict: function*(_changes,ctx){ return ctx.approve({ steps: [{ name: 'Finance', teams: ['Finance'] }] }); }
 } } } } }
};`);
let pg: PGlite, db: TenantDbShape, e: Engine, sales: Authority, finance: Authority;
const exec = (text: string) => Effect.tryPromise({ try: () => pg.exec(text), catch: db_error });
const view = (...args: Parameters<ReturnType<typeof Approvals.of>['view']>) =>
	Context.get(e, Approvals)
		.view(...args)
		.pipe(Effect.map(Option.getOrNull));
const bindings = { now: NOW, today: TODAY, tz: 'UTC' };
const rows = (sql: string) =>
	Effect.map(db.read([{ text: sql, params: [] }]), (rows) => rows[0]?.rows ?? []);
const pending = (outcome: Outcome) => {
	if (outcome.kind !== 'pending_approval') throw new Error(JSON.stringify(outcome));
	return outcome.request_id;
};
const submit = Effect.fn('Test.submitAtomicBatch')(function* () {
	const result = yield* Context.get(e, Callables).acts({
		name: 'orders.batch',
		acts: [
			{ model: 'orders', verb: 'update', input: [{ target: left, set: { note: 'first' } }] },
			{ model: 'orders', verb: 'update', input: [{ target: right, set: { note: 'second' } }] }
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
    yield* Context.get(e, Runs).tick;
    return yield* rows("SELECT title FROM sys_notification WHERE title='Bundle committed'");
});
const approve = (request_id: string) =>
	Context.get(e, Approvals).decide({
		request_id,
		decision: 'approve',
		authority: finance,
		now: NOW
	});
const fixture = Layer.effectDiscard(
	Effect.gen(function* () {
		// runs are due at the act's NOW; the queue claims by the test clock
		yield* TestClock.setTime(Date.parse(NOW));
		pg = yield* TestDb.open(manifest);
		db = TenantDb.typed(PgliteDb.make(pg));
		yield* exec(
			`INSERT INTO sys_user(id,name,team) VALUES('${salesId}','Sales','Sales'),('${financeId}','Finance','Finance');INSERT INTO orders(id,title) VALUES('${left}','Left'),('${right}','Right')`
		);
		const authorities = new Authorities(manifest, 'test');
		const seller = yield* authorities.member(db, 'bootstrap', salesId),
			reviewer = yield* authorities.member(db, 'bootstrap', financeId);
		if (seller === null || reviewer === null) throw new Error('Missing test actors');
		sales = seller;
		finance = reviewer;
		e = yield* acquire_engine(manifest, db, yield* guest);
	})
);

it.effect(
	'one request holds the atomic batch and freezes its effects until approval releases the writer job once',
	() =>
		Effect.gen(function* () {
			const result = yield* submit();
			const id = pending(result.outcome);
			expect(result.outcome.kind === 'pending_approval' ? result.outcome.records : []).toHaveLength(
				2
			);
			expect(yield* rows('SELECT note FROM orders ORDER BY title')).toEqual([
				{ note: 'first' },
				{ note: 'second' }
			]);
			expect(
				yield* rows("SELECT actor FROM sys_run WHERE automation='orders.effect.update' AND input->'event'->>'kind'='write'")
			).toEqual([]);
			expect(yield* rows("SELECT actor FROM bolt_approval_effect WHERE automation='orders.effect.update' AND input->'event'->>'kind'='write'")).toEqual([{ actor: actor_ref(sales.actor) }]);
			expect(yield* notices()).toEqual([]);
			expect(
				yield* rows('SELECT jsonb_array_length(records) n, state FROM bolt_approvals')
			).toEqual([{ n: 2, state: 'Pending' }]);
			expect((yield* view(id, finance, () => Effect.succeed(true)))?.records).toHaveLength(2);
			// the requester cannot change the records its pending batch holds
			const again = yield* Context.get(e, Callables).acts({
				name: 'orders.batch',
				acts: [
					{ model: 'orders', verb: 'update', input: [{ target: left, set: { note: 'again' } }] }
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
				data: { request_id: id }
			});
			expect((yield* submit()).outcome).toEqual(result.outcome);
			expect(yield* notices()).toHaveLength(0);
			expect(yield* approve(id)).toMatchObject({ kind: 'decided', status: 'Approved' });
			expect(yield* rows('SELECT note FROM orders ORDER BY title')).toEqual([
				{ note: 'first' },
				{ note: 'second' }
			]);
			expect(yield* approve(id)).toMatchObject({ kind: 'refused', code: 'invalid_input' });
			expect(
				yield* rows("SELECT automation FROM sys_run WHERE automation='orders.effect.update' AND input->'event'->>'kind'='write'")
			).toHaveLength(1);
			expect(yield* notices()).toHaveLength(1);
		}).pipe(Effect.provide(fixture))
);
it.effect(
	'rejecting the batch restores both writes and discards frozen writer effects and custom notices',
	() =>
		Effect.gen(function* () {
			const id = pending((yield* submit()).outcome);
			expect(yield* notices()).toEqual([]);
			expect(
				yield* Context.get(e, Approvals).decide({
					request_id: id,
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
			expect(
				(yield* rows("SELECT actor FROM sys_run WHERE automation='orders.effect.update' AND input->'event'->>'kind'='write'"))
					.map((row) => row['actor'])
					.sort()
			).toEqual([]);
			expect(yield* notices()).toEqual([]);
			expect(
				yield* rows("SELECT count(*)::int n FROM bolt_history WHERE cause = 'restored'")
			).toEqual([{ n: 2 }]);
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
					model: 'orders',
					verb: 'update',
					input: [{ target: left, set: { note: 'must roll back' } }]
				},
				{
					model: 'orders',
					verb: 'update',
					input: [{ target: '0199a000-0000-7000-8000-000000000099', set: { note: 'missing' } }]
				}
			],
			authority: sales,
			bindings,
			invocationId: 'refused-batch',
			key: 'refused-batch',
			issuedAt: NOW,
			from: 'Client'
		});
		expect(result.outcome).toMatchObject({ kind: 'refused', code: 'not_found' });
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
