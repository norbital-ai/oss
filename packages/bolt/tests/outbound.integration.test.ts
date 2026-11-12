import { with_accounts } from './support/accounts.ts';
import { with_envoys } from './support/envoys.ts';
import { expect, it, vi } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Schema, Scope, Stream } from 'effect';
import { Activation, Conversations, Links, Outbound, Runs } from '../src/engine/services.ts';
import { Ai, Files } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import type { AiRequest } from '../src/engine/contracts.ts';
import { OutboundLive } from '../src/engine/integrations/outbound.ts';
import { respond_system_1, TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { manifest as base } from './write-fixture.ts';

const runtime_accounts = [
	{ id: 'desk', integration: 'whatsapp', status: { state: 'connected' } },
] as const;

it.live('a daily cron sends once through a runtime envoy account and its later reply retains the report context', () =>
	Effect.scoped(Effect.gen(function* () {
		const requests: AiRequest[] = [];
		const ports = Layer.succeed(Ai, {
			ask: respond_system_1, maxChoices: undefined, models: ['default'],
			catalog: Port.unavailable('ai.catalog'), embed: () => Port.unavailable('ai.embed'),
			infer: (request) => {
				requests.push(request);
				return Stream.succeed({ _tag: 'Response' as const, response: { content: 'The report improved today.', toolCalls: [], finish: 'stop' as const, usage: { input: 1, output: 1 } } });
			}
		});
		const guest = yield* program(`export default { automation: { daily_report: { body: function* (_input, ctx) {
			yield* ctx.send('desk', { to: '6591234567@s.whatsapp.net', text: 'Daily report: net assets increased by 5%.' });
		} } } };`);
		const manifest = { ...base, workspace: { ...base.workspace, agent: { triage: false as const } }, policies: { reporter: { description: 'Sends reports', grants: {} } }, automations: { daily_report: { description: 'Send the daily report', policies: ['reporter'] as const, on: [{ cron: '0 8 * * *' }] } } };
		const context = yield* Layer.build(with_envoys(with_accounts(TestWorkspace.layer({ manifest, guest, ports, now: '2026-09-25T08:00:00.000Z' }), runtime_accounts), [{ id: '0199a000-0000-7000-8000-0000000000ed', name: 'Reports', policies: ['reporter'], audience: 'public', triage: false, accounts: ['desk'] }]));
		const t = Context.get(context, TestWorkspace), runs = Context.get(context, Runs), outbound = Context.get(context, Outbound);
		expect(yield* runs.fire('daily_report', '2026-09-25T08:00:00.000Z').pipe(Effect.provide(context))).toEqual({ ran: true });
		expect(yield* runs.fire('daily_report', '2026-09-25T08:00:00.000Z').pipe(Effect.provide(context))).toEqual({ ran: false });
		yield* outbound.deliver;
		expect(t.fakes.links.sent).toHaveLength(1);
		expect(t.fakes.links.sent[0]?.message).toMatchObject({ text: 'Daily report: net assets increased by 5%.' });
		yield* t.receive('desk', { id: 'daily-report-question', thread: '6591234567@s.whatsapp.net', sent_at: t.clock.now(), from: { handle: '6591234567@s.whatsapp.net', name: 'Reader' }, text: 'Why did net assets increase?', attachments: [] });
		yield* t.run_due();
		yield* t.settled();
		expect(requests.length).toBeGreaterThan(0);
		expect(JSON.stringify(requests[0]?.messages)).toContain('Daily report: net assets increased by 5%.');
		expect(JSON.stringify(requests[0]?.messages)).toContain('Why did net assets increase?');
		expect(requests[0]?.tools?.some((tool) => tool.name === 'page')).toBe(false);
	}))
);

it.live('keeps missing default epochs implicit and persists only changed epochs', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(with_accounts(TestWorkspace.layer({ manifest: base }), runtime_accounts)),
				t = Context.get(context, TestWorkspace);
			const stored = () =>
				t.db.rows(Schema.Struct({ value: Schema.String, version: Schema.String }), {
					text: "SELECT value,xmin::text AS version FROM sys_config WHERE key='integrations.epoch'",
					params: []
				});
			const activate = (epoch: string) =>
				Effect.gen(function* () {
					const updated = yield* Layer.build(
						OutboundLive.pipe(
							Layer.provide(
								Layer.succeedContext(
									Context.add(context, Activation, { ...Context.get(context, Activation), epoch })
								)
							)
						)
					);
					yield* Context.get(updated, Outbound).activate;
				});
			expect(yield* stored()).toEqual([]);
			yield* activate('');
			expect(yield* stored()).toEqual([]);
			yield* activate('fork-1');
			const first = yield* stored();
			expect(first[0]?.value).toBe('fork-1');
			yield* activate('fork-1');
			expect(yield* stored()).toEqual(first);
			yield* activate('fork-2');
			const second = yield* stored();
			expect(second[0]?.value).toBe('fork-2');
			expect(second[0]?.version).not.toBe(first[0]?.version);
		})
	)
);
it.live('a conversation sends once and records its provider receipt', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(
				with_accounts(TestWorkspace.layer({
					manifest: { ...base, }
				}), runtime_accounts)
			);
			const t = Context.get(context, TestWorkspace),
				conversations = Context.get(context, Conversations),
				outbound = Context.get(context, Outbound);
			const id = yield* conversations.send(
				'desk',
				{
					to: '6591234567@s.whatsapp.net',
					text: 'Hello'
				},
				{}
			);
			yield* outbound.deliver;
			yield* outbound.deliver;
			expect(t.fakes.links.sent).toHaveLength(1);
			expect(
				yield* t.db.rows(
					Schema.Struct({ id: Schema.String, status: Schema.String, provider_id: Schema.String }),
					{
						text: "SELECT id,status,provider_id FROM sys_message WHERE direction='outbound'",
						params: []
					}
				)
			).toMatchObject([{ id, status: 'sent' }]);
		})
	)
);

it.live('keeps an unpaired send untouched across days and outbound service recreation, then delivers its original attachment', () =>
	Effect.scoped(Effect.gen(function* () {
		const context = yield* Layer.build(with_accounts(TestWorkspace.layer({
			manifest: base, now: '2026-09-25T08:00:00.000Z'
		}), [{ id: 'waiting', integration: 'whatsapp' }]));
		const t = Context.get(context, TestWorkspace);
		yield* Effect.gen(function* () {
			const upload = yield* (yield* t.as(t.admin)).upload('sys_conversation.inputs', {
				name: 'report.txt', mime: 'text/plain', bytes: new TextEncoder().encode('Frozen report')
			});
			if (upload.kind !== 'committed') throw new Error('The report attachment must commit.');
			const files = Context.get(context, Files);
			const reads = vi.spyOn(files, 'get');
			yield* Effect.addFinalizer(() => Effect.sync(() => reads.mockRestore()));
			const payload = { to: '6591234567@s.whatsapp.net', text: 'Original report', attachments: [upload.output] };
			const id = yield* Context.get(context, Conversations).send('waiting', payload, {});
			const row = () => t.db.rows(Schema.Struct({
				id: Schema.String, integration: Schema.String, conversation: Schema.String,
				status: Schema.String, attempts: Schema.Int, epoch: Schema.String,
				claimed_at: Schema.NullOr(Schema.String), sent_at: Schema.NullOr(Schema.String),
				provider_id: Schema.NullOr(Schema.String), message: Schema.Json, delivery: Schema.Json
			}), { text: `SELECT id,integration,conversation,status,attempts,epoch,claimed_at::text,sent_at::text,provider_id,message,delivery
				FROM sys_message WHERE id=$1`, params: [id] });
			const before = yield* row();
			const initial = before[0];
			if (initial === undefined) throw new Error('The queued report must be stored.');
			expect(before).toMatchObject([{ id, integration: 'waiting', status: 'queued', attempts: 0,
				claimed_at: null, sent_at: null, provider_id: null, epoch: '', message: payload,
				delivery: [{ kind: 'queued' }] }]);
			const first_scope = yield* Scope.make();
			yield* Effect.addFinalizer(() => Scope.close(first_scope, Exit.void));
			const fresh = (scope: Scope.Closeable) => Layer.build(OutboundLive.pipe(Layer.provide(Layer.succeedContext(context))))
				.pipe(Scope.provide(scope), Effect.map((services) => Context.get(services, Outbound)));
			const first = yield* fresh(first_scope);
			for (let day = 0; day < 4; day++) {
				t.clock.advance('2d');
				expect(yield* first.deliver).toEqual({ sent: 0, failed: 0 });
				expect((yield* t.run_due()).failed).toEqual([]);
			}
			yield* Scope.close(first_scope, Exit.void);
			const second_scope = yield* Scope.make();
			yield* Effect.addFinalizer(() => Scope.close(second_scope, Exit.void));
			const second = yield* fresh(second_scope);
			expect(second).not.toBe(first);
			yield* second.activate;
			for (let day = 0; day < 4; day++) {
				t.clock.advance('2d');
				expect(yield* second.deliver).toEqual({ sent: 0, failed: 0 });
				expect((yield* t.run_due()).failed).toEqual([]);
			}
			expect(yield* row()).toEqual(before);
			expect(reads).not.toHaveBeenCalled();
			expect(t.fakes.links.sent).toEqual([]);
			yield* Context.get(context, Links).status('waiting', { state: 'connected' });
			yield* second.resume('waiting');
			expect((yield* t.run_due()).failed).toEqual([]);
			const delivered = yield* row();
			expect(delivered).toMatchObject([{ id, integration: 'waiting', conversation: initial.conversation,
				status: 'sent', attempts: 1, message: payload, provider_id: expect.any(String) }]);
			const accepted = delivered[0];
			if (accepted?.sent_at == null) throw new Error('The provider receipt must record acceptance.');
			expect(Date.parse(accepted.sent_at)).toBe(Date.parse(t.clock.now()));
			expect(reads).toHaveBeenCalledOnce();
			expect(t.fakes.links.sent).toHaveLength(1);
			expect(t.fakes.links.sent[0]?.message).toMatchObject({ id, to: payload.to, text: payload.text });
			expect(t.fakes.links.sent[0]?.attachments?.map(({ name, bytes }) => ({ name, text: new TextDecoder().decode(bytes) })))
				.toEqual([{ name: 'report.txt', text: 'Frozen report' }]);
		}).pipe(Effect.provide(context));
	}))
);
