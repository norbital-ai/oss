// engine/envoys on PGlite with the agent area's real turn loop and a scripted model (§4.4, P22, P32, rules 57–61; G12 (4), (5)):
// envoys are source roles deployed on `+workspace.ts` connections, every message admitted by the run its ingest queued.
// A DM holds the envoy's policies joined by the linked sender's own authority (an administrator's DM update commits
// where the envoy's policies would refuse it; a contractor's DM does what the contractor's team grants), a group turn
// holds the envoy's policies alone whoever sends, a private desk admits only senders whose handle is registered on a
// member (phone on WhatsApp, email on email) and answers anyone else once per 15 minutes with a fixed line, no link and
// no turn; an administrator's handle edit admits the next message; a public desk admits anyone; chat replies leave
// while the turn works, and `envoys.receive` bounds admission.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Predicate, Schema, Stream } from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Secrets } from '../src/engine/secrets.ts';
import { HostIdentity } from '../src/shell/host.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import type { AiResponse, AiRequest } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { NOTICES } from '../src/engine/envoys/index.ts';
import { applySettings } from '../src/shell/settings/data.ts';
import { TestWorkspace, type Kit, respondSystem1 } from '../src/test/index.ts'; // hook:decisions

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
		}
	},
	relationships: {},
	collections: {
		jobs: {
			read: { fields: 'all' },
			create: { input: { columns: ['title', 'status'] } },
			update: { input: { columns: ['status'] } }
		}
	},
	integrations: {},
	policies: {
		desk: {
			description: 'What the envoys may do',
			grants: { jobs: { read: true, create: true } },
			limits: { 'envoys.receive': [{ rate: '3/min', per: 'sender' }] }
		},
		contractor: { description: 'Contractors', grants: { jobs: { read: true, update: true } } }
	},
	teams: { 't-con': { name: 'Contractors', policies: ['contractor'] } },
	automations: {},
	connections: {
		field_wa: { integration: 'whatsapp', envoy: 'field_ops' },
		sales_tg: { integration: 'telegram', envoy: 'sales_desk' },
		ops_mail: { integration: 'email', envoy: 'ops_desk' }
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
			delegation: 'enabled',
			task: 'Answer about jobs.'
		},
		ops_desk: {
			audience: 'private',
			name: 'Norbius',
			policies: ['desk'],
			triage: false,
			delegation: 'disabled',
			task: 'Answer mail.'
		}
	},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
} satisfies EngineManifest;

/**
 * A scripted model: a message whose own line is "close <id>" says "On it." and asks for `act jobs.update`; after a tool
 * result it answers "Done." (noting what the chat had already been sent); else it echoes.
 */
function scriptedAi(sent: (instance: string) => string[]) {
	const requests: AiRequest[] = [],
		sentBeforeEnd: string[][] = [];
	let n = 0;
	const text = (c: Json) =>
		typeof c === 'string' ? c : String(Predicate.isObject(c) ? (c['text'] ?? '') : '');
	const layer = Layer.succeed(Ai, {
		ask: respondSystem1,
		maxChoices: undefined,
		models: ['default'],
		catalog: Port.unavailable('ai.catalog'),
		embed: () => Port.unavailable('ai.embed'),
		infer: (request) =>
			Stream.fromEffect(
				Effect.sync<AiResponse>(() => {
					requests.push(request);
					const usage = { input: 10, output: 5 };
					const last = present(
						request.messages.findLast(
							(m) =>
								!(typeof m.content === 'string' && m.content.startsWith('[conversation state]'))
						)
					); // the step's closing note is the engine's, not a message
					if (last.role === 'tool') {
						sentBeforeEnd.push(sent('field_wa'));
						return { content: 'Done.', toolCalls: [], finish: 'stop', usage };
					}
					// the command is its own line of the message, after the envelope's header (never a word inside the header)
					const close = /^(?:\[[^\]\n]*\] )?close (\S+)$/m.exec(text(last.content));
					if (close !== null)
						return {
							content: 'On it.',
							toolCalls: [
								{
									id: `c${++n}`,
									name: 'act',
									input: {
										callable: 'jobs.update',
										input: { target: present(close[1]), set: { status: 'done' } }
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
	return { requests, sentBeforeEnd, layer };
}

const ADA = 'u-ada',
	CAL = 'u-cal',
	DANA = 'u-dana';
const setup = Effect.gen(function* () {
	let t: Kit;
	const ai = scriptedAi((instance) =>
		t.fakes.links.sent
			.filter((item) => item.instance === instance)
			.map(
				(item) =>
					Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(item.message).text
			)
	);
	const context = yield* Layer.build(
		TestWorkspace.layer({
			manifest,
			ports: ai.layer,
			host: { envoys: { workspace: 'Acme Field' } }
		})
	);
	t = Context.get(context, TestWorkspace);
	const route = yield* routeFixture(context);
	yield* t.db.write({
		text: `INSERT INTO sys_user (id, email, name, admin, team, phone) VALUES
			('${ADA}', 'ada@ws.example', 'Ada', true, NULL, '+65 9123 4567'),
			('${CAL}', 'cal@ws.example', 'Cal', false, 't-con', '6598765432'),
			('${DANA}', 'dana@ws.example', 'Dana', false, 't-con', NULL)`,
		params: []
	});
	const job = () =>
		Effect.gen(function* () {
			const o = (yield* actReply(route, t.as(t.admin).authority, {
				callable: 'jobs.create',
				input: { title: 'Kismis', status: 'open' },
				issuedAt: t.clock.now()
			})).outcome;
			if (o.kind !== 'committed') throw new Error(o.kind);
			return present(o.records[0]).id;
		});
	const status = (id: string) =>
		qReply(route, t.as(t.admin).authority, {
			reads: [{ m: 'query', a: ['jobs', { id: id }] }]
		}).pipe(
			Effect.flatMap((reply) =>
				Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.String }))(reply.answers[0])
			),
			Effect.map((row) => row.status)
		);
	let seq = 0;
	const say = (
		instance: 'field_wa' | 'sales_tg',
		from: string,
		text: string,
		over: { [k: string]: Json } = {}
	) =>
		t.receive(instance, {
			id: `m${++seq}`,
			thread: from,
			sentAt: t.clock.now(),
			from: { handle: from, name: null },
			text,
			attachments: [],
			...over
		});
	const rows = (text: string) =>
		t.db
			.read([
				{
					text: `SELECT "as", addressed, refused, role, state FROM sys_message WHERE direction = 'inbound' AND text = $1`,
					params: [text]
				}
			])
			.pipe(
				Effect.map(([result]) => {
					if (result === undefined) throw new Error('Missing inbound rows');
					return result.rows;
				})
			);
	/** What went out through one instance's link. */
	const sent = (instance: string) => t.fakes.links.sent.filter((s) => s.instance === instance);
	const texts = (instance: string) =>
		sent(instance).map(
			(s) => Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(s.message).text
		);

	return { t, context, ai, job, status, say, rows, sent, texts };
});

describe('direct messages (rule 57)', () => {
	it.live(
		"a linked administrator's DM holds the envoy's policies and her bypass: her update commits where the envoy's would refuse it; the interim line left first",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { ai, job, status, say, rows, sent, texts } = yield* setup;
					const id = yield* job();
					yield* say('field_wa', '6591234567:14@s.whatsapp.net', `close ${id}`);
					expect(yield* status(id)).toBe('done');
					expect((yield* rows(`close ${id}`))[0]).toMatchObject({
						as: { envoy: { name: 'field_ops', member: ADA, dm: true } },
						role: 'user',
						state: 'consumed'
					});
					// the chat gets the model's words alone: a receipt names record ids, and the envoy prompt forbids handing those to
					// a person on a phone. The ids live in the row's `meta`, which is the transcript's, not the message's.
					expect(texts('field_wa').at(-1)).toBe('Done.');
					expect(texts('field_wa').at(-1)).not.toContain('jobs ');
					expect(present(sent('field_wa').at(-1)).message).toMatchObject({
						to: '6591234567:14@s.whatsapp.net'
					});
					expect(ai.sentBeforeEnd[0]).toEqual(['On it.']); // streamed while the turn worked, not at its end (parity 2.12)
				})
			)
	);

	it.live(
		"a linked contractor's DM does what the contractor's team grants on top of the envoy's policies",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { job, status, say, rows } = yield* setup;
					const id = yield* job();
					yield* say('field_wa', '6598765432@s.whatsapp.net', `close ${id}`);
					expect(yield* status(id)).toBe('done');
					expect(present((yield* rows(`close ${id}`))[0])['as']).toEqual({
						envoy: {
							name: 'field_ops',
							instance: 'field_wa',
							sender: '6598765432@s.whatsapp.net',
							member: CAL,
							dm: true
						}
					});
				})
			)
	);

	it.live(
		'a private desk admits a registered phone and refuses an unregistered one: one fixed notice per window, no link, no turn',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, ai, say, rows, sent } = yield* setup;
					yield* say('field_wa', '6598765432@s.whatsapp.net', 'registered');
					expect((yield* rows('registered'))[0]).toMatchObject({
						as: { envoy: { member: CAL, dm: true } },
						refused: null
					});
					const turns = ai.requests.length,
						before = sent('field_wa').length;
					yield* say('field_wa', '6590000001@s.whatsapp.net', 'hello?');
					yield* say('field_wa', '6590000001@s.whatsapp.net', 'anyone?');
					expect(ai.requests).toHaveLength(turns);
					expect((yield* rows('anyone?'))[0]).toMatchObject({
						refused: 'unregistered',
						role: null
					});
					const notices = sent('field_wa').slice(before);
					expect(notices).toHaveLength(1); // the repeat inside the window is refused silently
					expect(present(notices[0]).message).toMatchObject({
						to: '6590000001@s.whatsapp.net',
						text: NOTICES.unrecognised('whatsapp', 'Acme Field')
					});
					expect(JSON.stringify(notices)).not.toMatch(/https?:|claim|regist/i);
					t.clock.advance('15min');
					yield* say('field_wa', '6590000001@s.whatsapp.net', 'still there?');
					expect(sent('field_wa').slice(before)).toHaveLength(2);
					expect(ai.requests).toHaveLength(turns);
				})
			)
	);

	it.live(
		"an administrator sets a member's phone in Settings → People; that number's next message is admitted as the member",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, context, say, rows } = yield* setup;
					yield* say('field_wa', '6590000001@s.whatsapp.net', 'before');
					expect((yield* rows('before'))[0]).toMatchObject({ refused: 'unregistered' });
					const identity = Context.get(context, HostIdentity),
						secrets = Context.get(context, Secrets);
					const ada = yield* t.signIn('ada@ws.example'),
						cal = yield* t.signIn('cal@ws.example');
					expect(
						yield* applySettings(
							identity,
							manifest,
							cal,
							{ op: 'setHandles', input: { id: DANA, phone: '+65 9000 0001' } },
							secrets
						).pipe(Effect.flip)
					).toMatchObject({ code: 'forbidden' });
					expect(
						yield* applySettings(
							identity,
							manifest,
							ada,
							{ op: 'setHandles', input: { id: DANA, phone: '90000001' } },
							secrets
						).pipe(Effect.flip)
					).toMatchObject({ code: 'check' });
					expect(
						yield* applySettings(
							identity,
							manifest,
							ada,
							{ op: 'setHandles', input: { id: DANA, phone: '+65 9000 0001' } },
							secrets
						)
					).toBeNull();
					yield* say('field_wa', '6590000001:3@s.whatsapp.net', 'after');
					expect((yield* rows('after'))[0]).toMatchObject({
						as: { envoy: { member: DANA, dm: true } },
						refused: null,
						role: 'user'
					});
					expect((yield* rows('before'))[0]).toMatchObject({ refused: 'unregistered' }); // nothing earlier is replayed
				})
			)
	);

	it.live(
		"a public desk admits anyone: an unknown sender's turn holds exactly its policies, never admin; group messages are ignored",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { ai, job, status, say, rows } = yield* setup;
					const id = yield* job();
					yield* say('sales_tg', '777', `close ${id}`);
					expect(yield* status(id)).toBe('open');
					expect(present((yield* rows(`close ${id}`))[0])['as']).toEqual({
						envoy: {
							name: 'sales_desk',
							instance: 'sales_tg',
							sender: '777',
							member: null,
							dm: true
						}
					});
					const before = ai.requests.length;
					yield* say('sales_tg', '888', 'group chatter', {
						thread: '-100',
						group: true,
						invocation: 'mention'
					});
					expect(ai.requests).toHaveLength(before);
					expect((yield* rows('group chatter'))[0]).toMatchObject({ role: null, addressed: null });
				})
			)
	);

	it.live(
		"a private email desk admits a member's registered address and refuses any other, with the fixed notice in the thread",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, rows, sent } = yield* setup;
					const mailFrom = (id: string, from: string, text: string) =>
						t.receive('ops_mail', {
							id,
							thread: null,
							sentAt: t.clock.now(),
							from: { address: from, name: 'Dana' },
							replyTo: null,
							to: [],
							cc: [],
							subject: 'Hi',
							text,
							html: null,
							headers: {},
							attachments: []
						});
					yield* mailFrom('<d1@x>', 'Dana.Home@else.example', 'from home');
					expect((yield* rows('from home'))[0]).toMatchObject({
						refused: 'unregistered',
						role: null
					});
					expect(present(sent('ops_mail').at(-1)).message).toMatchObject({
						to: ['dana.home@else.example'],
						subject: 'Re: Hi',
						text: NOTICES.unrecognised('email', 'Acme Field')
					});
					yield* mailFrom('<d2@x>', 'DANA@ws.example', 'from work');
					expect((yield* rows('from work'))[0]).toMatchObject({
						as: { envoy: { member: DANA, dm: true } },
						refused: null
					});
				})
			)
	);

	it.live('an email envoy treats every message as addressed and answers in the thread', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, sent } = yield* setup;
				yield* t.receive('ops_mail', {
					id: '<q1@x>',
					thread: null,
					sentAt: t.clock.now(),
					from: { address: 'Ada@ws.example', name: 'Ada' },
					replyTo: null,
					to: [],
					cc: [],
					subject: 'Status',
					text: 'how are we?',
					html: null,
					headers: {},
					attachments: []
				});
				expect(present(sent('ops_mail').at(-1)).message).toMatchObject({
					to: ['ada@ws.example'],
					subject: 'Re: Status',
					thread: '<q1@x>'
				});
				expect(
					Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(
						sent('ops_mail').at(-1)?.message
					).text
				).toContain('how are we?');
			})
		)
	);
});

describe('groups (rule 60)', () => {
	const group = { thread: '1203@g.us', group: true };
	it.live(
		'an unaddressed message is ambient: stored, never a turn; a mention or a reply is admitted',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { ai, status, say, rows, sent } = yield* setup;
					yield* say('field_wa', '6591234567@s.whatsapp.net', 'running late', {
						...group,
						invocation: 'ambient'
					});
					expect(ai.requests).toHaveLength(0);
					expect((yield* rows('running late'))[0]).toMatchObject({ addressed: false, role: null });
					yield* say('field_wa', '6591234567@s.whatsapp.net', '@bot status', {
						...group,
						invocation: 'mention'
					});
					yield* say('field_wa', '6598765432@s.whatsapp.net', 'and mine?', {
						...group,
						invocation: 'reply'
					});
					expect(ai.requests).toHaveLength(2);
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
		'a group mention nobody took records what the provider named, so an unanswered mention is diagnosable',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, say, rows } = yield* setup;
					// the case that took a day to explain: the row is ambient and, without this, nothing says whether a mention was seen
					yield* say('field_wa', '6591234567@s.whatsapp.net', '@us?', {
						...group,
						invocation: 'ambient',
						mentions: ['113377445566:4@lid']
					});
					const unaddressed = () =>
						t.fakes.logs.filter((r) => r.event === 'conversation.unaddressed');
					const logged = unaddressed().at(-1);
					expect(logged).toBeDefined();
					expect(present(logged).attributes).toMatchObject({
						instance: 'field_wa',
						mentions: ['113377445566:4@lid']
					});
					// a row that named nobody is not noise: it is an ordinary ambient message
					yield* say('field_wa', '6591234567@s.whatsapp.net', 'chatter', {
						...group,
						invocation: 'ambient',
						mentions: []
					});
					expect(unaddressed()).toHaveLength(1);
				})
			)
	);

	it.live(
		"every group turn holds the envoy's policies alone: an administrator's update is refused; each message keeps its sender header, and a turn sees the whole transcript (P32)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { ai, job, status, say, rows } = yield* setup;
					const id = yield* job();
					yield* say('field_wa', '6591234567@s.whatsapp.net', `close ${id}`, {
						...group,
						invocation: 'mention'
					});
					expect(yield* status(id)).toBe('open');
					yield* say('field_wa', '6598765432@s.whatsapp.net', 'what did Ada do?', {
						...group,
						invocation: 'mention'
					});
					expect(present((yield* rows(`close ${id}`))[0])['as']).toMatchObject({
						envoy: { member: ADA, dm: false }
					});
					expect(present((yield* rows('what did Ada do?'))[0])['as']).toMatchObject({
						envoy: { member: CAL, dm: false }
					});
					const seen = JSON.stringify(present(ai.requests.at(-1)).messages);
					expect(seen).toContain(`close ${id}`);
					expect(seen).toContain('Done.');
					expect(seen).toContain('linked member u-ada');
				})
			)
	);

	it.live(
		'an unknown sender who mentions the bot gets the fixed notice privately, never in the group, and no turn',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { ai, say, sent } = yield* setup;
					yield* say('field_wa', '6590000009@s.whatsapp.net', '@bot hi', {
						...group,
						invocation: 'mention'
					});
					expect(ai.requests).toHaveLength(0);
					expect(sent('field_wa')).toHaveLength(1);
					expect(present(sent('field_wa')[0]).message).toMatchObject({
						to: '6590000009@s.whatsapp.net',
						text: NOTICES.unrecognised('whatsapp', 'Acme Field')
					});
					expect(
						sent('field_wa').some(
							(s) =>
								Schema.decodeUnknownSync(Schema.Struct({ to: Schema.String }))(s.message).to ===
								'1203@g.us'
						)
					).toBe(false);
				})
			)
	);
});

describe('admission limits and the human in the loop', () => {
	it.live(
		"envoys.receive (the envoy's own policy, per sender) limits a flood; a limited message is recorded and answered once with a fixed line",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, ai, say, rows, texts } = yield* setup;
					for (const n of [1, 2, 3, 4, 5])
						yield* say('field_wa', '6598765432@s.whatsapp.net', `m${n}`);
					expect(ai.requests).toHaveLength(3);
					expect((yield* rows('m4'))[0]).toMatchObject({ refused: 'rateLimited', role: null });
					expect(texts('field_wa').filter((x) => x === NOTICES.rateLimited)).toHaveLength(1);
					t.clock.advance('1min');
					yield* say('field_wa', '6598765432@s.whatsapp.net', 'later');
					expect(ai.requests).toHaveLength(4);
				})
			)
	);

	it.live(
		"a public desk's turns share the desk-wide agent limit: the 101st distinct sender in an hour is limited (G12 (4))",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, ai, say, rows } = yield* setup;
					for (let n = 1; n <= 101; n++) yield* say('sales_tg', `9${n}`, `hello ${n}`);
					expect(ai.requests).toHaveLength(100);
					expect((yield* rows('hello 101'))[0]).toMatchObject({
						refused: 'rateLimited',
						role: null
					});
					t.clock.advance('1h');
					yield* say('sales_tg', '9102', 'next hour');
					expect(ai.requests).toHaveLength(101);
				})
			),
		// 101 sequential admissions: the per-test default cannot hold this volume beside other integration workers.
		60_000
	);
});
