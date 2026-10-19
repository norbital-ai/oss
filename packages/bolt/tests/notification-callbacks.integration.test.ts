import { describe, expect, it } from '@effect/vitest';
import { Context, Effect } from 'effect';
import { PgliteDb, Pristine } from '../src/engine/db/pglite.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { Approvals, Callables, Writes, type ActRequest } from '../src/engine/services.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { admin, manifest as base, NOW, TODAY } from './write-fixture.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { GuestProgram } from '../src/engine/guest/runner.ts';
import { acquireEngine } from './effect-engine.ts';
import { program } from './support/guest-fixture.ts';

const memberID = 'recipient';
const schema: EngineManifest = {
	...base,
	teams: {
		'review-team': { name: 'Review', policies: ['reviewer'] },
		'request-team': ['requester']
	},
	policies: {
		reviewer: { description: 'Review', grants: { orders: { read: true } } },
		requester: {
			description: 'Request',
			grants: { orders: { read: true, approval: { create: [{ steps: [['review-team']] }] } } }
		}
	},
	collections: {
		...base.collections,
		orders: {
			...base.collections['orders'],
			read: { fields: 'all' },
			notifications: {
				committed: [{ channel: 'missing_mail', to: true, title: 'Committed' }],
				approvalStarted: [{ channel: 'inbox', to: true, title: 'Started' }],
				approvalCompleted: [{ channel: 'inbox', to: true, title: 'Approved' }]
			}
		}
	}
};
const runner = (body: string) =>
	program(`export default { collection: { orders: { spec: { notifications: {
	committed: [{to:${body}}], approvalStarted: [{to:${body}}], approvalCompleted: [{to:${body}}]
} } } } };`);
const request = (key: string): ActRequest => ({
	collection: 'orders',
	verb: 'create',
	mode: { _tag: 'Direct' },
	input: { title: key },
	key,
	issuedAt: NOW,
	authority: admin,
	bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} },
	invocationId: key
});
const fixture = (manifest: EngineManifest, guest: Effect.Effect<GuestProgram>) =>
	Effect.gen(function* () {
		const pg = yield* PgliteDb.open().pipe(Effect.provide(Pristine.layer)),
			db = PgliteDb.make(pg);
		yield* applyPlan(db, plan(null, manifest), { accept: true });
		yield* db.write({
			text: "INSERT INTO sys_user(id,name,team) VALUES ('recipient','Recipient','review-team'), ('requestor','Requestor','request-team')",
			params: []
		});
		const context = yield* acquireEngine(manifest, db, yield* guest);
		return {
			db,
			writes: Context.get(context, Writes),
			calls: Context.get(context, Callables),
			approvals: Context.get(context, Approvals),
			notes: () =>
				db.read([
					{
						text: 'SELECT id, member, recipient, title FROM sys_notification ORDER BY id',
						params: []
					}
				])
		};
	});

describe('authored notification recipients', () => {
	it.live(
		'runs the actual guest on admitted row images, dedupes overlaps and persists inbox despite unavailable external delivery',
		() =>
			Effect.gen(function* () {
				const f = yield* fixture(
					schema,
					runner(`event => { if(event.event!=='committed'||event.records.length!==1||event.records[0].values.title!=='order')throw Error('event');
			return [{user:'${memberID}'},{user:'${memberID}'},{team:'review-team'}]; }`)
				);
				const first = yield* f.writes.act(request('order'));
				expect(first.outcome.kind).toBe('committed');
				expect(first.captured.filter((row) => row.collection === 'sys_notification')).toHaveLength(
					1
				);
				const [stored] = yield* f.notes();
				expect(stored?.rows).toHaveLength(2);
				expect(stored?.rows.filter((row) => row['member'] === memberID)).toHaveLength(1);
				expect(stored?.rows.filter((row) => row['member'] === null)).toHaveLength(1);
				const [queued] = yield* f.db.read([
					{
						text: "SELECT input FROM sys_run WHERE automation = 'notifications.deliver'",
						params: []
					}
				]);
				const external = stored?.rows.find((row) => row['member'] === null);
				expect(queued?.rows).toEqual([{ input: { ids: [external?.['id']] } }]);
				expect(yield* f.writes.act({ ...request('order'), retry: true })).toMatchObject({
					outcome: first.outcome,
					captured: []
				});
				expect((yield* f.notes())[0]?.rows).toHaveLength(2);
			})
	);

	it.live(
		'notifies a successful named action with no domain write, and suppresses refused/replayed actions',
		() =>
			Effect.gen(function* () {
				const actions: EngineManifest = {
					...schema,
					collections: {
						...schema.collections,
						orders: {
							...schema.collections['orders'],
							read: { fields: 'all' },
							actions: {
								ping: {
									description: 'Ping',
									input: { fail: { kind: 'bool' } },
									output: { kind: 'text' }
								}
							},
							notifications: {
								committed: [{ to: true, title: 'Action succeeded', on: { action: ['ping'] } }]
							}
						}
					}
				};
				const f = yield* fixture(
					actions,
					program(`export default {collection:{orders:{
			bodies:{actions:{ping:function*(input,ctx){if(input.fail)return yield* ctx.refuse('declined');return 'ack';}}},
			spec:{notifications:{committed:[{to:event=>{if(event.action!=='ping'||event.records.length)throw Error('event');return [{user:'recipient'}];}}]}}
		}}};`)
				);
				const common = {
					collection: 'orders',
					action: 'ping',
					input: { fail: false },
					key: 'ping-success',
					issuedAt: NOW,
					authority: admin,
					bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} },
					invocationId: 'ping',
					from: 'Client' as const
				};
				const first = yield* f.calls.action(common);
				expect(first.outcome).toEqual({ kind: 'committed', output: 'ack', records: [] });
				expect(first.captured.filter((row) => row.collection === 'sys_notification')).toHaveLength(
					1
				);
				expect(yield* f.calls.action({ ...common, retry: true })).toMatchObject({
					outcome: first.outcome,
					captured: []
				});
				expect(
					(yield* f.calls.action({ ...common, input: { fail: true }, key: 'ping-refused' })).outcome
				).toMatchObject({ kind: 'refused' });
				expect((yield* f.notes())[0]?.rows.map((row) => row['title'])).toEqual([
					'Action succeeded'
				]);
				const [domain] = yield* f.db.read([
					{ text: 'SELECT count(*)::int AS n FROM orders', params: [] }
				]);
				expect(domain?.rows).toEqual([{ n: 0 }]);
			})
	);

	it.live(
		'rejects malformed or undeclared-policy callback output before the data/notice statement commits',
		() =>
			Effect.gen(function* () {
				const f = yield* fixture(schema, runner('()=>[]'));
				for (const [index, body] of [
					'()=>[{user:"recipient",team:"review-team"}]',
					'()=>[{policy:"does_not_exist"}]',
					'()=>[{team:"does_not_exist"}]',
					'()=>[{user:""}]',
					'()=>null'
				].entries()) {
					const context = yield* acquireEngine(schema, f.db, yield* runner(body));
					const result = yield* Context.get(context, Writes).act(request(`invalid-${index}`));
					expect(result.outcome).toMatchObject({ kind: 'refused', code: 'internal' });
				}
				const [rows] = yield* f.db.read([
					{ text: 'SELECT count(*)::int AS n FROM orders', params: [] }
				]);
				expect(rows?.rows).toEqual([{ n: 0 }]);
				expect((yield* f.notes())[0]?.rows).toEqual([]);
			})
	);

	it.live(
		'runs request and final approval callbacks with authored team handles, without replay duplicates',
		() =>
			Effect.gen(function* () {
				const f = yield* fixture(
					schema,
					runner(`event => { if(event.records[0].values.title!=='held'||event.requestor!=='requestor')throw Error('approval event');
			if(event.event==='committed'){if(event.approvers.length)throw Error('committed approvers');return [{user:'recipient'}];}
			if(event.approvers[0]!=='review-team')throw Error('approval team');return [{team:event.approvers[0]},{user:'recipient'}]; }`)
				);
				const actors = new Authorities(schema, 'test');
				const caller = yield* actors.member(f.db, 'requestor'),
					reviewer = yield* actors.member(f.db, memberID);
				if (caller === null || reviewer === null)
					throw new Error('fixture requires source members');
				const result = yield* f.writes.act({ ...request('held'), authority: caller });
				if (result.outcome.kind !== 'pendingApproval')
					throw new Error(JSON.stringify(result.outcome));
				// the provisional change commits at once: its `committed` rule fires with the request's `approvalStarted`
				expect(result.outcome.records).toHaveLength(1);
				expect(
					(yield* f.notes())[0]?.rows
						.filter((row) => row['member'] === memberID)
						.map((row) => row['title'])
						.sort()
				).toEqual(['Committed', 'Started']);
				expect(
					(yield* f.db.read([{ text: 'SELECT count(*)::int AS n FROM orders', params: [] }]))[0]
						?.rows
				).toEqual([{ n: 1 }]);
				const decision = {
					requestId: result.outcome.requestId,
					status: 'APPROVED' as const,
					authority: reviewer,
					now: NOW
				};
				expect(yield* f.approvals.process(decision)).toMatchObject({ kind: 'decided' });
				expect(
					(yield* f.db.read([{ text: 'SELECT count(*)::int AS n FROM orders', params: [] }]))[0]
						?.rows
				).toEqual([{ n: 1 }]);
				expect(
					(yield* f.notes())[0]?.rows
						.filter((row) => row['member'] === memberID)
						.map((row) => row['title'])
						.sort()
				).toEqual(['Approved', 'Committed', 'Started']);
				expect(yield* f.approvals.process(decision)).toMatchObject({ kind: 'refused' });
				expect(
					(yield* f.notes())[0]?.rows.filter((row) => row['member'] === memberID)
				).toHaveLength(3);
			})
	);
});
