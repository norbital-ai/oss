import { with_accounts } from './support/accounts.ts';
import { with_envoys } from './support/envoys.ts';
// End to end through the engine entry and the test kit (§4.2–§4.4, P22, rules 57–61, §3.8): inbound messages reach the
// engine's conversations by instance, its envoys run the agent's real turn loop over a scripted model, a model sync
// sends through `integrations.deliver`, and notification callbacks reach the approvers' inbox and conversation links.
import { describe, expect, it } from '@effect/vitest';
import { afterAll } from 'vitest';
import { Context, Effect, Exit, Layer, Predicate, Scope, Stream } from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Conversations } from '../src/engine/services.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { act_reply, route_fixture } from './support/route-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import type { AiResponse, ActOutcome as Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TestWorkspace, respond_system_1 } from '../../bolt-cli/src/test/index.ts'; // hook:decisions

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const runtime_accounts = [
	{ id: 'field_wa', integration: 'whatsapp', status: { state: 'connected' } },
	{ id: 'sales_tg', integration: 'telegram', status: { state: 'connected' } },
	{ id: 'customer_mail', integration: 'customer_notices', status: { state: 'connected' } },
] as const;

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } }, // hook:decisions — not a triage test (rule 60a opt-out)
	models: {
		jobs: {
			description: 'A job',
			record_label: 'record.title',
			fields: { title: { kind: 'text' }, status: { kind: 'text' } }
		},
		sent_emails: {
			description: 'A customer notice',
			record_label: 'record.subject',
			fields: {
				to: { kind: 'text' },
				subject: { kind: 'text' },
				body: { kind: 'text' },
				sent_at: { kind: 'instant', optional: true },
				delivered_at: { kind: 'instant', optional: true },
				failed_reason: { kind: 'text', optional: true }
			}
		},
		orders: {
			description: 'An order',
			record_label: 'record.title',
			fields: { title: { kind: 'text' } }
		},
		tickets: {
			description: 'A ticket',
			record_label: 'record.title',
			fields: { title: { kind: 'text' } }
		}
	},
	relationships: {},
	exposures: {
		jobs: {
			outputs: { default: { jobs: { fields: 'all' } } },
			create: { columns: { jobs: ['title', 'status'] } },
			update: { columns: { jobs: ['status'] } }
		},
		sent_emails: {
			outputs: { default: { sent_emails: { fields: 'all' } } },
			create: { columns: { sent_emails: ['to', 'subject', 'body'] } },
			update: { columns: { sent_emails: ['sent_at', 'delivered_at', 'failed_reason'] } },
			syncs: { mail: { with: 'customer_notices', read: true, write: true } }
		},
		orders: {
			outputs: { default: { orders: { fields: 'all' } } },
			create: { columns: { orders: ['title'] }, effect: true }
		},
		tickets: {
			outputs: { default: { tickets: { fields: 'all' } } },
			create: { columns: { tickets: ['title'] }, effect: true }
		}
	},
	integrations: {
		customer_notices: {
			description: 'Customer notices',
			driver: 'email'
		}
	},
	policies: {
		desk: {
			description: 'What the envoys may do',
			grants: { jobs: { outputs: { default: true } } }
		},
		contractor: { description: 'Contractors', grants: { jobs: { outputs: { default: true } } } },
		staff: {
			description: 'Staff',
			grants: {
				sent_emails: { outputs: { default: true }, create: true },
				tickets: { outputs: { default: true }, create: true }
			}
		},
		sales: {
			description: 'Sales',
			grants: { orders: { outputs: { default: true }, create: { verdict: true } } }
		},
		finance: { description: 'Finance', grants: { orders: { outputs: { default: true } } } }
	},
	teams: {
		't-con': { name: 'Contractors', policies: ['contractor'] },
		't-fin': { name: 'Finance', policies: ['finance'] },
		't-sales': { name: 'Sales', policies: ['sales'] }
	},
	automations: {},
	

	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;
const fieldOpsEnvoy = '0199a000-0000-7000-8000-0000000000e1';
const salesDeskEnvoy = '0199a000-0000-7000-8000-0000000000e2';
const runtimeEnvoys = [
	{
		id: fieldOpsEnvoy,
		accounts: ['field_wa'],
		audience: 'private',
		name: 'Norbius',
		policies: ['desk'],
		triage: false,
		group_messages: 'mention_or_reply',
		delegation: 'disabled',
		task: 'Keep jobs up to date.'
	},
	{
		id: salesDeskEnvoy,
		accounts: ['sales_tg'],
		audience: 'public',
		name: 'Norbius',
		policies: ['desk'],
		triage: false,
		group_messages: 'disabled',
		delegation: 'disabled',
		task: 'Answer about jobs.'
	}
] as const;

const guest = program(`export default {
	model: {
		sent_emails: { bodies: { syncs: { mail: {
			write: function* ({op,row},ctx) {
				if(op!=='create')return null;
				return {$id:yield* ctx.send({to:[row.to],subject:row.subject,text:row.body,thread:row.id})};
			},
			read: function* ({deliveries}) {
				const rows=new Map();
				for(const event of deliveries)if(event.kind!=='message')rows.set(event.message,{
					...(rows.get(event.message)??{$id:event.message}),
					...(event.kind==='sent'?{sent_at:event.at}:event.kind==='delivered'?{delivered_at:event.at}:{failed_reason:event.reason})
				});
				return {rows:[...rows.values()]};
			}
		} } } },
		orders: { bodies: { effect: { create: function* (_changes, ctx) {
			if(ctx.event.kind==='approval'&&ctx.event.move==='request') yield* ctx.notify([{title:'Awaiting your decision',to:['approvers']}]);
		} } } },
		tickets: { bodies: { effect: { create: function* (_changes, ctx) {
			if(ctx.event.kind!=='write')return;
			yield* ctx.notify([
				{title:'New ticket',description:'A ticket was opened.',to:[{team:'t-con'},...(ctx.actor.kind==='member'?[{user:ctx.actor.id}]:[])],via:['customer_mail']},
				{title:'New ticket',to:[{team:'t-con'}],via:['field_wa']}
			]);
		} } } }
	},
	policy: { sales: { grants: { orders: { create: { verdict: function*(_rows,ctx){return ctx.approve({ steps: [{ name: 'Finance', teams: ['t-fin'] }] });} } } } } }
};`);

/** "close <id>" asks for `act jobs.update`; a tool result is answered with the result; anything else is echoed. */
const text = (c: Json) =>
	typeof c === 'string' ? c : String(Predicate.isObject(c) ? (c['text'] ?? '') : '');
const scriptedAi = () => {
	const ai = { requests: 0 };
	const layer = Layer.succeed(Ai, {
		ask: respond_system_1,
		maxChoices: undefined,
		models: ['default'],
		catalog: Port.unavailable('ai.catalog'),
		embed: () => Port.unavailable('ai.embed'),
		infer: (request) =>
			Stream.fromEffect(
				Effect.sync<AiResponse>(() => {
					ai.requests++;
					const usage = { input: 10, output: 5 },
						last = present(
							request.messages.findLast(
								(m) =>
									!(typeof m.content === 'string' && m.content.startsWith('[conversation state'))
							)
						); // not the step's closing note
					if (last.role === 'tool')
						return {
							content: `result: ${JSON.stringify(last.content)}`,
							tool_calls: [],
							finish: 'stop',
							usage
						};
					const close = /^close (\S+)/m.exec(text(last.content)); // hook:agent — the message line of the inbound envelope
					if (close !== null)
						return {
							content: '',
							tool_calls: [
								{
									id: `c${ai.requests}`,
									name: 'act',
									input: {
										callable: 'jobs.update',
input: [{ target: present(close[1]), set: { status: 'done' } }]
									}
								}
							],
							finish: 'tool',
							usage
						};
					return { content: `echo: ${text(last.content)}`, tool_calls: [], finish: 'stop', usage };
				})
			).pipe(Stream.map((response) => ({ _tag: 'Response' as const, response })))
	});
	return {
		...ai,
		get requests() {
			return ai.requests;
		},
		layer
	};
};

const ADA = 'u-ada',
	CAL = 'u-cal';
// One workspace for the file; each case reads its own rows.
const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const setup = Effect.runSync(
	Effect.cached(
		Effect.gen(function* () {
			const ai = scriptedAi();
			const context = yield* Layer.build(
				with_envoys(
					with_accounts(TestWorkspace.layer({
						manifest,
						guest: yield* guest,
						ports: ai.layer,
						host: { envoys: { workspace: 'Acme Field' } }
					}), runtime_accounts),
					runtimeEnvoys
				)
			);
			const t = Context.get(context, TestWorkspace),
				conversations = Context.get(context, Conversations),
				route = yield* route_fixture(context);
			yield* t.db.write({
				text: `INSERT INTO sys_user (id, email, name, admin, team, phone) VALUES
			('${ADA}', 'ada@ws.example', 'Ada', true, NULL, '+65 9123 4567'),
			('${CAL}', 'cal@ws.example', 'Cal', false, 't-con', '6598765432')`,
				params: []
			});
			const ok = (o: Outcome) => {
				if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
				return present(o.records[0]).id;
			};
			/** What went out through one instance's link. */
			const sent = (instance: string) => t.fakes.links.sent.filter((s) => s.instance === instance);

			return { t, conversations, route, sent, ok };
		}).pipe(Scope.provide(fileScope))
	)
);

describe('connections through the engine entry (rule 61)', () => {
	it.live(
		"a notification callback is queued by the writing statement and reaches each named member's inbox and conversation handle",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, route, sent, ok } = yield* setup;
					ok(
						(yield* act_reply(route, (yield* t.as(t.member(['staff'], { id: ADA }))).authority, {
							acts: { 'tickets.create': [{ title: 'Leak' }] },
							issued_at: t.clock.now()
						})).outcome
					);
					const [callbacks] = yield* t.db.read([
						{
							text: "SELECT count(*)::int AS n FROM sys_run WHERE automation = 'tickets.effect.create' AND state = 'queued'",
							params: []
						}
					]);
					expect(callbacks?.rows).toEqual([{ n: 1 }]);
					yield* t.run_due();
					const [queued] = yield* t.db.read([
						{
							text: `SELECT n.recipient->>'channel' AS channel, (SELECT count(*)::int FROM sys_run r WHERE r.automation = 'notifications.deliver') AS runs
			FROM sys_notification n WHERE n.member IS NULL ORDER BY 1`,
							params: []
						}
					]);
					expect(present(queued).rows).toEqual([
						{ channel: 'customer_mail', runs: 1 },
						{ channel: 'field_wa', runs: 1 }
					]);
					const [inbox] = yield* t.db.read([
						{
							text: `SELECT member,title FROM sys_notification WHERE member IS NOT NULL AND title = 'New ticket' ORDER BY member,title`,
							params: []
						}
					]);
					expect(inbox?.rows).toEqual([
						{ member: ADA, title: 'New ticket' },
						{ member: CAL, title: 'New ticket' },
						{ member: CAL, title: 'New ticket' }
					]);
					yield* t.run_due();
					const [admitted] = yield* t.db.read([
						{
							text: "SELECT state,output FROM sys_run WHERE automation='notifications.deliver'",
							params: []
						}
					]);
					expect(present(admitted).rows).toEqual([{ state: 'succeeded', output: { queued: 3, skipped: 0 } }]);
					expect(
						sent('customer_mail')
							.map((s) => s.message)
							.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
					).toMatchObject([
						{ to: ['ada@ws.example'], subject: 'New ticket', text: 'A ticket was opened.' },
						{ to: ['cal@ws.example'], subject: 'New ticket' }
					]);
					expect(sent('field_wa').map((s) => s.message)).toMatchObject([
						{ to: '6598765432@s.whatsapp.net', text: 'New ticket' }
					]);
					yield* t.run_due(); // a re-run of the same notices sends nothing twice
					expect(sent('customer_mail')).toHaveLength(2);
				})
			)
	);

	it.live(
		'an approval request notifies the step approvers in their inbox, one row per member (L-BOLT-354)',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, route } = yield* setup;
					yield* t.db.write({
						text: `INSERT INTO sys_user (id, email, name, team) SELECT v.id, v.email, v.name, 't-fin' FROM (VALUES ('u-fay', 'fay@ws.example', 'Fay'),
				('u-fin', 'fin@ws.example', 'Fin')) v(id, email, name)`,
						params: []
					});
					const author = t.member([], { email: 'sales@ws.example' });
					yield* t.db.write({
						text: "UPDATE sys_user SET team = 't-sales' WHERE id = $1",
						params: [author.id]
					});
					const proposal = (yield* act_reply(route, yield* t.sign_in('sales@ws.example'), {
						acts: { 'orders.create': [{ title: 'desk' }] },
						issued_at: t.clock.now()
					})).outcome;
					expect(proposal).toMatchObject({
						kind: 'pending_approval',
						records: [{ model: 'orders' }]
					});
					expect(
						(yield* t.db.read([{ text: 'SELECT count(*)::int AS n FROM orders', params: [] }]))[0]
							?.rows
					).toEqual([{ n: 1 }]);
					yield* t.run_due();
					const [rows] = yield* t.db.read([
						{
							text: `SELECT member, title, link->>'model' AS c, read_at FROM sys_notification WHERE link->>'model' = 'orders' ORDER BY member`,
							params: []
						}
					]);
					expect(present(rows).rows).toEqual([
						{ member: 'u-fay', title: 'Awaiting your decision', c: 'orders', read_at: null },
						{ member: 'u-fin', title: 'Awaiting your decision', c: 'orders', read_at: null }
					]);
				})
			)
	);
});
