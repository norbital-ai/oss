import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Result, Schema } from 'effect';
import { Callables, RunHandlers, Writes, Reads } from '../src/engine/services.ts';
import { Convert } from '../src/engine/ports.ts';
import { compileAuthority } from '../src/engine/access/authority.ts';
import { readableFile } from '../src/engine/decisions/index.ts';
import { noticeRows } from '../src/engine/notifications/notify.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { admin, manifest as base } from './write-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
const recipient = '0199a000-0000-7000-8000-000000000001';
const manifest: EngineManifest = {
	...base,
	workspace: { ...base.workspace, convert: { to: ['pdf'] } },
	exposures: {
		...base.exposures,
		orders: {
			...base.exposures['orders'],
			read: { orders: { fields: 'all' } },
			notify: true
		}
	},
	automations: {
		ping: {
			description: 'Ping',
			input: { fail: { kind: 'bool' } },
			output: { kind: 'text' },
			policies: ['pinger']
		}
	},
	policies: { pinger: { description: 'Pings', grants: {} } },
	teams: { reviewers: [] }
};
const setup = (notify: string, convert?: Convert['Service']) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				...(convert === undefined ? {} : { ports: Layer.succeed(Convert, convert) }),
				now: '2026-10-24T08:00:00.000Z',
				guest: yield* program(
					`import { Effect } from 'effect';
import { ActRefused } from '@norbital-ai/bolt/errors';
export default {model:{orders:{bodies:{notify:${notify}}}},automation:{ping:{body:function*(input,ctx){if(input.fail)return yield* Effect.fail(new ActRefused({code:'refused',message:'Refused'}));yield* ctx.notify({title:'Ping',to:[{user:'${recipient}'}]});return 'ack';}}}};`
				)
			})
		);
		const t = Context.get(context, TestWorkspace),
			writes = Context.get(context, Writes),
			calls = Context.get(context, Callables),
			handlers = Context.get(context, RunHandlers);
		yield* t.db.write({
			text: "INSERT INTO sys_user(id,name,kind,team) VALUES ($1,'Reviewer','staff','reviewers')",
			params: [recipient]
		});
		const request = (key: string) => ({
			model: 'orders',
			verb: 'create' as const,
			input: [{ title: key }],
			key,
			issuedAt: t.clock.now(),
			authority: admin,
			bindings: { now: t.clock.now(), today: '2026-10-24', tz: 'UTC' },
			invocationId: key,
			mode: { _tag: 'Direct' as const }
		});
		const pending = () =>
			t.db.rows(Schema.Struct({ id: Schema.String, input: Schema.Json }), {
				text: "SELECT id,input FROM sys_run WHERE automation='bolt.notify'",
				params: []
			});
		const notifyRun = (run: { id: string; input: import('../src/decl/values.ts').Json }) =>
			Effect.gen(function* () {
				const handler = yield* handlers.handler('bolt.notify');
				if (Option.isNone(handler)) throw new Error('Missing notify handler');
				return yield* handler.value(run.input, { id: run.id, starter: null });
			});
		const notes = () =>
			t.db.rows(Schema.Struct({ title: Schema.String, member: Schema.NullOr(Schema.String) }), {
				text: 'SELECT title,member FROM sys_notification ORDER BY id',
				params: []
			});
		return { t, context, writes, calls, request, pending, notifyRun, notes };
	});
describe('model notification callbacks', () => {
	it.live(
		'runs after commit on committed row images, dedupes recipients and retried delivery',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* setup(
						`function*(event){if(event.kind!=='write'||event.records[0].number!=='PO-2026-0001')throw Error('Bad event');return [{title:'Committed',to:[{user:'${recipient}'},{user:'${recipient}'},{team:'reviewers'}]}];}`
					);
					const saved = yield* f.writes.act(f.request('order'));
					expect(saved.outcome.kind).toBe('committed');
					expect(yield* f.notes()).toEqual([]);
					const [run] = yield* f.pending();
					if (run === undefined) throw new Error('Missing notification');
					yield* f.notifyRun(run);
					yield* f.notifyRun(run);
					expect(yield* f.notes()).toEqual([{ title: 'Committed', member: recipient }]);
					expect((yield* f.writes.act({ ...f.request('order'), retry: true })).captured).toEqual(
						[]
					);
					expect(yield* f.pending()).toHaveLength(1);
				})
			)
	);
	it.live('a malformed callback fails delivery while its causing write stays committed', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* setup("function*(){return [{title:'Invalid',to:[{team:'unknown'}]}];}");
				expect((yield* f.writes.act(f.request('kept'))).outcome.kind).toBe('committed');
				const [run] = yield* f.pending();
				if (run === undefined) throw new Error('Missing notification');
				expect(Result.isFailure(yield* Effect.result(f.notifyRun(run)))).toBe(true);
				expect(
					yield* f.t.db.value(Schema.Number, {
						text: 'SELECT count(*)::int FROM orders',
						params: []
					})
				).toBe(1);
				expect(yield* f.notes()).toEqual([]);
			})
		)
	);
	it.live(
		'queues automation work before execution and notifies once across successful, refused and replayed starts',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* setup(
						"function*(){throw Error('An automation with no write must not invoke model notify');}"
					);
					const id = randomUUID(),
						request = {
							automation: 'ping',
							runs: [{ id, input: { fail: false } }],
							authority: admin,
							bindings: { now: f.t.clock.now(), today: '2026-10-24', tz: 'UTC' }
						};
					expect(yield* f.calls.start(request)).toMatchObject({ kind: 'committed' });
					expect(yield* f.notes()).toEqual([]);
					expect(
						yield* f.t.db.value(Schema.String, {
							text: 'SELECT state FROM sys_run WHERE id=$1',
							params: [id]
						})
					).toBe('queued');
					yield* f.calls.start(request);
					yield* f.t.runDue();
					expect(
						yield* f.t.db.rows(Schema.Struct({ state: Schema.String, output: Schema.Json }), {
							text: 'SELECT state,output FROM sys_run WHERE id=$1',
							params: [id]
						})
					).toEqual([{ state: 'succeeded', output: 'ack' }]);
					expect(yield* f.notes()).toEqual([{ title: 'Ping', member: recipient }]);
					yield* f.calls.start(request);
					yield* f.t.runDue();
					const refusedId = randomUUID();
					expect(
						yield* f.calls.start({ ...request, runs: [{ id: refusedId, input: { fail: true } }] })
					).toMatchObject({ kind: 'committed' });
					yield* f.t.runDue();
					expect(
						yield* f.t.db.rows(Schema.Struct({ state: Schema.String, error: Schema.Json }), {
							text: 'SELECT state,error FROM sys_run WHERE id=$1',
							params: [refusedId]
						})
					).toMatchObject([{ state: 'failed', error: { code: 'refused', message: 'Refused' } }]);
					expect(
						yield* f.t.db.value(Schema.Number, {
							text: "SELECT count(*)::int FROM sys_run WHERE automation='ping'",
							params: []
						})
					).toBe(2);
					expect(yield* f.pending()).toEqual([]);
					expect(yield* f.notes()).toEqual([{ title: 'Ping', member: recipient }]);
				})
			)
	);
	it.live(
		'converts attachments after commit once and grants the inbox recipient access to the resulting file',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let conversions = 0;
					const f = yield* setup(
						`function*(){return [{title:'Report',to:[{user:'${recipient}'}],attachments:[{document:{html:'<p>Report</p>'},to:'pdf',name:'Report.pdf'}]}];}`,
						{
							targets: ['pdf'],
							convert: () =>
								Effect.sync(() => {
									conversions++;
									return new TextEncoder().encode('%PDF report');
								})
						}
					);
					yield* f.writes.act(f.request('attachment'));
					expect(conversions).toBe(0);
					const [run] = yield* f.pending();
					if (run === undefined) throw new Error('Missing notification');
					yield* f.notifyRun(run);
					yield* f.notifyRun(run);
					expect(conversions).toBe(1);
					const [file] = yield* f.t.db.rows(
						Schema.Struct({ id: Schema.String, field: Schema.String }),
						{ text: 'SELECT id,field FROM sys_file', params: [] }
					);
					if (file === undefined) throw new Error('Missing converted attachment');
					if (admin.actor.kind !== 'member') throw new Error('Expected member');
					const actor = admin.actor;
					const viewer = (id: string) =>
						compileAuthority(
							manifest,
							{ actor: { ...actor, id, admin: false }, policies: [], admin: false },
							id
						);
					const read = Context.get(f.context, Reads).run,
						bindings = f.request('permission').bindings;
					expect(
						yield* readableFile(
							{ manifest, db: f.t.db, read, authority: viewer(recipient), bindings },
							file.id,
							file.field
						)
					).toBe(true);
					expect(
						yield* readableFile(
							{ manifest, db: f.t.db, read, authority: viewer(randomUUID()), bindings },
							file.id,
							file.field
						)
					).toBe(false);
				})
			)
	);
	it.effect(
		'expands approval recipients, and refuses ambiguous recipients and non-conversation channels',
		() =>
			Effect.gen(function* () {
				expect(
					yield* noticeRows([{ title: 'Review', to: ['requester', 'approvers'] }], {
						manifest,
						id: 'event',
						approval: {
							requester: recipient,
							approvers: { teams: ['reviewers'], users: [recipient] }
						}
					})
				).toMatchObject([{ to: [{ user: recipient }, { team: 'reviewers' }] }]);
				for (const notice of [
					{ title: 'Bad', to: [{ user: recipient, team: 'reviewers' }] },
					{ title: 'Bad', to: [{ user: recipient }], via: ['inbox'] }
				])
					expect(
						Result.isFailure(yield* Effect.result(noticeRows([notice], { manifest, id: 'event' })))
					).toBe(true);
			})
	);
});
