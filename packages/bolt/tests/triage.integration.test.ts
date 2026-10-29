// System 1 triage (P31, P33, rule 60a; §11.2 G12 (10)) through the engine entry and the test kit: a scripted
// `sys_1` (no vendor) decides when admitted envoy and in-app messages start a turn; the kit's clock drives each exact-time
// re-check. Mentions and send-now are deterministic, and a row is new input at most once.
import { describe, expect, it } from '@effect/vitest';
import { afterAll } from 'vitest';
import { Context, Effect, Exit, Layer, Predicate, Result, Schema, Scope, Stream } from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Agents } from '../src/engine/services.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';
import { TRIAGE_DEBOUNCE, TriageService } from '../src/engine/agent/triage.ts';
import type { DecisionResult, System1Request } from '../src/engine/decisions/index.ts';
import { TestWorkspace, type Kit, type WorkspaceServices } from '../../bolt-cli/src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
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
			desk: { description: 'Desk', grants: { jobs: { read: true } } },
			contractor: { description: 'Contractors', grants: { jobs: { read: true } } }
		},
		teams: { 't-con': { name: 'Contractors', policies: ['contractor'] } },
		automations: {},
		connections: {
			field_wa: { integration: 'whatsapp', envoy: 'field_ops' }
		},
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

/** A user message's text without its envelope's sender header (`[who] `). */
const text = (c: Json) =>
	(typeof c === 'string' ? c : Predicate.isObject(c) ? String(c['text'] ?? '') : '').replace(
		/^\[[^\]]*\]\s*/,
		''
	);
/** The model: records each call's user lines; "needs a contractor" is answered with a question back to its sender. */
const ai: Pick<Ai['Service'], 'models' | 'infer'> & { requests: string[][] } = {
	models: ['default'],
	requests: [],
	infer: (request) =>
		Stream.suspend((): ReturnType<Ai['Service']['infer']> => {
			const lines = request.messages
				.filter(
					(m) =>
						m.role === 'user' &&
						!String(typeof m.content === 'string' ? m.content : '').startsWith(
							'[conversation state'
						)
				)
				.map((m) => text(m.content));
			ai.requests.push(lines);
			const asks = lines.some((s) => s.includes('needs a contractor'));
			return Stream.succeed({
				_tag: 'Response',
				response: {
					content: asks ? 'Want me to assign a contractor to them?' : 'Done.',
					toolCalls: [],
					finish: 'stop',
					usage: { input: 10, output: 5 }
				}
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
	exchange?: { talkingWith: string; assistantLastMessage: string };
};
const seen = (r: System1Request): Seen => {
	const st = Schema.decodeUnknownSync(
		Schema.Struct({
			directive: Schema.String,
			conversation: Schema.String,
			assistant: Schema.String,
			pending: Schema.Array(Schema.Struct({ text: Schema.String })),
			talkingWith: Schema.optionalKey(Schema.String),
			assistantLastMessage: Schema.optionalKey(Schema.String)
		})
	)(r.state);
	return {
		kind: st.conversation,
		directive: st.directive,
		assistant: st.assistant,
		pending: st.pending.map((p) => p.text),
		asked: Object.keys(r.questions).filter((id) => id !== 'wait'),
		...(st.talkingWith === undefined || st.assistantLastMessage === undefined
			? {}
			: {
					exchange: {
						talkingWith: st.talkingWith,
						assistantLastMessage: st.assistantLastMessage
					}
				})
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
	agents: Agents['Service'];
const ADA = 'u-ada',
	CAL = 'u-cal';
/** A case inside a shared workspace starts from a fresh decider and model log, and reads decisions from here on. */
let logged = 0;
const fresh = () => {
	port = decider();
	ai.requests = [];
	logged = t.fakes.logs.length;
};
// One workspace for the file: each case starts an hour on (no exchange or rate window carries over), uses its own
// texts, and leaves no turn running.
const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const shared = Effect.runSync(
	Effect.cached(
		Effect.gen(function* () {
			const context = yield* Layer.build(
				TestWorkspace.layer({
					manifest,
					ports: Layer.succeed(Ai, {
						...ai,
						ask: (request) => port.ask(request),
						maxChoices: undefined,
						catalog: Port.unavailable('ai.catalog'),
						embed: () => Port.unavailable('ai.embed')
					})
				})
			);
			workspace = context;
			t = Context.get(context, TestWorkspace);
			triage = Context.get(context, TriageService);
			agents = Context.get(context, Agents);
			yield* t.db.write({
				text: `INSERT INTO sys_user (id, email, name, admin, team, phone) VALUES
			('${ADA}', 'ada@ws.example', 'Ada', true, NULL, '+65 9123 4567'),
			('${CAL}', 'cal@ws.example', 'Cal', false, 't-con', '6598765432')`,
				params: []
			});
		}).pipe(Scope.provide(fileScope))
	)
);
const open = () =>
	Effect.gen(function* () {
		yield* shared;
		t.clock.advance('1h');
		fresh();
	});

const inWorkspace = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(workspace));
const post = (input: Parameters<TriageService['Service']['post']>[0]) =>
	inWorkspace(triage.post(input));

let seq = 0;
const DM = '6591234567@s.whatsapp.net',
	CAL_WA = '6598765432@s.whatsapp.net',
	GROUP = { thread: '1203@g.us', group: true };
/** A group of its own, for a case sharing a workspace. */
const group = (n: number) => ({ thread: `12${n}@g.us`, group: true });
const say = (from: string, body: string, over: { [k: string]: Json } = {}, instance = 'field_wa') =>
	t.receive(instance, {
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
			.slice(logged)
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
/** The trailing debounce elapses (P40): the queued decision is due. */
const debounce = () =>
	Effect.gen(function* () {
		t.clock.advance(`${TRIAGE_DEBOUNCE / 1000}s`);
		yield* t.runDue();
	});
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
	it.live('DM parts are one decision once the sender pauses; a wait defers by at most 2 s', () =>
		Effect.gen(function* () {
			yield* open();
			yield* say(DM, 'the Kismis job');
			t.clock.advance('1s');
			yield* say(DM, 'is finished');
			t.clock.advance('1s');
			yield* say(DM, 'mark it done please');
			// the pause follows the last part (+2 s), well inside the first part's cap (+6 s)
			expect(Date.parse(String((yield* queued())[0]?.['due'])) - Date.parse(t.clock.now())).toBe(
				TRIAGE_DEBOUNCE
			);
			yield* debounce();
			expect(port.inputs.map((i) => i.pending.length)).toEqual([3]);
			expect(port.inputs[0]).toMatchObject({
				kind: 'envoy DM',
				directive: 'Keep jobs up to date.'
			});
			expect(ai.requests).toHaveLength(1);
			const turns = new Set(
				yield* Effect.forEach(['the Kismis job', 'is finished', 'mark it done please'], (b) =>
					row(b).pipe(Effect.map((message) => message['delivered_turn']))
				)
			);
			expect(turns.size).toBe(1);
			expect([...turns][0]).not.toBeNull();
			expect(yield* queued()).toHaveLength(0);
			yield* neverTwice();
			yield* t.settled();

			fresh();
			port.script = [{ action: 'wait', wait: 2 }];
			yield* say(CAL_WA, 'part one');
			yield* debounce();
			expect(Date.parse(String((yield* queued())[0]?.['due'])) - Date.parse(t.clock.now())).toBe(
				2_000
			);
			t.clock.advance('2s');
			yield* t.runDue();
			expect(port.inputs).toHaveLength(1); // one wait is the whole allowance
			expect((yield* row('part one'))['delivered_turn']).not.toBeNull();
			yield* t.settled();
		})
	);

	it.live('a failed sys_1 answers a DM, keeps a group quiet and is recorded', () =>
		Effect.gen(function* () {
			yield* open();
			port.throws = true;
			yield* say(DM, 'failing hello');
			yield* say(CAL_WA, 'failing chatter', GROUP);
			yield* debounce();
			expect((yield* row('failing hello'))['delivered_turn']).not.toBeNull();
			expect(yield* row('failing chatter')).toMatchObject({
				delivered_turn: null,
				addressed: false
			});
			const failed = (yield* decisions()).map(
				(e) =>
					[
						e.severity,
						Schema.decodeUnknownSync(Schema.Struct({ error: Schema.optionalKey(Schema.String) }))(
							e.attributes
						).error
					] as const
			);
			expect(failed.length).toBeGreaterThan(0);
			expect(failed.every(([severity, error]) => severity === 'warn' && error === 'upstream')).toBe(
				true
			);
			yield* t.settled();
		})
	);

	it.live('in a group an ignore makes no turn; a mention admits the pending rows with it', () =>
		Effect.gen(function* () {
			yield* open();
			port.script = ['ignore'];
			yield* say(CAL_WA, 'lunch?', group(1));
			yield* debounce();
			expect(port.inputs[0]).toMatchObject({ kind: 'envoy group' });
			expect(yield* row('lunch?')).toMatchObject({
				state: null,
				addressed: false,
				delivered_turn: null
			});
			expect(ai.requests).toHaveLength(0);
			const calls = port.inputs.length;
			yield* say(DM, 'the van is late', group(1));
			yield* say(DM, '@bot note that', { ...group(1), invocation: 'mention' });
			yield* debounce();
			expect(port.inputs).toHaveLength(calls);
			expect(ai.requests).toHaveLength(1);
			expect(ai.requests[0]).not.toContain('lunch?'); // ignored: never new input
			expect((yield* row('the van is late'))['delivered_turn']).toBe(
				(yield* row('@bot note that'))['delivered_turn']
			);
			yield* neverTwice();
			yield* t.settled();
		})
	);

	it.live("an asked person's unnamed answer continues the exchange without the decider", () =>
		Effect.gen(function* () {
			yield* open();
			port.script = ['ignore'];
			yield* say(DM, '@bot the Kismis job needs a contractor', {
				...group(2),
				invocation: 'mention'
			});
			yield* debounce();
			expect(port.inputs).toHaveLength(0);
			yield* t.settled();
			t.clock.advance('1min');
			yield* say(DM, 'Ya put bob under them', group(2));
			yield* debounce();
			expect(port.inputs).toHaveLength(0);
			expect((yield* row('Ya put bob under them'))['delivered_turn']).not.toBeNull();
			yield* t.settled();
		})
	);
});

describe('in-app triage', () => {
	const start = () => inWorkspace(agents.start({ owner: ADA }));
	// send-now and respond-now through their callables: triage-panel.integration
	it.live('one-to-one parts are one turn and never ignored', () =>
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
			// one question per pending message, both parts of the second decision in the same call
			expect(port.inputs.map((i) => [i.kind, i.asked.length, i.pending.length])).toEqual([
				['in-app, one-to-one', 1, 1],
				['in-app, one-to-one', 2, 2]
			]);
			expect(ai.requests).toEqual([['draft a note', 'for the Kismis job']]);
			yield* neverTwice();
		})
	);
});
