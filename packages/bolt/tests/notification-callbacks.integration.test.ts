import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { Approvals, Callables, Live, RunHandlers, Reads } from '../src/engine/services.ts';
import { Convert, Transport, type PushMessage } from '../src/engine/ports.ts';
import { compile_authority } from '../src/engine/access/authority.ts';
import { readableFile } from '../src/engine/decision.ts';
import { noticeRows } from '../src/engine/notifications/notify.ts';
import { CapturedResult, nativeCommit } from '../src/engine/db/captured.ts';
import { Chain } from '../src/engine/write/sql.ts';
import { enqueue, writerOf } from '../src/engine/runs/queue.ts';
import { EffectInput } from '../src/engine/runs/input.ts';
import type { ApprovalEffectEvent } from '../src/protocol/effect-events.ts';
import type { Authority, MemberActor } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { FacilityFailure } from '@norbital-ai/host-api';
import { admin, manifest as base } from './write-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { one_act } from './support/act-one.ts';

const recipient = '0199a000-0000-7000-8000-000000000001';
const requester = '0199a000-0000-7000-8000-000000000002';
const scoped_writer = '0199a000-0000-7000-8000-000000000003';
if (admin.actor.kind !== 'member') throw new Error('The fixture administrator must be a member');
const administrator = admin.actor.id;
const manifest: EngineManifest = {
	...base,
	workspace: { ...base.workspace, convert: { to: ['pdf'] } },
	exposures: {
		...base.exposures,
		orders: {
			outputs: { default: { orders: { fields: 'all' } } },
			create: { columns: { orders: ['title', 'note', 'status'] }, effect: true },
			update: { columns: { orders: ['title', 'note', 'status'] } },
			delete: {}
		}
	},
	automations: { ping: {
		description: 'Ping', input: { fail: { kind: 'bool' } }, output: { kind: 'text' }, policies: ['pinger']
	} },
	policies: {
		pinger: { description: 'Pings', grants: {} },
		author: { description: 'Requests orders', grants: { orders: {
			outputs: { default: {} }, create: { verdict: true }
		} } },
		reviewer: { description: 'Reviews orders', grants: { orders: { outputs: { default: {} } } } },
		restricted: { description: 'Only reads visible orders', grants: { orders: {
			outputs: { default: { scopes: { orders: { title: { eq: 'visible' } } } } }, create: {}
		} } }
	},
	teams: { authors: { policies: ['author'] }, reviewers: { policies: ['reviewer'] }, restricted: { policies: ['restricted'] } }
};
const member = (id: string, team: 'authors' | 'reviewers' | 'restricted'): MemberActor => ({
	kind: 'member', id, email: null, phone: null, external: false,
	teams: [team], team_path: [team], admin: false, party: null
});
const author = Effect.runSync(compile_authority(manifest, {
	actor: member(requester, 'authors'), policies: ['author'], admin: false
}, requester));
const reviewer = Effect.runSync(compile_authority(manifest, {
	actor: member(recipient, 'reviewers'), policies: ['reviewer'], admin: false
}, recipient));
const restricted = Effect.runSync(compile_authority(manifest, {
	actor: member(scoped_writer, 'restricted'), policies: ['restricted'], admin: false
}, scoped_writer));

const setup = (effect: string, convert?: Convert['Service'], transport?: Transport['Service']) => Effect.gen(function* () {
	const context = yield* Layer.build(TestWorkspace.layer({
		manifest,
		ports: Layer.merge(
			convert === undefined ? Layer.empty : Layer.succeed(Convert, convert),
			transport === undefined ? Layer.empty : Layer.succeed(Transport, transport)
		),
		now: '2026-10-24T08:00:00.000Z',
		guest: yield* program(`
import { Effect } from 'effect';
import { FacilityFailure } from '@norbital-ai/host-api';
import { ActRefused } from '@norbital-ai/bolt/errors';
export default {
 model: { orders: { bodies: { effect: { create: ${effect} } } } },
 policy: { author: { grants: { orders: { create: { verdict: function* (_changes, ctx) {
  return ctx.approve({ steps: [{ name: 'Review', teams: ['reviewers'] }] });
 } } } } } },
 automation: { ping: { body: function* (input, ctx) {
  if (input.fail) return yield* Effect.fail(new ActRefused({ code: 'refused', message: 'Refused' }));
  yield* ctx.notify({ title: 'Ping', to: [{ user: '${recipient}' }], once: 'ping:' + ctx.trigger.id });
  return 'ack';
 } } }
};`)
	}));
	const t = Context.get(context, TestWorkspace), writes = Context.get(context, Callables);
	yield* t.db.write({
		text: `INSERT INTO sys_user(id,name,kind,team,admin) VALUES
		($1,'Reviewer','staff','reviewers',false),($2,'Requester','staff','authors',false),
		($3,'Administrator','staff',null,true),($4,'Restricted writer','staff','restricted',false)`,
		params: [recipient, requester, administrator, scoped_writer]
	});
	const request = (key: string, authority: Authority = admin) => ({
		model: 'orders', verb: 'create' as const, input: [{ title: key }], key,
		issuedAt: t.clock.now(), authority,
		bindings: { now: t.clock.now(), today: '2026-10-24', tz: 'UTC' },
		invocationId: key
	});
	const effect_runs = () => t.db.rows(Schema.Struct({
		id: Schema.String, input: EffectInput, state: Schema.String, attempts: Schema.Number, error: Schema.Json
	}), {
		text: "SELECT id,input,state,attempts,error FROM sys_run WHERE automation='orders.effect.create' ORDER BY id",
		params: []
	});
	const enqueue_effect = (input: typeof EffectInput.Type, authority: Authority = admin) => Effect.gen(function* () {
		const chain = new Chain(), id = randomUUID();
		enqueue(chain, [{ id, automation: 'orders.effect.create', input, due_at: t.clock.now(),
			cause: 'effect', ...writerOf(authority) }]);
		yield* nativeCommit(t.db.write, Context.get(context, Live).publish, chain, CapturedResult);
		return id;
	});
	const notes = () => t.db.rows(Schema.Struct({ title: Schema.String, member: Schema.NullOr(Schema.String) }), {
		text: 'SELECT title,member FROM sys_notification ORDER BY title,member', params: []
	});
	return { t, context, writes, calls: Context.get(context, Callables), request, effect_runs, enqueue_effect, notes };
});

describe('notifications from durable model effects', () => {
	it.effect('uses frozen approval events but only active current approvers receive the notice', () =>
		Effect.scoped(Effect.gen(function* () {
			const f = yield* setup(`function* (_changes, ctx) {
 if (ctx.event.kind === 'approval') yield* ctx.notify({ title: 'Review requested', to: ['approvers'],
  once: ctx.event.request + ':' + ctx.event.move });
}`);
			const saved = (yield* f.writes.acts(one_act(f.request('approval-notification')))).outcome;
			if (saved.kind !== 'committed') throw new Error(JSON.stringify(saved));
			const record = saved.records[0]?.id;
			if (record === undefined) throw new Error('Missing order');
			const inactive = randomUUID(), later = randomUUID(), request = randomUUID();
			yield* f.t.db.write({
				text: `INSERT INTO sys_user(id,name,kind,team,active) VALUES
				($1,'Inactive','staff','reviewers',false),($2,'Later reviewer','staff',null,true)`,
				params: [inactive, later]
			});
			const approvers = { teams: ['reviewers'], users: [requester, recipient, inactive] };
			const steps = [{ name: 'Peer review', ...approvers }, { name: 'Later review', teams: [], users: [later] }];
			yield* f.t.db.write({
				text: `INSERT INTO bolt_approvals(id,state,step,collection,record,action,requestor,requestor_user,route,records,log,at)
				VALUES ($1::uuid,'Pending',0,'orders',$2,'create',$3,$4,$5::jsonb,'[]'::jsonb,'[]'::jsonb,$6::timestamptz)`,
				params: [request, record, `member:${requester}`, requester,
					JSON.stringify({ kind: 'steps', steps, superseded_by: [] }), f.t.clock.now()]
			});
			const event: ApprovalEffectEvent = { kind: 'approval', move: 'request', step: 0, steps, done: false,
				request, records: [{ id: record, row: null }], requester, approvers };
			const input: typeof EffectInput.Type = { ids: [record], changes: [], event };
			yield* f.enqueue_effect(input);
			expect((yield* f.t.run_due()).failed).toEqual([]);
			yield* f.enqueue_effect(input);
			expect((yield* f.t.run_due()).failed).toEqual([]);
			expect(yield* f.notes()).toEqual([{ title: 'Review requested', member: recipient }]);
			yield* f.t.db.write({ text: "UPDATE bolt_approvals SET state='Approved' WHERE id=$1::uuid", params: [request] });
			yield* f.enqueue_effect({ ...input, event: { ...event, move: 'approve', done: true } });
			expect((yield* f.t.run_due()).failed).toEqual([]);
			expect(yield* f.notes()).toEqual([{ title: 'Review requested', member: recipient }]);
		}))
	);

	it.live('runs after commit with the writer and committed images, using an explicit retry dedupe key', () =>
		Effect.scoped(Effect.gen(function* () {
			const f = yield* setup(`function* (changes, ctx) {
 if (ctx.event.kind !== 'write' || changes[0].after.number !== 'PO-2026-0001' || ctx.actor.id !== '${administrator}')
  throw Error('Bad committed effect');
 yield* ctx.notify({ title: 'Committed', to: [{ user: '${recipient}' },{ user: '${recipient}' },{ team: 'reviewers' }],
  once: 'committed:' + changes[0].after.id });
 if (ctx.attempt === 1) return yield* Effect.fail(new FacilityFailure({ kind: 'upstream', message: 'Retry this effect' }));
}`);
			const request = f.request('order');
			const saved = yield* f.writes.acts(one_act(request));
			expect(saved.outcome.kind).toBe('committed');
			expect(yield* f.notes()).toEqual([]);
			const [run] = yield* f.effect_runs();
			if (run === undefined) throw new Error('Missing effect');
			expect(run.input.event).toEqual({ kind: 'write' });
			expect(run.input.changes).toMatchObject([{ before: null, after: { number: 'PO-2026-0001' } }]);
			yield* f.t.run_due();
			expect(yield* f.notes()).toEqual([{ title: 'Committed', member: recipient }]);
			f.t.clock.advance('1min');
			expect((yield* f.t.run_due()).failed).toEqual([]);
			expect(yield* f.effect_runs()).toMatchObject([{ state: 'succeeded', attempts: 2 }]);
			expect(yield* f.notes()).toEqual([{ title: 'Committed', member: recipient }]);
			expect((yield* f.writes.acts(one_act({ ...request, retry: true }))).captured).toEqual([]);
			expect(yield* f.effect_runs()).toHaveLength(1);
		}))
	);

	it.live('queries with the original writer scope instead of workspace authority', () =>
		Effect.scoped(Effect.gen(function* () {
			const f = yield* setup(`function* (_changes, ctx) {
 if (ctx.actor.id !== '${scoped_writer}') return;
 const orders = yield* ctx.query({ orders: { fields: ['title'], limit: 20 } });
 if (orders.orders.rows.length !== 1 || orders.orders.rows[0].title !== 'visible') throw new Error('Writer scope escaped');
 yield* ctx.notify({ title: orders.orders.rows[0].title, to: [{ user: '${recipient}' }], once: 'scoped' });
}`);
			expect((yield* f.writes.acts(one_act(f.request('visible')))).outcome.kind).toBe('committed');
			expect((yield* f.writes.acts(one_act(f.request('hidden', restricted)))).outcome.kind).toBe('committed');
			expect((yield* f.t.run_due()).failed).toEqual([]);
			expect(yield* f.notes()).toEqual([{ title: 'visible', member: recipient }]);
		}))
	);

	it.live('records a malformed notice as a failed effect while the causing write stays committed', () =>
		Effect.scoped(Effect.gen(function* () {
			const f = yield* setup("function* (_changes, ctx) { yield* ctx.notify({ title:'Invalid', to:[{team:'unknown'}] }); }");
			expect((yield* f.writes.acts(one_act(f.request('kept')))).outcome.kind).toBe('committed');
			const result = yield* f.t.run_due();
			expect(result.failed).toMatchObject([{ automation: 'orders.effect.create' }]);
			expect(yield* f.effect_runs()).toMatchObject([{ state: 'failed', error: { message: expect.stringContaining('unknown') } }]);
			expect(yield* f.t.db.value(Schema.Number, { text: 'SELECT count(*)::int FROM orders', params: [] })).toBe(1);
			expect(yield* f.notes()).toEqual([]);
		}))
	);

	it.live('queues job admission first and notifies once across successful, refused and repeated starts', () =>
		Effect.scoped(Effect.gen(function* () {
			const f = yield* setup("function* () { throw Error('An automation with no write must not run a model effect'); }");
			const id = randomUUID(), request = { automation: 'ping', runs: [{ id, input: { fail: false } }], authority: admin,
				bindings: { now: f.t.clock.now(), today: '2026-10-24', tz: 'UTC' } };
			expect(yield* f.calls.start(request)).toMatchObject({ kind: 'committed' });
			expect(yield* f.notes()).toEqual([]);
			expect(yield* f.t.db.value(Schema.String, { text: 'SELECT state FROM sys_run WHERE id=$1', params: [id] })).toBe('queued');
			yield* f.calls.start(request);
			expect((yield* f.t.run_due()).failed).toEqual([]);
			expect(yield* f.t.db.rows(Schema.Struct({ state: Schema.String, output: Schema.Json }), {
				text: 'SELECT state,output FROM sys_run WHERE id=$1', params: [id]
			})).toEqual([{ state: 'succeeded', output: 'ack' }]);
			yield* f.calls.start(request);
			yield* f.t.run_due();
			const refused_id = randomUUID();
			expect(yield* f.calls.start({ ...request, runs: [{ id: refused_id, input: { fail: true } }] })).toMatchObject({ kind: 'committed' });
			yield* f.t.run_due();
			expect(yield* f.t.db.rows(Schema.Struct({ state: Schema.String, error: Schema.Json }), {
				text: 'SELECT state,error FROM sys_run WHERE id=$1', params: [refused_id]
			})).toMatchObject([{ state: 'failed', error: { code: 'refused', message: 'Refused' } }]);
			expect(yield* f.t.db.value(Schema.Number, { text: "SELECT count(*)::int FROM sys_run WHERE automation='ping'", params: [] })).toBe(2);
			expect(yield* f.effect_runs()).toEqual([]);
			expect(yield* f.notes()).toEqual([{ title: 'Ping', member: recipient }]);
		}))
	);

	it.live('converts notification attachments at delivery once and authorizes only their inbox recipient', () =>
		Effect.scoped(Effect.gen(function* () {
			let conversions = 0;
			const f = yield* setup(`function* (changes, ctx) {
 yield* ctx.notify({ title: 'Report', to: [{ user: '${recipient}' }], once: 'report:' + changes[0].after.id,
  attachments: [{ document: { html: '<p>Report</p>' }, to: 'pdf', name: 'Report.pdf' }] });
}`, { targets: ['pdf'], convert: () => Effect.sync(() => { conversions++; return new TextEncoder().encode('%PDF report'); }) });
			yield* f.t.db.write({
				text: 'INSERT INTO bolt_push_subscriptions(id,"user",kind,endpoint,keys) VALUES ($1,$2,\'web\',\'https://push.example/device\',$3::jsonb)',
				params: [randomUUID(), recipient, JSON.stringify({ p256dh: 'fixture-public-key', auth: 'fixture-auth' })]
			});
			yield* f.writes.acts(one_act(f.request('attachment')));
			expect(conversions).toBe(0);
			expect((yield* f.t.run_due()).failed).toEqual([]);
			expect(conversions).toBe(1);
			const files = yield* f.t.db.rows(Schema.Struct({ id: Schema.String, field: Schema.String }), {
				text: 'SELECT id,field FROM sys_file', params: []
			});
			expect(files).toHaveLength(1);
			const file = files[0];
			if (file === undefined) throw new Error('Missing converted attachment');
			const ids = yield* f.t.db.rows(Schema.Struct({ id: Schema.String }), { text: 'SELECT id FROM sys_notification', params: [] });
			const handler = yield* Context.get(f.context, RunHandlers).handler('bolt.push');
			if (Option.isNone(handler)) throw new Error('Missing push delivery handler');
			yield* handler.value({ ids: ids.map((note) => note.id) }, { id: randomUUID(), starter: null });
			expect(conversions).toBe(1);
			const viewer = (id: string) => compile_authority(manifest, {
				actor: member(id, 'reviewers'), policies: [], admin: false
			}, id);
			const read = Context.get(f.context, Reads).run, bindings = f.request('permission').bindings;
			for (const [id, allowed] of [[recipient, true], [randomUUID(), false]] as const)
				expect(yield* readableFile({ manifest, db: f.t.db, read, authority: yield* viewer(id), bindings }, file.id, file.field)).toBe(allowed);
		}))
	);

	it.live('retries durable push after full device fanout, retaining each notice id across accepted repeats', () =>
		Effect.scoped(Effect.gen(function* () {
			const sent: PushMessage[] = [];
			let recovered = false;
			const transport: Transport['Service'] = { send: Effect.fn(function* (message) {
				if (message._tag !== 'Push') throw new Error('Expected inbox push');
				sent.push(message);
				if (message.subscription.endpoint.endsWith('/permanent'))
					return yield* Effect.fail(new FacilityFailure({ kind: 'invalid', message: 'Bad subscription', status: 400 }));
				if (!recovered && message.subscription.endpoint.endsWith('/transient'))
					return yield* Effect.fail(new FacilityFailure({ kind: 'rate_limited', message: 'Try later', status: 429 }));
				return { provider_id: 'accepted' };
			}) };
			const f = yield* setup(`function* (_changes, ctx) { yield* ctx.notify({ title:'Report ready', to:[{user:'${recipient}'}] }); }`, undefined, transport);
			for (const endpoint of ['accepted', 'permanent', 'transient'])
				yield* f.t.db.write({
					text: 'INSERT INTO bolt_push_subscriptions(id,"user",kind,endpoint,keys) VALUES ($1,$2,\'web\',$3,\'{}\'::jsonb)',
					params: [randomUUID(), recipient, `https://push.example/${endpoint}`]
				});
			yield* f.writes.acts(one_act(f.request('push-report')));
			yield* f.t.run_due();
			expect(sent).toHaveLength(3);
			const runs = () => f.t.db.rows(Schema.Struct({ state: Schema.String, attempts: Schema.Number, error: Schema.Json, output: Schema.Json }), {
				text: "SELECT state,attempts,error,output FROM sys_run WHERE automation='bolt.push'", params: []
			});
			expect(yield* runs()).toMatchObject([{ state: 'queued', attempts: 1, error: { code: 'rate_limited', message: 'Inbox push: 1 accepted, 1 permanent failures, 1 transient failures.' } }]);
			const ids = yield* f.t.db.rows(Schema.Struct({ id: Schema.String }), { text: 'SELECT id FROM sys_notification', params: [] });
			expect(ids).toHaveLength(1);
			const notice = ids[0];
			if (notice === undefined) throw new Error('Missing notice');
			expect(sent.every((message) => message.id === notice.id)).toBe(true);
			recovered = true;
			f.t.clock.advance('1min');
			yield* f.t.run_due();
			expect(yield* runs()).toMatchObject([{ state: 'succeeded', attempts: 2, output: { sent: 2, failed: 1 } }]);
			expect(sent).toHaveLength(6);
			expect(sent.every((message) => message.id === notice.id)).toBe(true);
			expect(sent.filter((message) => message.subscription.endpoint.endsWith('/accepted'))).toHaveLength(2);
		}))
	);

	it.live('retains transient status in the handler error and stops after three failed durable attempts', () =>
		Effect.scoped(Effect.gen(function* () {
			const seen: string[] = [];
			const f = yield* setup(`function* (_changes, ctx) { yield* ctx.notify({ title:'Retry', to:[{user:'${recipient}'}] }); }`, undefined,
				{ send: (message) => {
					if (message._tag !== 'Push') throw new Error('Expected push');
					seen.push(message.id);
					return Effect.fail(new FacilityFailure({ kind: 'timeout', message: 'Provider timed out', status: 408 }));
				} });
			yield* f.t.db.write({
				text: 'INSERT INTO bolt_push_subscriptions(id,"user",kind,endpoint,keys) VALUES ($1,$2,\'web\',\'https://push.example/timeout\',\'{}\'::jsonb)',
				params: [randomUUID(), recipient]
			});
			yield* f.writes.acts(one_act(f.request('push-timeout')));
			yield* f.t.run_due();
			const ids = yield* f.t.db.rows(Schema.Struct({ id: Schema.String }), { text: 'SELECT id FROM sys_notification', params: [] });
			const handler = yield* Context.get(f.context, RunHandlers).handler('bolt.push');
			if (Option.isNone(handler)) throw new Error('Missing push handler');
			expect(yield* Effect.flip(handler.value({ ids: ids.map((notice) => notice.id) }, { id: randomUUID(), starter: null }))).toMatchObject({
				code: 'timeout', phase: 'facility', cause: { sent: 0, failed: 1, transient: 1, failure: { kind: 'timeout', status: 408, message: 'Provider timed out' } }
			});
			for (let attempt = 0; attempt < 2; attempt++) {
				f.t.clock.advance('1min');
				yield* f.t.run_due();
			}
			expect(yield* f.t.db.rows(Schema.Struct({ state: Schema.String, attempts: Schema.Number, error: Schema.Json }), {
				text: "SELECT state,attempts,error FROM sys_run WHERE automation='bolt.push'", params: []
			})).toMatchObject([{ state: 'failed', attempts: 3, error: { code: 'timeout' } }]);
			f.t.clock.advance('1min');
			yield* f.t.run_due();
			expect(seen).toHaveLength(4); // Three durable attempts and one direct error-shape probe.
			expect(new Set(seen).size).toBe(1);
		}))
	);

	it.effect('expands approval aliases and refuses ambiguous recipients or non-conversation channels', () =>
		Effect.scoped(Effect.gen(function* () {
			const f = yield* setup('function* () {}');
			yield* Effect.gen(function* () {
				expect(yield* noticeRows([{ title: 'Review', to: ['requester', 'approvers'] }], {
					manifest, id: 'event', approval: { requester: recipient, approvers: { teams: ['reviewers'], users: [recipient] } }
				})).toMatchObject([{ to: [{ user: recipient }, { team: 'reviewers' }] }]);
				expect(yield* Effect.flip(noticeRows([{ title: 'Bad', to: [{ user: recipient, team: 'reviewers' }] }], {
					manifest, id: 'event'
				}))).toMatchObject({ code: 'invalid_input' });
				expect(yield* Effect.flip(noticeRows([{ title: 'Bad', to: [{ user: recipient }], via: ['inbox'] }], {
					manifest, id: 'event'
				}))).toMatchObject({ code: 'invalid_input' });
			}).pipe(Effect.provideContext(f.context));
		}))
	);

	for (const decision of ['approve', 'reject'] as const)
		it.live(`${decision} releases or discards the frozen write effect without inventing a second write`, () =>
			Effect.scoped(Effect.gen(function* () {
				const f = yield* setup(`function* (changes, ctx) {
 if (ctx.event.kind !== 'write') return;
 if (ctx.actor.id !== '${requester}') throw new Error('The original writer was lost');
 yield* ctx.notify({ title: 'Approved order', to: [{ user: '${recipient}' }], once: 'approved:' + changes[0].after.id });
}`);
				const saved = (yield* f.writes.acts(one_act(f.request(`held-${decision}`, author)))).outcome;
				if (saved.kind !== 'pending_approval') throw new Error(JSON.stringify(saved));
				expect(yield* f.t.db.value(Schema.Number, {
					text: 'SELECT count(*)::int FROM bolt_approval_effect WHERE request=$1::uuid', params: [saved.request_id]
				})).toBe(1);
				expect((yield* f.t.run_due()).failed).toEqual([]);
				expect(yield* f.notes()).toEqual([]);
				expect(yield* Context.get(f.context, Approvals).decide({ request_id: saved.request_id, decision,
					reason: 'Reviewed', authority: reviewer, now: f.t.clock.now() })).toMatchObject({ kind: 'decided' });
				expect((yield* f.t.run_due()).failed).toEqual([]);
				// the effect's own notice, once, beside the requester's decision notice
				expect(yield* f.notes()).toEqual(decision === 'approve'
					? [{ title: 'Approved order', member: recipient }, { title: 'Approved · held-approve', member: requester }]
					: [{ title: 'Rejected · held-reject', member: requester }]);
				expect(yield* f.t.db.value(Schema.Number, {
					text: 'SELECT count(*)::int FROM bolt_approval_effect WHERE request=$1::uuid', params: [saved.request_id]
				})).toBe(0);
				expect(yield* f.t.db.value(Schema.Number, { text: 'SELECT count(*)::int FROM orders', params: [] })).toBe(decision === 'approve' ? 1 : 0);
			}))
		);
});
