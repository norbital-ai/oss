// End to end through the engine entry and the test kit (§4.2–§4.4, P22, rules 57–61, §3.8): inbound messages reach the
// engine's conversations by instance, its envoys run the agent's real turn loop over a scripted model, a model sync
// sends through `integrations.deliver`, and notification callbacks reach the approvers' inbox and conversation links.
import { describe, expect, it } from '@effect/vitest';
import { afterAll } from 'vitest';
import { Context, Effect, Exit, Layer, Predicate, Scope, Stream } from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Conversations } from '../src/engine/services.ts';
import { program } from '../src/test/guest.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import type { AiResponse, ActOutcome as Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TestWorkspace, respondSystem1 } from '../src/test/index.ts'; // hook:decisions

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } }, // hook:decisions — not a triage test (rule 60a opt-out)
	models: {
		jobs: {
			description: 'A job',
			label: 'title',
			fields: { title: { kind: 'text' }, status: { kind: 'text' } }
		},
		sent_emails: {
			description: 'A customer notice',
			label: 'subject',
			fields: {
				to: { kind: 'text' },
				subject: { kind: 'text' },
				body: { kind: 'text' },
				sent_at: { kind: 'instant', optional: true },
				delivered_at: { kind: 'instant', optional: true },
				failed_reason: { kind: 'text', optional: true }
			}
		},
		orders: { description: 'An order', label: 'title', fields: { title: { kind: 'text' } } },
		tickets: { description: 'A ticket', label: 'title', fields: { title: { kind: 'text' } } }
	},
	relationships: {},
	exposures: {
		jobs: {
			read: { jobs: { fields: 'all' } },
			create: { columns: { jobs: ['title', 'status'] } },
			update: { columns: { jobs: ['status'] } }
		},
		sent_emails: {
			read: { sent_emails: { fields: 'all' } },
			create: { columns: { sent_emails: ['to', 'subject', 'body'] } },
			update: { columns: { sent_emails: ['sent_at', 'delivered_at', 'failed_reason'] } },
			syncs: { mail: { with: 'customer_notices', read: true, write: true } }
		},
		orders: {
			read: { orders: { fields: 'all' } },
			create: { columns: { orders: ['title'] } },
			notify: true
		},
		tickets: {
			read: { tickets: { fields: 'all' } },
			create: { columns: { tickets: ['title'] } },
			notify: true
		}
	},
	integrations: {
		customer_notices: {
			description: 'Customer notices',
			driver: 'email'
		}
	},
	policies: {
		desk: { description: 'What the envoys may do', grants: { jobs: { read: true } } },
		contractor: { description: 'Contractors', grants: { jobs: { read: true } } },
		staff: {
			description: 'Staff',
			grants: { sent_emails: { read: true, create: true }, tickets: { read: true, create: true } }
		},
		sales: {
			description: 'Sales',
			grants: { orders: { read: true, create: { check: true } } }
		},
		finance: { description: 'Finance', grants: { orders: { read: true } } }
	},
	teams: {
		't-con': { name: 'Contractors', policies: ['contractor'] },
		't-fin': { name: 'Finance', policies: ['finance'] },
		't-sales': { name: 'Sales', policies: ['sales'] }
	},
	automations: {},
	connections: {
		field_wa: { integration: 'whatsapp', envoy: 'field_ops' },
		sales_tg: { integration: 'telegram', envoy: 'sales_desk' },
		customer_mail: { integration: 'customer_notices' }
	},
	envoys: {
		field_ops: {
			audience: 'private',
			name: 'Norbius',
			policies: ['desk'],
			triage: false,
			groupMessages: 'mention_or_reply',
			delegation: 'disabled',
			task: 'Keep jobs up to date.'
		},
		sales_desk: {
			audience: 'public',
			name: 'Norbius',
			policies: ['desk'],
			triage: false,
			groupMessages: 'disabled',
			delegation: 'disabled',
			task: 'Answer about jobs.'
		}
	},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;

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
		orders: { bodies: { notify: function* (event) {
			return event.kind==='approval'&&event.move==='request'?[{title:'Awaiting your decision',to:['approvers']}]:[];
		} } },
		tickets: { bodies: { notify: function* (event) {
			if(event.kind!=='write'||event.action!=='create')return [];
			return [
				{title:'New ticket',description:'A ticket was opened.',to:[{team:'t-con'},...(event.actor.kind==='member'?[{user:event.actor.id}]:[])],via:['customer_mail']},
				{title:'New ticket',to:[{team:'t-con'}],via:['field_wa']}
			];
		} } }
	},
	policy: { sales: { grants: { orders: { create: { check: function*(_rows,ctx){return ctx.approve((flow)=>flow.step('Finance',{teams:['t-fin']}));} } } } } }
};`);

/** "close <id>" asks for `act jobs.update`; a tool result is answered with the result; anything else is echoed. */
const text = (c: Json) =>
	typeof c === 'string' ? c : String(Predicate.isObject(c) ? (c['text'] ?? '') : '');
const scriptedAi = () => {
	const ai = { requests: 0 };
	const layer = Layer.succeed(Ai, {
		ask: respondSystem1,
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
							toolCalls: [],
							finish: 'stop',
							usage
						};
					const close = /^close (\S+)/m.exec(text(last.content)); // hook:agent — the message line of the inbound envelope
					if (close !== null)
						return {
							content: '',
							toolCalls: [
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
					return { content: `echo: ${text(last.content)}`, toolCalls: [], finish: 'stop', usage };
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
const setup = Effect.runSync(Effect.cached(Effect.gen(function* () {
	const ai = scriptedAi();
	const context = yield* Layer.build(
		TestWorkspace.layer({
			manifest,
			guest: yield* guest,
			ports: ai.layer,
			host: { envoys: { workspace: 'Acme Field' } }
		})
	);
	const t = Context.get(context, TestWorkspace),
		conversations = Context.get(context, Conversations),
		route = yield* routeFixture(context);
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
}).pipe(Scope.provide(fileScope))));

describe('connections through the engine entry (rule 61)', () => {
	it.live(
		"a notification callback is queued by the writing statement and reaches each named member's inbox and conversation handle",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, route, sent, ok } = yield* setup;
					ok(
						(yield* actReply(route, t.as(t.member(['staff'], { id: ADA })).authority, {
							callable: 'tickets.create',
							input: [{ title: 'Leak' }],
							issuedAt: t.clock.now()
						})).outcome
					);
					const [callbacks] = yield* t.db.read([
						{
							text: "SELECT count(*)::int AS n FROM sys_run WHERE automation = 'bolt.notify' AND state = 'queued'",
							params: []
						}
					]);
					expect(callbacks?.rows).toEqual([{ n: 1 }]);
					yield* t.runDue();
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
					yield* t.runDue();
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
					yield* t.runDue(); // a re-run of the same notices sends nothing twice
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
					const proposal = (yield* actReply(route, yield* t.signIn('sales@ws.example'), {
						callable: 'orders.create',
						input: [{ title: 'desk' }],
						issuedAt: t.clock.now()
					})).outcome;
					expect(proposal).toMatchObject({
						kind: 'pendingApproval',
						records: [{ model: 'orders' }]
					});
					expect(
						(yield* t.db.read([{ text: 'SELECT count(*)::int AS n FROM orders', params: [] }]))[0]
							?.rows
					).toEqual([{ n: 1 }]);
					yield* t.runDue();
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
