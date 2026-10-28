// engine/envoys on PGlite with the agent area's real turn loop and a scripted model (§4.4, P22, P32, rules 57–61; G12 (4), (5)):
// envoys are source roles deployed on `+workspace.ts` connections, every message admitted by the run its ingest queued.
// A DM holds the envoy's policies joined by the linked sender's own authority (a contractor's DM does what the
// contractor's team grants where the envoy's policies would refuse it), a group turn
// holds the envoy's policies alone whoever sends, a private desk admits only senders whose handle is registered on a
// member (phone on WhatsApp, email on email) and answers anyone else once per 15 minutes with a fixed line, no link and
// no turn; a public desk admits anyone; chat replies leave
// while the turn works, and `envoys.receive` bounds admission.
import { expect } from '@effect/vitest';
import { Effect, Exit, Layer, Predicate, Schema, Scope, Stream } from 'effect';
import { afterAll } from 'vitest';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { actReply, qReply, routeFixture, type FixtureRoute } from './support/route-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import type { AiResponse, AiRequest } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { NOTICES } from '../src/engine/envoys/index.ts';
import {
	layer,
	TestWorkspace,
	type Kit,
	type WorkspaceServices,
	respondSystem1
} from '../src/test/index.ts'; // hook:decisions

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
	exposures: {
		jobs: {
			read: { jobs: { fields: 'all' } },
			create: { columns: { jobs: ['title', 'status'] } },
			update: { columns: { jobs: ['status'] } }
		}
	},
	integrations: {},
	policies: {
		desk: {
			description: 'What the envoys may do',
			grants: { jobs: { read: true, create: true } },
			limits: { 'envoys.receive': [{ rate: '2/min', per: 'sender' }] }
		},
		contractor: { description: 'Contractors', grants: { jobs: { read: true, update: true } } },
		desk_turns: {
			description: 'The public desk turn budget',
			grants: {},
			limits: { agent: [{ rate: '2/h', per: 'actor' }] }
		}
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
			policies: ['desk', 'desk_turns'],
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
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;

/**
 * A scripted model: a message whose own line is "close <id>" says "On it." and asks for `act jobs.update`; after a tool
 * result it answers "Done." (noting what the chat had already been sent); else it echoes.
 */
function scriptedAi(sent: (instance: string) => string[]) {
	const requests: AiRequest[] = [],
		/** The newest field_wa line out when each turn's tool result came back. */
		sentBeforeEnd: string[] = [];
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
							(m) => !(typeof m.content === 'string' && m.content.startsWith('[conversation state'))
						)
					); // the step's closing note is the engine's, not a message
					if (last.role === 'tool') {
						sentBeforeEnd.push(sent('field_wa').at(-1) ?? '');
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
	return { requests, sentBeforeEnd, layer };
}

const ADA = 'u-ada',
	CAL = 'u-cal',
	DANA = 'u-dana';
// One workspace for the file: each case uses its own texts and senders, reads deltas of the shared fakes, and starts an
// hour later so no rate window or notice window carries over.
let kit: Kit | undefined;
const sentTexts = (instance: string) =>
	(kit?.fakes.links.sent ?? [])
		.filter((item) => item.instance === instance)
		.map((item) => Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(item.message).text);
const ai = scriptedAi(sentTexts);
let seq = 0;
// the route is built once, in the file's scope
let route: FixtureRoute | undefined;
const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const setup = Effect.gen(function* () {
	const t = yield* TestWorkspace;
	if (kit === undefined)
		yield* t.db.write({
			text: `INSERT INTO sys_user (id, email, name, admin, team, phone) VALUES
				('${ADA}', 'ada@ws.example', 'Ada', true, NULL, '+65 9123 4567'),
				('${CAL}', 'cal@ws.example', 'Cal', false, 't-con', '6598765432'),
				('${DANA}', 'dana@ws.example', 'Dana', false, 't-con', NULL)`,
			params: []
		});
	kit = t;
	t.clock.advance('1h');
	// work an earlier case left due (a turn queued behind its lease) runs now, before this case counts model steps
	yield* t.runDue();
	yield* t.settled();
	const r = (route ??= yield* routeFixture(yield* Effect.context<TestWorkspace | WorkspaceServices>()).pipe(
		Scope.provide(fileScope)
	));
	const job = () =>
		Effect.gen(function* () {
			const o = (yield* actReply(r, t.as(t.admin).authority, {
				callable: 'jobs.create',
				input: [{ title: 'Kismis', status: 'open' }],
				issuedAt: t.clock.now()
			})).outcome;
			if (o.kind !== 'committed') throw new Error(o.kind);
			return present(o.records[0]).id;
		});
	const status = (id: string) =>
		qReply(r, t.as(t.admin).authority, {
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
	/** A chat message is held for the sender's pause even with triage off: the pause passes, and the held burst is admitted. */
	const paused = () =>
		Effect.gen(function* () {
			t.clock.advance('2s');
			yield* t.runDue();
		});
	const say = (
		instance: 'field_wa' | 'sales_tg',
		from: string,
		text: string,
		over: { [k: string]: Json } = {}
	) =>
		t
			.receive(instance, {
				id: `m${++seq}`,
				thread: from,
				sentAt: t.clock.now(),
				from: { handle: from, name: null },
				text,
				attachments: [],
				...over
			})
			.pipe(Effect.andThen(paused()));
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
	const turns = ai.requests.length;
	/** Model steps since this case began. */
	const steps = () => ai.requests.length - turns;
	return { t, job, status, say, paused, rows, sent, texts: sentTexts, steps };
});
const To = Schema.Struct({ to: Schema.String });

/** The suite's workspace runs on the real clock, as `it.live` would. */
const LIVE = { excludeTestServices: true };
layer(
	TestWorkspace.layer({ manifest, ports: ai.layer, host: { envoys: { workspace: 'Acme Field' } } }),
	LIVE
)(
	'envoys',
	(it) => {
		it.effect(
			"a linked member's DM holds the envoy's policies joined by their own: a contractor's team grant commits; the interim line leaves first",
			() =>
				Effect.gen(function* () {
					const { job, status, say, rows, sent, texts } = yield* setup;
					const other = yield* job();
					yield* say('field_wa', '6598765432@s.whatsapp.net', `close ${other}`);
					expect(yield* status(other)).toBe('done');
					// the chat gets the model's words alone: record ids live in the row's `meta`, never in the message
					expect(texts('field_wa').at(-1)).toBe('Done.');
					expect(present(sent('field_wa').at(-1)).message).toMatchObject({
						to: '6598765432@s.whatsapp.net'
					});
					expect(ai.sentBeforeEnd.at(-1)).toBe('On it.'); // streamed while the turn worked (parity 2.12)
					expect(present((yield* rows(`close ${other}`))[0])['as']).toEqual({
						envoy: {
							name: 'field_ops',
							instance: 'field_wa',
							sender: '6598765432@s.whatsapp.net',
							member: CAL,
							dm: true
						}
					});
				})
		);

		it.effect(
			'a private desk admits a registered phone or address and refuses any other: one fixed notice per window, no link, no turn',
			() =>
				Effect.gen(function* () {
					const { t, say, rows, sent, steps } = yield* setup;
					const turns = steps(),
						before = sent('field_wa').length;
					yield* say('field_wa', '6590000001@s.whatsapp.net', 'hello?');
					yield* say('field_wa', '6590000001@s.whatsapp.net', 'anyone?');
					expect(steps()).toBe(turns);
					expect((yield* rows('anyone?'))[0]).toMatchObject({ refused: 'unregistered', role: null });
					const notices = sent('field_wa').slice(before);
					expect(notices).toHaveLength(1); // the repeat inside the window is refused silently
					expect(present(notices[0]).message).toMatchObject({
						to: '6590000001@s.whatsapp.net',
						text: NOTICES.unrecognised('whatsapp', 'Acme Field')
					});

					// email: the registered address matches case-blind; every email is addressed and answered in its thread
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
					yield* mailFrom('<d2@x>', 'DANA@ws.example', 'from work');
					expect((yield* rows('from work'))[0]).toMatchObject({
						as: { envoy: { member: DANA, dm: true } },
						refused: null
					});
					expect(present(sent('ops_mail').at(-1)).message).toMatchObject({
						to: ['dana@ws.example'],
						subject: 'Re: Hi',
						thread: '<d2@x>',
						text: expect.stringContaining('from work')
					});
				})
		);

		it.effect(
			"a public desk admits anyone unlinked, ignores groups, and shares a desk-wide turn limit (G12 (4))",
			() =>
				Effect.gen(function* () {
					const { say, rows, steps } = yield* setup;
					yield* say('sales_tg', '777', 'hello 0');
					expect(present((yield* rows('hello 0'))[0])['as']).toEqual({
						envoy: { name: 'sales_desk', instance: 'sales_tg', sender: '777', member: null, dm: true }
					});
					const before = steps();
					yield* say('sales_tg', '888', 'group chatter', {
						thread: '-100',
						group: true,
						invocation: 'mention'
					});
					expect(steps()).toBe(before);
					expect((yield* rows('group chatter'))[0]).toMatchObject({ role: null, addressed: null });
					// 2 turns an hour for the whole desk: 777's was the first
					yield* say('sales_tg', '91', 'hello 1');
					yield* say('sales_tg', '92', 'hello 2');
					expect(steps()).toBe(before + 1);
					expect((yield* rows('hello 2'))[0]).toMatchObject({ refused: 'rateLimited', role: null });
				})
		);

		const group = { thread: '1203@g.us', group: true };
		it.effect(
			"a group admits a mention, keeps the rest ambient and holds the envoy's policies alone (P32)",
			() =>
				Effect.gen(function* () {
					const { job, status, say, rows, sent, steps } = yield* setup;
					const before = sent('field_wa').length;
					yield* say('field_wa', '6591234567@s.whatsapp.net', 'running late', {
						...group,
						invocation: 'ambient'
					});
					expect(steps()).toBe(0);
					expect((yield* rows('running late'))[0]).toMatchObject({ addressed: false, role: null });
					const id = yield* job();
					yield* say('field_wa', '6591234567@s.whatsapp.net', `close ${id}`, {
						...group,
						invocation: 'mention'
					});
					// an administrator's group turn holds the envoy's policies alone: her update is refused
					expect(yield* status(id)).toBe('open');
					expect(present((yield* rows(`close ${id}`))[0])['as']).toMatchObject({
						envoy: { member: ADA, dm: false }
					});
					expect(
						sent('field_wa')
							.slice(before)
							.every((s) => Schema.decodeUnknownSync(To)(s.message).to === '1203@g.us')
					).toBe(true);

					// an unknown sender's mention gets the fixed notice privately, never in the group, and no turn
					const quiet = sent('field_wa').length,
						turns = steps();
					yield* say('field_wa', '6590000009@s.whatsapp.net', '@bot hi', { ...group, invocation: 'mention' });
					expect(steps()).toBe(turns);
					expect(sent('field_wa').slice(quiet).map((s) => s.message)).toMatchObject([
						{ to: '6590000009@s.whatsapp.net', text: NOTICES.unrecognised('whatsapp', 'Acme Field') }
					]);
				})
		);

		it.effect(
			'a message addressed to the envoy while the turn runs steers it: queued at once, never held; chatter stays ambient',
			() =>
				Effect.gen(function* () {
					const { t, say, rows } = yield* setup;
					yield* t.db.write({
						text: `UPDATE sys_conversation SET status = 'running', lease_until = $1::timestamptz + interval '1 minute' WHERE kind = 'group'`,
						params: [t.clock.now()]
					});
					// a reply to the envoy joins the running turn before any pause passes: the next step carries it
					yield* t.receive('field_wa', {
						id: 'steer-1',
						thread: '1203@g.us',
						group: true,
						invocation: 'reply',
						sentAt: t.clock.now(),
						from: { handle: '6598765432@s.whatsapp.net', name: null },
						text: 'and mine?',
						attachments: []
					});
					expect(present((yield* rows('and mine?'))[0])).toMatchObject({
						addressed: true,
						role: 'user',
						state: 'queued'
					});
					yield* say('field_wa', '6598765432@s.whatsapp.net', 'lunch?', { ...group, invocation: 'ambient' });
					expect(present((yield* rows('lunch?'))[0])).toMatchObject({ addressed: false, role: null });
				})
		);

		it.effect(
			"envoys.receive (the envoy's own policy, per sender) limits a flood; a limited message is recorded and answered once with a fixed line",
			() =>
				Effect.gen(function* () {
					const { say, rows, texts, steps } = yield* setup;
					const notices = () => texts('field_wa').filter((x) => x === NOTICES.rateLimited).length;
					const before = notices();
					for (const n of [1, 2, 3]) yield* say('field_wa', '6598765432@s.whatsapp.net', `flood ${n}`);
					expect(steps()).toBe(2);
					expect((yield* rows('flood 3'))[0]).toMatchObject({ refused: 'rateLimited', role: null });
					expect(notices() - before).toBe(1);
				})
		);

		it.effect('a tenant-created envoy links a channel and answers through it', () =>
			Effect.gen(function* () {
				const { t, rows, paused, steps } = yield* setup;
				const created = yield* t.as(t.admin).act('sys_envoy.create', [
					{
						name: 'Runtime desk',
						audience: 'private',
						policies: ['desk'],
						task: 'Answer the runtime line.',
						group_messages: 'mention_or_reply',
						delegation: 'disabled',
						dm: 'union'
					}
				]);
				if (created.kind !== 'committed') throw new Error(created.kind);
				const envoy = present(created.records[0]).id;
				const line = yield* t
					.as(t.admin)
					.act('sys_integration.create', [{ integration: 'whatsapp', name: 'Runtime line', envoy }]);
				expect(line.kind).toBe('committed');
				const instance = present(
					(yield* t.db.read([
						{ text: 'SELECT id FROM sys_integration WHERE name = $1', params: ['Runtime line'] }
					]))[0]
				).rows[0]?.['id'];
				expect(typeof instance).toBe('string');
				yield* t.receive(String(instance), {
					id: 'runtime-m1',
					thread: '6591234567:14@s.whatsapp.net',
					sentAt: t.clock.now(),
					from: { handle: '6591234567:14@s.whatsapp.net', name: null },
					text: 'hello runtime',
					attachments: []
				});
				yield* paused();
				expect(steps()).toBe(1);
				// the tenant row's task and name reach the turn, not only admission
				expect(ai.requests.at(-1)?.system).toContain('Answer the runtime line.');
				expect((yield* rows('hello runtime'))[0]).toMatchObject({
					as: { envoy: { name: envoy, member: ADA, dm: true } }
				});
			})
		);
	}
);
