// System 1 triage (P31, P33, rule 60a; §11.2 G12 (10)) through the engine entry and the test kit: a scripted
// `sys_1` (no vendor) decides when admitted envoy and in-app messages start a turn; the kit's clock drives each exact-time
// re-check. Mentions and send-now are deterministic, a row is new input at most once, and every decision is costed.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Predicate, Result, Schema, Stream } from 'effect';
import { Ai, Metering } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { FacilityFailure } from '../src/decl/errors.ts';
import { Agents } from '../src/engine/services.ts';
import { decodeManifest, type EngineManifest } from '../src/engine/manifest.ts';
import { actReply, qReply, routeFixture, type FixtureRoute } from './support/route-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import { TRIAGE_DEBOUNCE, TRIAGE_MAX_WAITS, TriageService } from '../src/engine/agent/triage.ts';
import type { DecisionResult, System1Request } from '../src/engine/decisions/index.ts';
import { TestWorkspace, type Kit, type WorkspaceServices } from '../src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
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
		pipelines: {},
		policies: {
			desk: { description: 'Desk', grants: { jobs: { read: true } } },
			contractor: { description: 'Contractors', grants: { jobs: { read: true } } }
		},
		teams: { 't-con': { name: 'Contractors', policies: ['contractor'] } },
		automations: {},
		connections: { field_wa: { integration: 'whatsapp', envoy: 'field_ops' } },
		envoys: {
			field_ops: {
				audience: 'private',
				name: 'Norbius',
				policies: ['desk'],
				groupMessages: 'mention_or_reply',
				delegation: 'disabled',
				triage: {},
				task: 'Keep jobs up to date.'
			}
		},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { internal: 'Staff brief.', skills: {} }
	})
);

/** Closes every "close <id>" no earlier tool call targeted; otherwise answers. Stateless over the transcript it is sent. */
/** A user message's text without its envelope's sender header (`[who] `). */
const text = (c: Json) =>
	(typeof c === 'string' ? c : Predicate.isObject(c) ? String(c['text'] ?? '') : '').replace(
		/^\[[^\]]*\]\s*/,
		''
	);
const ai: Pick<Ai['Service'], 'models' | 'infer'> & { requests: string[][]; raw: string[][] } = {
	models: ['default'],
	requests: [],
	raw: [],
	infer: (request) =>
		Stream.suspend((): ReturnType<Ai['Service']['infer']> => {
			const usage = { input: 10, output: 5 };
			ai.requests.push(
				request.messages
					.filter(
						(m) =>
							m.role === 'user' &&
							!String(typeof m.content === 'string' ? m.content : '').startsWith(
								'[conversation state]'
							)
					)
					.map((m) => text(m.content))
			);
			ai.raw.push(
				request.messages
					.filter(
						(m) =>
							m.role === 'user' &&
							!String(typeof m.content === 'string' ? m.content : '').startsWith(
								'[conversation state]'
							)
					)
					.map((m) => JSON.stringify(m.content))
			);
			const asked = new Set(
				[...JSON.stringify(request.messages).matchAll(/\\?"target\\?":\\?"([\w-]+)/g)].map(
					(x) => x[1]
				)
			);
			const open = request.messages
				.filter(
					(m) =>
						m.role === 'user' &&
						!String(typeof m.content === 'string' ? m.content : '').startsWith(
							'[conversation state]'
						)
				)
				.flatMap((m) => [...(/close ([\w-]+)/g.exec(text(m.content)) ?? [])].slice(1))
				.find((id) => !asked.has(id));
			// "check the chatter" reads it once, as the unread note asks
			const read = request.messages.some(
				(m) => m.role === 'assistant' && JSON.stringify(m.content).includes('read_messages')
			);
			if (
				!read &&
				request.messages.some(
					(m) => m.role === 'user' && JSON.stringify(m.content).includes('check the chatter')
				)
			)
				return Stream.succeed({
					_tag: 'Response',
					response: {
						content: '',
						toolCalls: [{ id: `c${ai.requests.length}`, name: 'read_messages', input: {} }],
						finish: 'tool',
						usage
					}
				});
			if (open !== undefined)
				return Stream.succeed({
					_tag: 'Response',
					response: {
						content: '',
						toolCalls: [
							{
								id: `c${ai.requests.length}`,
								name: 'act',
								input: { callable: 'jobs.update', input: { target: open, set: { status: 'done' } } }
							}
						],
						finish: 'tool',
						usage
					}
				});
			return Stream.succeed({
				_tag: 'Response',
				response: { content: 'Done.', toolCalls: [], finish: 'stop', usage }
			});
		})
};

type Action = 'respond' | 'wait' | 'ignore';
/** The verdict a scripted conversation-level action means for every message it covers. */
const VERDICT: { readonly [a in Action]: string } = { respond: 'yes', wait: 'delay', ignore: 'no' };
/** What the decider was shown, read back from System 1's state and the questions it was asked. */
type Seen = {
	kind: string;
	directive: string;
	assistant: string;
	pending: readonly string[];
	asked: readonly string[];
};
const seen = (r: System1Request): Seen => {
	const st = Schema.decodeUnknownSync(
		Schema.Struct({
			directive: Schema.String,
			conversation: Schema.String,
			assistant: Schema.String,
			pending: Schema.Array(Schema.Struct({ text: Schema.String }))
		})
	)(r.state);
	return {
		kind: st.conversation,
		directive: st.directive,
		assistant: st.assistant,
		pending: st.pending.map((p) => p.text),
		asked: Object.keys(r.questions).filter((id) => id !== 'wait')
	};
};
/**
 * A scripted System 1: answers from `script` in order (the last answer repeats); `throws` makes it fail. One question is
 * asked per pending message, all in the one call, and the script's conversation-level action is what each gets — so a
 * scenario reads as it always did while the request shape is the per-message one.
 */
function decider() {
	const port: Pick<Ai['Service'], 'ask'> & {
		inputs: Seen[];
		answers: string[];
		script: (Action | { action: Action; wait: number; p?: number })[];
		throws: boolean;
	} = {
		inputs: [],
		answers: [],
		script: ['respond'],
		throws: false,
		ask: (r) =>
			Effect.gen(function* () {
				port.inputs.push(seen(r));
				if (port.throws)
					return yield* Effect.fail(Port.failure('sys_1')(new Error('provider down')));
				const s = port.script[Math.min(port.inputs.length - 1, port.script.length - 1)];
				if (s === undefined) throw new Error('decision script is empty');
				const d = typeof s === 'string' ? { action: s, wait: 2 } : s;
				port.answers.push(d.action);
				const p = 'p' in d && d.p !== undefined ? d.p : 0.9;
				const answers: Record<string, DecisionResult['answers'][string]> = {};
				for (const id of Object.keys(r.questions)) {
					if (id === 'wait') continue;
					answers[id] = {
						type: 'choice',
						choice: VERDICT[d.action],
						confidence: 0.9,
						probabilities: { [VERDICT[d.action]]: p }
					};
				}
				answers['wait'] = {
					type: 'score',
					score: d.wait,
					level: Math.round(d.wait),
					confidence: p,
					probabilities: {},
					legend: {}
				};
				return { answers, costUsd: 0.0002, provider: 'scripted' };
			})
	};
	return port;
}

let t: Kit,
	workspace: Context.Context<TestWorkspace | WorkspaceServices>,
	port: ReturnType<typeof decider>,
	triage: TriageService['Service'],
	agents: Agents['Service'],
	route: FixtureRoute;
const metered: { meter: string; quantity: number; key: string }[] = [];
const metering = Layer.succeed(Metering, {
	record: (meter, quantity, key) =>
		Effect.sync(() => {
			metered.push({ meter, quantity, key });
		})
});
const ADA = 'u-ada',
	CAL = 'u-cal';
const open = (o: { triage?: boolean; manifest?: EngineManifest } = {}) =>
	Effect.gen(function* () {
		port = decider();
		ai.requests = [];
		ai.raw = [];
		metered.length = 0;
		const ports =
			o.triage === false
				? metering
				: Layer.merge(
						metering,
						Layer.succeed(Ai, {
							...ai,
							ask: (request) => port.ask(request),
							maxChoices: undefined,
							catalog: Port.unavailable('ai.catalog'),
							embed: () => Port.unavailable('ai.embed')
						})
					);
		const context = yield* Layer.build(
			TestWorkspace.layer({ manifest: o.manifest ?? manifest, ports })
		);
		workspace = context;
		t = Context.get(context, TestWorkspace);
		triage = Context.get(context, TriageService);
		agents = Context.get(context, Agents);
		route = yield* routeFixture(context);
		yield* t.db.write({
			text: `INSERT INTO sys_user (id, email, name, admin, team, phone) VALUES
			('${ADA}', 'ada@ws.example', 'Ada', true, NULL, '+65 9123 4567'),
			('${CAL}', 'cal@ws.example', 'Cal', false, 't-con', '6598765432')`,
			params: []
		});
	});

const inWorkspace = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(workspace));
const post = (input: Parameters<TriageService['Service']['post']>[0]) =>
	inWorkspace(triage.post(input));

let seq = 0;
const DM = '6591234567@s.whatsapp.net',
	GROUP = { thread: '1203@g.us', group: true };
const say = (from: string, body: string, over: { [k: string]: Json } = {}) =>
	t.receive('field_wa', {
		id: `m${++seq}`,
		thread: from,
		sentAt: t.clock.now(),
		from: { handle: from, name: null },
		text: body,
		attachments: [],
		...over
	});
const q = (sql: string, ...params: Json[]) =>
	t.db.rows(Schema.Record(Schema.String, Schema.Json), { text: sql, params });
/** The decisions the kit host's runtime log holds, oldest first. */
const decisions = () =>
	Effect.sync(() =>
		t.fakes.logs
			.filter((r) => r.event === 'decision.made')
			.map(({ severity, attributes }) => ({ severity, attributes }))
	);
const row = (body: string) =>
	q(`SELECT state, addressed, delivered_turn, "as" FROM sys_message WHERE text = $1`, body).pipe(
		Effect.map((rows) => {
			const first = rows[0];
			if (first === undefined) throw new Error('message missing');
			return first;
		})
	);
const queued = () =>
	q(
		`SELECT input, due_at::text AS due FROM sys_run WHERE automation = 'agent.triage' AND state = 'queued'`
	);
const job = () =>
	Effect.gen(function* () {
		const o = (yield* actReply(route, t.as(t.admin).authority, {
			callable: 'jobs.create',
			input: { title: 'Kismis', status: 'open' },
			issuedAt: t.clock.now()
		})).outcome;
		if (o.kind !== 'committed' || o.records[0] === undefined) throw new Error(o.kind);
		return o.records[0].id;
	});
/** The trailing debounce elapses (P40): the queued decision is due. */
const debounce = () =>
	Effect.gen(function* () {
		t.clock.advance(`${TRIAGE_DEBOUNCE / 1000}s`);
		yield* t.runDue();
	});
const statusOf = (id: string) =>
	qReply(route, t.as(t.admin).authority, { reads: [{ m: 'get', a: ['jobs', id, {}] }] }).pipe(
		Effect.flatMap((reply) =>
			Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.String }))(reply.answers[0])
		),
		Effect.map((job) => job.status)
	);

/** Across every case: no decider `pending` holds a row an earlier decision admitted or ignored, and no pending row is delivered or ambient. */
const neverTwice = () =>
	Effect.gen(function* () {
		const done = new Set<string>();
		port.inputs.forEach((input, i) => {
			for (const p of input.pending) expect(done.has(p)).toBe(false);
			if (port.answers[i] !== 'wait') for (const p of input.pending) done.add(p);
		});
		expect(
			yield* q(
				`SELECT id FROM sys_message WHERE state = 'pending' AND (delivered_turn IS NOT NULL OR addressed = false)`
			)
		).toEqual([]);
	});

describe('envoy triage (G12 (10))', () => {
	it.live(
		'a pending photo goes into the state as metadata only (P37 (3)); a sys_1 refusing the call Unsupported admits as respond',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* open();
					const states: System1Request['state'][] = [];
					const scripted = port.ask.bind(port);
					port = {
						...port,
						ask: (r) =>
							Effect.gen(function* () {
								states.push(r.state);
								if (states.length === 2)
									return yield* Effect.fail(
										new FacilityFailure({ kind: 'unsupported', message: 'no images here' })
									);
								return yield* scripted(r);
							})
					};
					const photo = (text: string) =>
						Effect.gen(function* () {
							yield* t.receive(
								'field_wa',
								{
									id: `m${++seq}`,
									thread: DM,
									sentAt: t.clock.now(),
									from: { handle: DM, name: null },
									text,
									attachments: [{ name: 'p.jpg', mime: 'image/jpeg', bytes: 2, bin: 0 }]
								},
								{ bins: [new Uint8Array([9, 9])] }
							);
							yield* debounce();
						});
					yield* photo('the pump, see photo');
					const pending = Schema.decodeUnknownSync(
						Schema.Struct({
							pending: Schema.Array(
								Schema.Struct({ attachments: Schema.optionalKey(Schema.Array(Schema.Json)) })
							)
						})
					)(states[0]).pending;
					expect(pending[0]?.attachments?.[0]).toEqual({
						name: 'p.jpg',
						mime: 'image/jpeg',
						size: 2
					});
					yield* photo('and another one');
					expect(states).toHaveLength(2);
					expect((yield* row('and another one'))['delivered_turn']).not.toBeNull(); // the failure outcome: respond
					const events = (yield* decisions()).toSorted((a, b) =>
						a.severity.localeCompare(b.severity)
					);
					expect(
						events.map((e) => [
							e['severity'],
							Schema.decodeUnknownSync(Schema.Struct({ error: Schema.optionalKey(Schema.String) }))(
								e['attributes']
							).error ?? null,
							Schema.decodeUnknownSync(Schema.Struct({ action: Schema.String }))(e['attributes'])
								.action
						])
					).toEqual([
						['info', null, 'respond'],
						['warn', 'unsupported', 'respond']
					]);
				})
			)
	);

	it.live(
		'a DM in three parts within 20 s is one turn after the decider waits; each elapsed wait re-asks with the pending set as it is',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* open();
					port.script = ['wait', 'wait', 'wait', 'respond'];
					yield* say(DM, 'the Kismis job');
					yield* debounce();
					expect(port.inputs.map((i) => i.pending.length)).toEqual([1]);
					t.clock.advance('10s');
					yield* t.runDue(); // the wait elapsed: asked again, nothing new
					expect(port.inputs.map((i) => i.pending.length)).toEqual([1, 1]);
					// each part lands inside the 2 s wait (its admission is a run of the same wake as anything due by then)
					t.clock.advance('1s');
					yield* say(DM, 'is finished');
					yield* debounce(); // a new part re-triages once the sender pauses
					t.clock.advance('1s');
					yield* say(DM, 'mark it done please');
					yield* debounce();
					expect(port.inputs.map((i) => i.pending.length)).toEqual([1, 1, 2, 3]);
					expect(port.inputs[0]).toMatchObject({
						kind: 'envoy DM',
						assistant: 'Norbius',
						asked: ['m0'],
						directive: 'Keep jobs up to date.'
					});
					expect(ai.requests).toHaveLength(1);
					const turns = new Set(
						yield* Effect.forEach(
							['the Kismis job', 'is finished', 'mark it done please'],
							(b) => row(b).pipe(Effect.map((message) => message['delivered_turn'])),
							{ concurrency: 'unbounded' }
						)
					);
					expect(turns.size).toBe(1);
					expect([...turns][0]).not.toBeNull();
					expect(yield* queued()).toHaveLength(0); // an idle conversation queues no decision
					yield* neverTwice();
					const events = yield* decisions();
					expect(events).toHaveLength(4);
					expect(
						events.every(
							(e) =>
								Schema.decodeUnknownSync(Schema.Struct({ costUsd: Schema.Number }))(e['attributes'])
									.costUsd === 0.0002
						)
					).toBe(true);
					expect(metered).toHaveLength(4);
					expect(metered[0]).toMatchObject({ meter: 'ai', quantity: 0.0002 });
				})
			)
	);

	it.live(
		'a guessed wait (under 0.7) answers at once: silence costs the person, a coin flip is no reason for it',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* open();
					port.script = [{ action: 'wait', wait: 1, p: 0.58 }];
					yield* say(DM, 'run the review for the Kismis job');
					yield* debounce();
					expect(port.inputs).toHaveLength(1);
					expect(
						(yield* row('run the review for the Kismis job'))['delivered_turn']
					).not.toBeNull();
				})
			)
	);

	it.live(
		'a wait is at most 2 s, with the chat showing typing; after 12 consecutive waits the rows are admitted with no 13th call; a new row resets the count',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* open();
					port.script = [{ action: 'wait', wait: 2 }];
					yield* say(DM, 'part one');
					yield* debounce();
					expect(
						Date.parse(String((yield* queued())[0]?.['due'])) - Date.parse(t.clock.now())
					).toBe(2_000);
					// the person sees the assistant is on it rather than silence
					expect(t.fakes.links.typed).toEqual([{ instance: 'field_wa', to: DM }]);
					for (let i = 1; i < 5; i++) {
						t.clock.advance('10s');
						yield* t.runDue();
					}
					expect((yield* queued())[0]?.['input']).toMatchObject({ waits: 5 });
					yield* say(DM, 'part two');
					expect((yield* queued())[0]?.['input']).toMatchObject({ waits: 0 });
					t.clock.advance(`${TRIAGE_DEBOUNCE / 1000}s`);
					for (let i = 0; i <= TRIAGE_MAX_WAITS; i++) {
						yield* t.runDue();
						t.clock.advance('10s');
					}
					expect(port.inputs).toHaveLength(5 + TRIAGE_MAX_WAITS);
					expect(ai.requests).toHaveLength(1);
					expect((yield* row('part two'))['delivered_turn']).not.toBeNull();
					yield* neverTwice();
				})
			)
	);

	it.live(
		'group chatter the decider ignores makes no turn and stays readable; a mention admits the pending rows at once with no decision call',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* open();
					port.script = ['ignore'];
					yield* say(DM.replace('6591234567', '6598765432'), 'lunch?', GROUP);
					yield* debounce();
					expect(port.inputs[0]).toMatchObject({ kind: 'envoy group' });
					expect(yield* row('lunch?')).toMatchObject({
						state: null,
						addressed: false,
						delivered_turn: null
					});
					expect(ai.requests).toHaveLength(0);

					const calls = port.inputs.length;
					yield* say(DM, 'the van is late', GROUP);
					yield* say(DM, '@bot note that', { ...GROUP, invocation: 'mention' });
					expect(port.inputs).toHaveLength(calls);
					expect(ai.requests).toHaveLength(1);
					expect(ai.requests[0]).not.toContain('lunch?'); // ignored: never new input
					expect((yield* row('the van is late'))['delivered_turn']).toBe(
						(yield* row('@bot note that'))['delivered_turn']
					);
					yield* debounce(); // the decision the chatter queued was flushed
					expect(port.inputs).toHaveLength(calls);
					yield* neverTwice();
				})
			)
	);

	it.live(
		'an ignored photo is what read_messages reads, and a mention quoting it carries its text and file into the turn',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* open();
					port.script = ['ignore'];
					yield* t.receive(
						'field_wa',
						{
							id: 'photo1',
							...GROUP,
							sentAt: t.clock.now(),
							from: { handle: DM, name: 'Dion' },
							text: 'Put this in to kismi',
							attachments: [{ name: 'p.jpg', mime: 'image/jpeg', bytes: 2, bin: 0 }]
						},
						{ bins: [new Uint8Array([9, 9])] }
					);
					yield* debounce();
					expect(yield* row('Put this in to kismi')).toMatchObject({
						state: null,
						addressed: false
					});

					yield* say(DM, '@bot check the chatter', {
						...GROUP,
						invocation: 'mention',
						replyTo: 'photo1'
					});
					const turn = ai.raw[0]?.join('\n');
					expect(turn).toContain('[replying to Dion');
					expect(turn).toContain('Put this in to kismi');
					expect(turn).toMatch(/attachment seq \d+ file 0: p\.jpg/);
					const [read] = yield* q(
						`SELECT content FROM sys_message WHERE role = 'tool' AND content->>'name' = 'read_messages'`
					);
					expect(JSON.stringify(read?.['content'])).toContain('Put this in to kismi');
				})
			)
	);

	it.live(
		'triaged group chatter is charged like an addressed message: over envoys.receive it stays unaddressed, unanswered and never decided',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* open();
					yield* open({
						manifest: Result.getOrThrow(
							decodeManifest({
								...manifest,
								policies: {
									...manifest.policies,
									desk: {
										...manifest.policies['desk'],
										limits: { 'envoys.receive': [{ rate: '2/min', per: 'sender' }] }
									}
								}
							})
						)
					});
					port.script = ['ignore'];
					const cal = DM.replace('6591234567', '6598765432');
					for (const n of [1, 2, 3]) yield* say(cal, `chat ${n}`, GROUP);
					yield* debounce();
					expect(
						(yield* q(`SELECT state, addressed, refused FROM sys_message WHERE text = 'chat 3'`))[0]
					).toEqual({ state: null, addressed: false, refused: null });
					expect(port.inputs.flatMap((i) => i.pending)).not.toContain('chat 3');
					expect(t.fakes.links.sent).toHaveLength(0); // no "slow down" line into the group
				})
			)
	);

	it.live(
		"a collated group turn acts under the envoy's policy (P32), each sender header in its input",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* open();
					const [mine, theirs] = [yield* job(), yield* job()];
					yield* say('6598765432@s.whatsapp.net', `close ${theirs}`, GROUP); // Cal, a contractor
					yield* say(DM, `close ${mine}`, GROUP); // Ada, an administrator
					yield* debounce();
					expect(port.inputs[0]?.pending).toHaveLength(2);
					expect(ai.raw.at(-1)?.join()).toMatch(/linked member u-cal[\s\S]*linked member u-ada/); // both sender headers
					expect(yield* statusOf(mine)).toBe('open'); // `desk` reads only, whoever the administrator is
					expect(yield* statusOf(theirs)).toBe('open');
				})
			)
	);

	it.live(
		'a failed System 1 call answers a DM but keeps a group quiet (ambient); the failure is recorded, nothing is metered',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* open();
					port.throws = true;
					yield* say(DM, 'hello');
					yield* say('6598765432@s.whatsapp.net', 'chatter', GROUP);
					yield* debounce();
					expect((yield* row('hello'))['delivered_turn']).not.toBeNull();
					expect(yield* row('chatter')).toMatchObject({ delivered_turn: null, addressed: false });
					const events = yield* decisions();
					expect(events.length).toBeGreaterThan(0);
					expect(
						events.every(
							(e) =>
								e['severity'] === 'warn' &&
								Schema.decodeUnknownSync(
									Schema.Struct({ error: Schema.optionalKey(Schema.String) })
								)(e['attributes']).error === 'upstream'
						)
					).toBe(true);
					expect(metered).toHaveLength(0);
				})
			)
	);

	it.live(
		'an envoy without a display name is asked about generically, never as an empty name',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* open();
					// `name` is optional; a nameless envoy uses the generic assistant wording.
					const nameless = Result.getOrThrow(
						decodeManifest({
							...manifest,
							envoys: {
								field_ops: {
									audience: 'private',
									policies: ['desk'],
									groupMessages: 'mention_or_reply',
									delegation: 'disabled',
									triage: {},
									task: 'Keep jobs up to date.'
								}
							}
						})
					);
					yield* open({ manifest: nameless });
					yield* say(DM, 'hello');
					yield* debounce();
					expect(port.inputs[0]?.assistant).toBe('the assistant');
					expect(port.inputs[0]?.assistant).not.toBe('');
					expect((yield* row('hello'))['delivered_turn']).not.toBeNull();
				})
			)
	);

	it.live('with no AI facility every message behaves as without triage', () =>
		Effect.scoped(
			Effect.gen(function* () {
				yield* open();
				yield* open({ triage: false });
				yield* say(DM, 'hello');
				expect((yield* row('hello'))['delivered_turn']).not.toBeNull();
				yield* say(DM, 'chatter', GROUP);
				expect(yield* row('chatter')).toMatchObject({ state: null, delivered_turn: null });
				expect(yield* queued()).toHaveLength(0);
			})
		)
	);
});

describe('in-app triage', () => {
	const start = () => inWorkspace(agents.start({ owner: ADA }));
	it.live(
		'two plain-Enter parts are one turn; a one-to-one chat is never offered ignore and reads it as respond',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* open();
					const c = yield* start();
					port.script = ['wait', 'ignore'];
					yield* post({
						conversation: c,
						as: { member: ADA },
						text: 'draft a note',
						author: ADA,
						mode: 'agent'
					});
					yield* debounce();
					yield* post({
						conversation: c,
						as: { member: ADA },
						text: 'for the Kismis job',
						author: ADA,
						mode: 'agent'
					});
					yield* debounce();
					// one question per pending message, both parts of the second decision in the same call; in-app the agent is Norbius
					expect(
						port.inputs.map((i) => [i.kind, i.assistant, i.asked.length, i.pending.length])
					).toEqual([
						['in-app, one-to-one', 'Norbius', 1, 1],
						['in-app, one-to-one', 'Norbius', 2, 2]
					]);
					expect(ai.requests).toHaveLength(1);
					expect(ai.requests[0]).toEqual(['draft a note', 'for the Kismis job']);
					yield* neverTwice();
				})
			)
	);

	it.live(
		"a plain-Enter post keeps the person's timezone on its row, as a send-now does (rule 57)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* open();
					const c = yield* start();
					yield* post({
						conversation: c,
						as: { member: ADA },
						text: 'what time is it',
						author: ADA,
						mode: 'agent',
						tz: 'Asia/Singapore'
					});
					expect(
						(yield* q(`SELECT content FROM sys_message WHERE text = 'what time is it'`))[0]?.[
							'content'
						]
					).toEqual({ text: 'what time is it', tz: 'Asia/Singapore' });
				})
			)
	);

	it.live('send-now admits every pending row at once and asks no decider', () =>
		Effect.scoped(
			Effect.gen(function* () {
				yield* open();
				const c = yield* start();
				yield* post({
					conversation: c,
					as: { member: ADA },
					text: 'part',
					author: ADA,
					mode: 'agent'
				});
				yield* inWorkspace(triage.release(c));
				yield* inWorkspace(
					agents.post({ conversation: c, as: { member: ADA }, text: 'now', author: ADA })
				);
				yield* inWorkspace(agents.drain(c));
				expect(ai.requests).toEqual([['part', 'now']]);
				yield* t.runDue();
				expect(port.inputs).toHaveLength(0);
			})
		)
	);

	it.live('a shared conversation may be ignored: the rows become ambient and start nothing', () =>
		Effect.scoped(
			Effect.gen(function* () {
				yield* open();
				const c = yield* start();
				port.script = ['ignore'];
				yield* post({
					conversation: c,
					as: { member: ADA },
					text: 'one',
					author: ADA,
					mode: 'agent'
				});
				yield* post({
					conversation: c,
					as: { member: CAL },
					text: 'two',
					author: CAL,
					mode: 'agent'
				});
				yield* debounce();
				expect(port.inputs[0]).toMatchObject({
					kind: 'in-app, shared',
					assistant: 'Norbius',
					asked: ['m0', 'm1']
				});
				expect(yield* row('two')).toMatchObject({ addressed: false, delivered_turn: null });
				expect(ai.requests).toHaveLength(0);
			})
		)
	);

	it.live(
		'a message that names the assistant is answered like a mention, in a shared conversation too: no decision call',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* open();
					// seen on staging: "Hello norbius" in a shared panel conversation was judged "Not for the assistant"
					const c = yield* start();
					port.script = ['ignore'];
					yield* post({
						conversation: c,
						as: { member: ADA },
						text: 'one',
						author: ADA,
						mode: 'agent'
					});
					yield* post({
						conversation: c,
						as: { member: CAL },
						text: 'two',
						author: CAL,
						mode: 'agent'
					});
					yield* debounce(); // shared, and the decider ignores the chatter
					expect(yield* row('two')).toMatchObject({ addressed: false, delivered_turn: null });
					const calls = port.inputs.length;
					yield* post({
						conversation: c,
						as: { member: ADA },
						text: 'Hello norbius',
						author: ADA,
						mode: 'agent'
					});
					yield* debounce();
					expect(port.inputs).toHaveLength(calls);
					expect((yield* row('Hello norbius'))['delivered_turn']).not.toBeNull();
					expect(ai.requests.at(-1)).toContain('Hello norbius');
				})
			)
	);

	it.live('`agent: { triage: false }` opts the in-app agent out', () =>
		Effect.scoped(
			Effect.gen(function* () {
				yield* open();
				expect(triage.inApp()).toBe(true);
				const off = yield* Layer.build(
					TestWorkspace.layer({
						manifest: {
							...manifest,
							workspace: { ...manifest.workspace, agent: { triage: false } }
						},
						ports: Layer.succeed(Ai, {
							...ai,
							ask: (request) => port.ask(request),
							maxChoices: undefined,
							catalog: Port.unavailable('ai.catalog'),
							embed: () => Port.unavailable('ai.embed')
						})
					})
				);
				expect(Context.get(off, TriageService).inApp()).toBe(false);
			})
		)
	);
});
