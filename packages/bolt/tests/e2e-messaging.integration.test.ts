// End to end through the engine entry and the test kit (§4.2–§4.4, P22, rules 57–61, §3.8): inbound messages reach the
// engine's conversations by instance, its envoys run the agent's real turn loop over a scripted model, a model sync
// sends through `integrations.deliver`, and notification callbacks reach the approvers' inbox and conversation links.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Predicate, Schema, Stream } from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Conversations } from '../src/engine/services.ts';
import { program } from './support/guest-fixture.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
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
	agent: { skills: {} }
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
const setup = Effect.gen(function* () {
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
	const job = () =>
		actReply(route, t.as(t.admin).authority, {
			callable: 'jobs.create',
			input: [{ title: 'Kismis', status: 'open' }],
			issuedAt: t.clock.now()
		}).pipe(Effect.map((reply) => ok(reply.outcome)));
	const status = (id: string) =>
		qReply(route, t.as(t.admin).authority, {
			reads: [{ m: 'query', a: [{ jobs: { where: { id: { eq: id } }, fields: ['status'] } }] }]
		}).pipe(
			Effect.flatMap((reply) =>
				Schema.decodeUnknownEffect(
					Schema.Struct({
						jobs: Schema.Struct({ rows: Schema.Tuple([Schema.Struct({ status: Schema.String })]) })
					})
				)(reply.answers[0])
			),
			Effect.map((answer) => answer.jobs.rows[0].status)
		);
	let seq = 0;
	/** A chat message is held for the sender's pause even with triage off: the pause passes, and the held burst is admitted. */
	const paused = () =>
		Effect.gen(function* () {
			t.clock.advance('2s');
			yield* t.runDue();
		});
	const say = (
		instance: 'field_wa' | 'sales_tg',
		from: string,
		body: string,
		over: { [k: string]: Json } = {}
	) =>
		t
			.receive(instance, {
				id: `m${++seq}`,
				thread: from,
				sentAt: t.clock.now(),
				from: { handle: from, name: null },
				text: body,
				attachments: [],
				...over
			})
			.pipe(Effect.andThen(paused()));
	const inbound = (body: string) =>
		t.db
			.read([
				{
					text: `SELECT "as", addressed, refused, role FROM sys_message WHERE direction = 'inbound' AND text = $1`,
					params: [body]
				}
			])
			.pipe(Effect.map(([result]) => result?.rows[0]));
	/** What went out through one instance's link. */
	const sent = (instance: string) => t.fakes.links.sent.filter((s) => s.instance === instance);
	const sentTexts = () =>
		sent('field_wa').map(
			(s) => Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(s.message).text
		);

	return { t, context, ai, conversations, route, job, status, say, inbound, sent, sentTexts, ok };
});

describe('envoys through the engine entry (P22, rules 57–60)', () => {
	it.live(
		"an authenticated WhatsApp DM from an administrator updates a record the envoy's policies cannot",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { job, status, say, inbound, sent } = yield* setup;
					const id = yield* job();
					yield* say('field_wa', '6591234567:14@s.whatsapp.net', `close ${id}`);
					expect(yield* status(id)).toBe('done');
					expect(yield* inbound(`close ${id}`)).toMatchObject({
						as: { envoy: { member: ADA, dm: true } },
						role: 'user'
					});
					expect(present(sent('field_wa').at(-1)).message).toMatchObject({
						to: '6591234567:14@s.whatsapp.net'
					});
				})
			)
	);

	it.live(
		"a linked contractor's DM holds only what the envoy's policies or the contractor team grant (P32)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { job, status, say, inbound, sentTexts } = yield* setup;
					const id = yield* job();
					yield* say('field_wa', '6598765432@s.whatsapp.net', `close ${id}`);
					expect(yield* status(id)).toBe('open');
					expect(yield* inbound(`close ${id}`)).toMatchObject({
						as: { envoy: { member: CAL, dm: true } }
					});
					expect(sentTexts().at(-1)).toMatch(/No tool 'act'|forbidden|refused/i);
				})
			)
	);

	it.live('an unknown sender to a private envoy gets one fixed notice, no link and no turn', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { ai, say, inbound, sentTexts } = yield* setup;
				yield* say('field_wa', '6590000001@s.whatsapp.net', 'hello?');
				yield* say('field_wa', '6590000001@s.whatsapp.net', 'anyone?');
				expect(ai.requests).toBe(0);
				expect(sentTexts()).toHaveLength(1);
				expect(sentTexts()[0]).toBe(
					'This whatsapp account is not recognised by Acme Field. Ask an administrator to add it to your profile.'
				);
				expect(yield* inbound('anyone?')).toMatchObject({ refused: 'unregistered', role: null });
			})
		)
	);

	it.live(
		"a group under mention_or_reply keeps chatter ambient; every addressed message runs under the envoy's policies, an administrator's too (P32)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, ai, job, status, say, inbound, sent } = yield* setup;
					const group = { thread: '1203@g.us', group: true };
					const id = yield* job();
					yield* say('field_wa', '6591234567@s.whatsapp.net', 'running late', {
						...group,
						invocation: 'ambient'
					});
					expect(ai.requests).toBe(0);
					expect(yield* inbound('running late')).toMatchObject({ addressed: false, role: null });
					yield* say('field_wa', '6598765432@s.whatsapp.net', `close ${id}`, {
						...group,
						invocation: 'mention'
					});
					expect(yield* status(id)).toBe('open');
					yield* say('field_wa', '6591234567@s.whatsapp.net', `close ${id}`, {
						...group,
						invocation: 'reply',
						id: 'ada-close'
					});
					expect(yield* status(id)).toBe('open');
					const rows = present(
						(yield* t.db.read([
							{
								text: `SELECT "as" FROM sys_message WHERE direction = 'inbound' AND addressed ORDER BY seq`,
								params: []
							}
						]))[0]
					).rows;
					expect(
						rows.map(
							(r) =>
								Schema.decodeUnknownSync(
									Schema.Struct({
										envoy: Schema.Struct({ member: Schema.String, dm: Schema.Boolean })
									})
								)(r['as']).envoy
						)
					).toMatchObject([
						{ member: CAL, dm: false },
						{ member: ADA, dm: false }
					]);
					expect(
						sent('field_wa').every(
							(s) =>
								Schema.decodeUnknownSync(Schema.Struct({ to: Schema.String }))(s.message).to ===
								'1203@g.us'
						)
					).toBe(true);
				})
			)
	);

	it.live(
		"a public Telegram envoy runs an unlinked sender's turn under its own policies, never admin",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { ai, job, status, say, inbound, sent } = yield* setup;
					const id = yield* job();
					yield* say('sales_tg', '777', `close ${id}`);
					expect(ai.requests).toBeGreaterThan(0);
					expect(yield* status(id)).toBe('open');
					expect(yield* inbound(`close ${id}`)).toMatchObject({
						as: {
							envoy: {
								name: 'sales_desk',
								instance: 'sales_tg',
								sender: '777',
								member: null,
								dm: true
							}
						}
					});
					expect(sent('sales_tg')).toHaveLength(1);
				})
			)
	);
});

describe('connections through the engine entry (rule 61)', () => {
	it.live(
		'a model sync queues email in the writing statement, sends once, and imports delivery events onto the row',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, conversations, route, sent, ok } = yield* setup;
					const id = ok(
						(yield* actReply(route, t.as(t.member(['staff'])).authority, {
							callable: 'sent_emails.create',
							input: [{ to: 'carol@acme.com', subject: 'PCN 1234', body: 'Your parts change.' }],
							issuedAt: t.clock.now()
						})).outcome
					);
					const sentAt = t.clock.now();
					yield* t.runDue();
					yield* t.runDue();
					expect(sent('customer_mail')).toHaveLength(1);
					expect(present(sent('customer_mail')[0]).message).toMatchObject({
						to: ['carol@acme.com'],
						subject: 'PCN 1234',
						thread: id
					});
					yield* conversations.receive('customer_mail', {
						kind: 'delivery',
						providerId: 'customer_mail:1',
						report: { kind: 'delivered', at: '2026-09-25T10:01:00.000Z', provider: 'fake' }
					});
					t.clock.advance('3s');
					yield* t.runDue();
					expect(
						(yield* qReply(route, t.as(t.admin).authority, {
							reads: [{ m: 'query', a: [{ sent_emails: { where: { id: { eq: id } } } }] }]
						})).answers[0]
					).toMatchObject({
						sent_emails: { rows: [{ sent_at: sentAt, delivered_at: '2026-09-25T10:01:00.000Z' }] }
					});
				})
			)
	);

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
							text: 'SELECT member,title FROM sys_notification WHERE member IS NOT NULL ORDER BY member,title',
							params: []
						}
					]);
					expect(inbox?.rows).toEqual([
						{ member: ADA, title: 'New ticket' },
						{ member: CAL, title: 'New ticket' },
						{ member: CAL, title: 'New ticket' }
					]);
					yield* t.runDue();
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
							text: `SELECT member, title, link->>'model' AS c, read_at FROM sys_notification ORDER BY member`,
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
