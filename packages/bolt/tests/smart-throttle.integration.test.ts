import { with_accounts } from './support/accounts.ts';
import { with_envoys } from './support/envoys.ts';
// The smart throttle through the engine entry and the test kit: a scripted `sys_1`
// (no vendor) decides whether admitted envoy and in-app messages hold or, in an envoy's group, are filtered. It holds at
// most 3 s and once, never filters a direct conversation, and never wedges: whatever happens to a decision, every pending
// message stays covered by a queued run until it leaves `pending`.
import { describe, expect, it } from '@effect/vitest';
import { afterAll } from 'vitest';
import {
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Predicate,
	Result,
	Schema,
	Scope,
	Stream
} from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { type DecisionRequest, type DecisionResult, Port } from '@norbital-ai/host-api';
import { Agents } from '../src/engine/services.ts';
import { decode_projected_manifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';
import { HOLD_MAX_MS, SmartThrottle, TAKEOVER_MS } from '../src/engine/agent/throttle.ts';
import { TestWorkspace, type Kit, type WorkspaceServices } from '../../bolt-cli/src/test/index.ts';

const runtime_accounts = [
	{ id: 'field_wa', integration: 'whatsapp', status: { state: 'connected' } },
] as const;

const manifest = Result.getOrThrow(
	decode_projected_manifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			jobs: {
				description: 'A job',
				record_label: 'record.title',
				fields: { title: { kind: 'text' }, status: { kind: 'text' } }
			}
		},
		relationships: {},
		exposures: {
			jobs: {
				outputs: { default: { jobs: { fields: 'all' } } },
				create: { columns: { jobs: ['title', 'status'] } },
				update: { columns: { jobs: ['status'] } }
			}
		},
		integrations: {},
		policies: {
			desk: { description: 'Desk', grants: { jobs: { outputs: { default: {} } } } },
			contractor: { description: 'Contractors', grants: { jobs: { outputs: { default: {} } } } }
		},
		teams: { 't-con': { name: 'Contractors', policies: ['contractor'] } },
		automations: {},
		

		mcp: {},
		apps: {},
		custom_fields: {},
		agent: { internal: 'Staff brief.', skills: {} }
	})
);
const fieldOpsEnvoy = '0199a000-0000-7000-8000-0000000000e1';
const runtimeEnvoys = [
	{
		id: fieldOpsEnvoy,
		accounts: ['field_wa'],
		audience: 'private',
		name: 'Norbius',
		policies: ['desk'],
		group_messages: 'mention_or_reply',
		delegation: 'disabled',
		triage: true,
		task: 'Keep jobs up to date.'
	}
] as const;

/** A user message's text without its envelope's sender header (`[who] `). */
const text = (c: Json) =>
	(typeof c === 'string' ? c : Predicate.isObject(c) ? String(c['text'] ?? '') : '').replace(
		/^\[[^\]]*\]\s*/,
		''
	);
/** The model: records each call's user lines; "needs a contractor" is answered with a question back to its sender. */
const ai: Pick<Ai['Service'], 'models' | 'infer'> & {
	requests: string[][];
	/** While set, the model's answer waits here: the turn stays running. */
	gate: Deferred.Deferred<void> | null;
} = {
	models: ['default'],
	requests: [],
	gate: null,
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
			const gate = ai.gate;
			return Stream.fromEffect(gate === null ? Effect.void : Deferred.await(gate)).pipe(
				Stream.map(() => ({
					_tag: 'Response' as const,
					response: {
						content: asks ? 'Want me to assign a contractor to them?' : 'Done.',
						tool_calls: [],
						finish: 'stop' as const,
						usage: { input: 10, output: 5 }
					}
				}))
			);
		})
};

type Action = 'respond' | 'wait' | 'ignore';
/** What the decider was shown, read back from System 1's state and the questions it was asked. */
type Seen = {
	kind: string;
	directive: string;
	assistant: string;
	pending: readonly string[];
	earlier: readonly { readonly text: string; readonly filtered?: boolean }[];
	asked: readonly string[];
	exchange?: { talkingWith: string; assistantLastMessage: string };
};
const seen = (r: DecisionRequest): Seen => {
	const st = Schema.decodeUnknownSync(
		Schema.Struct({
			directive: Schema.String,
			conversation: Schema.String,
			assistant: Schema.String,
			earlier: Schema.Array(
				Schema.Struct({ text: Schema.String, filtered: Schema.optionalKey(Schema.Boolean) })
			),
			pending: Schema.Array(Schema.Struct({ text: Schema.String })),
			talkingWith: Schema.optionalKey(Schema.String),
			assistantLastMessage: Schema.optionalKey(Schema.String)
		})
	)(r.state);
	return {
		kind: st.conversation,
		directive: st.directive,
		assistant: st.assistant,
		earlier: st.earlier,
		pending: st.pending.map((p) => p.text),
		asked: Object.keys(r.questions),
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
/** A scripted System 1: answers from `script` in order (the last answer repeats); `mode` makes it fail, hang or die. */
function decider() {
	const port: Pick<Ai['Service'], 'ask'> & {
		inputs: Seen[];
		answers: Action[];
		script: (Action | { action: Action; hold: number; p?: number })[];
		mode: 'answers' | 'throws' | 'hangs';
	} = {
		inputs: [],
		answers: [],
		script: ['respond'],
		mode: 'answers',
		ask: (r) =>
			Effect.gen(function* () {
				port.inputs.push(seen(r));
				if (port.mode === 'throws')
					return yield* Effect.fail(Port.failure('sys_1')(new Error('provider down')));
				if (port.mode === 'hangs') return yield* Effect.never;
				const s = port.script[Math.min(port.inputs.length - 1, port.script.length - 1)];
				if (s === undefined) throw new Error('decision script is empty');
				const d = typeof s === 'string' ? { action: s, hold: 2 } : s;
				port.answers.push(d.action);
				const p = 'p' in d && d.p !== undefined ? d.p : 0.9;
				const answers: Record<string, DecisionResult['answers'][string]> = {};
				for (const id of Object.keys(r.questions)) {
					if (id === 'text')
						answers[id] = {
							type: 'choice',
							choice: d.action === 'wait' ? 'partial' : 'complete',
							confidence: 0.9,
							probabilities: d.action === 'wait' ? { partial: p } : { complete: p }
						};
					else if (id === 'hold')
						answers[id] = {
							type: 'score',
							score: d.hold,
							level: Math.min(3, Math.round(d.hold)),
							confidence: p,
							probabilities: {},
							legend: {}
						};
					else
						answers[id] = {
							type: 'choice',
							choice: d.action === 'ignore' ? 'filter' : 'answer',
							confidence: 0.9,
							probabilities: {}
						};
				}
				return { answers, cost_usd: 0.0002, provider: 'scripted' };
			})
	};
	return port;
}

let t: Kit,
	workspace: Context.Context<TestWorkspace | WorkspaceServices>,
	port: ReturnType<typeof decider>,
	throttle: SmartThrottle['Service'],
	agents: Agents['Service'];
const ADA = 'u-ada',
	CAL = 'u-cal';
/** A case inside a shared workspace starts from a fresh decider and model log, and reads decisions from here on. */
let logged = 0;
const fresh = () => {
	port = decider();
	ai.requests = [];
	ai.gate = null;
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
				with_envoys(
					with_accounts(TestWorkspace.layer({
						manifest,
						ports: Layer.succeed(Ai, {
							...ai,
							ask: (request) => port.ask(request),
							maxChoices: undefined,
							catalog: Port.unavailable('ai.catalog'),
							embed: () => Port.unavailable('ai.embed')
						})
					}), runtime_accounts),
					runtimeEnvoys
				)
			);
			workspace = context;
			t = Context.get(context, TestWorkspace);
			throttle = Context.get(context, SmartThrottle);
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
const post = (input: Parameters<SmartThrottle['Service']['post']>[0]) =>
	inWorkspace(throttle.post(input).pipe(Effect.andThen(throttle.settled)));

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
		sent_at: t.clock.now(),
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
const until = (seconds: number) =>
	new Date(Date.parse(t.clock.now()) + seconds * 1000).toISOString();
/** Nothing is ever left waiting on a decision that will not come: every pending row has a queued run. */
const covered = () =>
	q(
		`SELECT m.id FROM sys_message m WHERE m.state = 'pending' AND NOT EXISTS (SELECT 1 FROM sys_run r WHERE r.automation = 'agent.triage'
		AND r.state = 'queued' AND r.input->>'conversation' = m.conversation)`
	).pipe(Effect.map((rows) => expect(rows).toEqual([])));
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

describe('hold: at most 3 s, once', () => {
	it.live('a complete message goes at once, asked once', () =>
		Effect.gen(function* () {
			yield* open();
			yield* say(DM, 'mark the Bismis job done');
			yield* t.settled();
			expect(port.inputs.map((i) => i.asked)).toEqual([['text', 'hold']]);
			expect((yield* row('mark the Bismis job done'))['delivered_turn']).not.toBeNull();
			expect(yield* queued()).toEqual([]);
		})
	);
	it.live('a partial message holds; what arrives joins it, and its end asks nothing more', () =>
		Effect.gen(function* () {
			yield* open();
			port.script = [{ action: 'wait', hold: 2 }];
			yield* say(DM, 'the Bismis job and');
			yield* covered();
			expect(yield* row('the Bismis job and')).toMatchObject({ state: 'pending' });
			expect(String((yield* queued())[0]?.['due'])).toBe(
				(yield* q(`SELECT $1::timestamptz::text AS due`, until(2)))[0]?.['due']
			);
			t.clock.advance('1s');
			yield* say(DM, 'the van');
			yield* covered();
			expect(port.inputs).toHaveLength(1);
			t.clock.advance('1s');
			yield* t.run_due();
			yield* t.settled();
			expect(port.inputs).toHaveLength(1); // a hold is spent once: nothing is left to ask a direct conversation
			expect(ai.requests).toHaveLength(1);
			expect(ai.requests[0]?.slice(-2)).toEqual(['the Bismis job and', 'the van']);
			expect(yield* queued()).toEqual([]);
		})
	);
	it.live('a hold never passes 3 s, however long the decider asks for', () =>
		Effect.gen(function* () {
			yield* open();
			port.script = [{ action: 'wait', hold: 3.4 }];
			yield* say(DM, 'one long');
			expect(String((yield* queued())[0]?.['due'])).toBe(
				(yield* q(`SELECT $1::timestamptz::text AS due`, until(HOLD_MAX_MS / 1000)))[0]?.['due']
			);
			t.clock.advance('3s');
			yield* t.run_due();
			yield* t.settled();
			expect((yield* row('one long'))['delivered_turn']).not.toBeNull();
		})
	);
	it.live('below the confidence bar a partial is no hold', () =>
		Effect.gen(function* () {
			yield* open();
			port.script = [{ action: 'wait', hold: 2, p: 0.5 }];
			yield* say(DM, 'perhaps partial');
			yield* t.settled();
			expect((yield* row('perhaps partial'))['delivered_turn']).not.toBeNull();
		})
	);
});

describe('filter: only an envoy group', () => {
	it.live('a direct message is never filtered, and is not asked whether to be', () =>
		Effect.gen(function* () {
			yield* open();
			port.script = ['ignore'];
			yield* say(DM, 'asdfgh');
			yield* t.settled();
			expect(port.inputs[0]?.asked).toEqual(['text', 'hold']);
			expect((yield* row('asdfgh'))['delivered_turn']).not.toBeNull();
		})
	);
	it.live('in-app is direct, even when more than one person has posted', () =>
		Effect.gen(function* () {
			yield* open();
			const c = yield* inWorkspace(agents.start({ owner: ADA }));
			port.script = ['ignore'];
			for (const [as, text] of [
				[ADA, 'first of ours'],
				[CAL, 'second of ours']
			] as const)
				yield* post({ conversation: c, as: { member: as }, text, author: as, mode: 'agent' });
			expect(port.inputs.flatMap((i) => i.asked)).not.toContain('m0');
			expect(port.inputs.map((i) => i.kind)).toContain('in-app');
			expect((yield* row('second of ours'))['delivered_turn']).not.toBeNull();
		})
	);
	it.live('a panel message with a file is complete: it goes without the decider', () =>
		Effect.gen(function* () {
			yield* open();
			const c = yield* inWorkspace(agents.start({ owner: ADA }));
			const asked = port.inputs.length;
			yield* post({
				conversation: c,
				as: { member: ADA },
				text: 'file this form',
				author: ADA,
				mode: 'agent',
				files: [{ id: 'f', name: 'form.pdf', mime: 'application/pdf' }]
			});
			expect(port.inputs).toHaveLength(asked);
			expect((yield* row('file this form'))['delivered_turn']).not.toBeNull();
		})
	);
	it.live('a group judges each message; the one filtered never reaches the model', () =>
		Effect.gen(function* () {
			yield* open();
			port.script = ['ignore'];
			yield* say(CAL_WA, 'lunch?', group(1));
			yield* t.settled();
			expect(port.inputs[0]).toMatchObject({ kind: 'envoy group', asked: ['m0', 'text', 'hold'] });
			expect(yield* row('lunch?')).toMatchObject({
				state: null,
				addressed: false,
				delivered_turn: null
			});
			expect(ai.requests).toHaveLength(0);
			const calls = port.inputs.length;
			yield* say(DM, '@bot note that', { ...group(1), invocation: 'mention' });
			yield* t.settled();
			expect(port.inputs).toHaveLength(calls); // a mention needs no decider
			expect(ai.requests).toHaveLength(1);
			expect(ai.requests[0]).not.toContain('lunch?');
			yield* neverTwice();
		})
	);
	it.live('the window: a message that only makes sense with filtered ones goes through', () =>
		Effect.gen(function* () {
			yield* open();
			port.script = ['ignore', 'ignore', 'respond'];
			yield* say(CAL_WA, 'qx-77 again?', group(3));
			yield* say(DM, 'van is outside', group(3));
			yield* t.settled();
			t.clock.advance('15min');
			yield* say(CAL_WA, 'about the qx-77 from earlier: mark it done', group(3));
			yield* t.settled();
			// the decider read the filtered messages beside the new one
			expect(port.inputs.at(-1)?.earlier).toEqual([
				expect.objectContaining({ text: 'qx-77 again?', filtered: true }),
				expect.objectContaining({ text: 'van is outside', filtered: true })
			]);
			expect(
				(yield* row('about the qx-77 from earlier: mark it done'))['delivered_turn']
			).not.toBeNull();
			// they stay history for `read_messages`, never new input
			expect(ai.requests.flat()).not.toContain('van is outside');
			expect(yield* row('qx-77 again?')).toMatchObject({ addressed: false, delivered_turn: null });
		})
	);
	it.live("an asked person's unnamed answer continues the exchange without the decider", () =>
		Effect.gen(function* () {
			yield* open();
			port.script = ['ignore'];
			const sentBefore = t.fakes.links.sent.length;
			yield* say(DM, '@bot the Bismis job needs a contractor', {
				...group(2),
				invocation: 'mention'
			});
			yield* t.settled();
			const question = 'Want me to assign a contractor to them?';
			expect(t.fakes.links.sent.slice(sentBefore)).toContainEqual(expect.objectContaining({
				instance: 'field_wa', message: expect.objectContaining({ text: question })
			}));
			expect(yield* q(
				`SELECT status, sent_at IS NOT NULL AS accepted FROM sys_message
				WHERE integration = 'field_wa' AND direction = 'outbound' AND text = $1 ORDER BY seq DESC LIMIT 1`,
				question
			)).toEqual([{ status: 'sent', accepted: true }]);
			t.clock.advance('1min');
			yield* say(DM, 'Ya put bob under them', group(2));
			yield* t.settled();
			expect(port.inputs).toHaveLength(0);
			expect((yield* row('Ya put bob under them'))['delivered_turn']).not.toBeNull();
		})
	);
});

describe('never wedged', () => {
	it.live('a failed sys_1 answers a DM, keeps a group quiet and is recorded', () =>
		Effect.gen(function* () {
			yield* open();
			port.mode = 'throws';
			yield* say(DM, 'failing hello');
			yield* say(CAL_WA, 'failing chatter', group(4));
			yield* t.settled();
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
		})
	);
	it.live('a decider that never answers is a failed decision', () =>
		Effect.gen(function* () {
			yield* open();
			port.mode = 'hangs';
			const said = yield* Effect.forkChild(say(DM, 'hung hello'));
			while (port.inputs.length === 0) yield* Effect.sleep('5 millis');
			yield* covered();
			expect(yield* row('hung hello')).toMatchObject({ state: 'pending' });
			t.clock.advance('6s');
			yield* Fiber.join(said);
			yield* t.settled();
			expect((yield* row('hung hello'))['delivered_turn']).not.toBeNull();
			expect(yield* queued()).toEqual([]);
		})
	);
	/** What a process leaves behind when it dies mid-decision: the row and its run, and nobody deciding. */
	const orphan = (body: string) =>
		Effect.gen(function* () {
			yield* say(DM, `before ${body}`);
			yield* t.settled();
			const [conv] = yield* q(`SELECT id FROM sys_conversation WHERE thread = $1`, DM);
			const conversation = String(conv?.['id']);
			const id = globalThis.crypto.randomUUID();
			yield* t.db.write({
				text: `INSERT INTO sys_message (id, conversation, role, content, text, state, mode, "as")
				SELECT $1, $2, 'user', jsonb_build_object('text', $3::text), $3, 'pending', 'agent', "as" FROM sys_message
				WHERE conversation = $2 AND "as" IS NOT NULL ORDER BY seq LIMIT 1 RETURNING id`,
				params: [id, conversation, body]
			});
			yield* t.db.write({
				text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth, state, attempts)
				VALUES (gen_random_uuid()::text, 'agent.triage', jsonb_build_object('conversation', $1::text), $2::timestamptz, 'schedule', 0, 'queued', 0) RETURNING id`,
				params: [conversation, until(TAKEOVER_MS / 1000)]
			});
			yield* covered();
			return { id, conversation };
		});
	it.live('a decision lost with its process is taken over by the queue', () =>
		Effect.gen(function* () {
			yield* open();
			yield* orphan('lost hello');
			t.clock.advance(`${TAKEOVER_MS / 1000}s`);
			yield* t.run_due();
			yield* t.settled();
			expect((yield* row('lost hello'))['delivered_turn']).not.toBeNull();
			expect(yield* queued()).toEqual([]);
		})
	);
	it.live('a takeover that fails answers: the run never leaves a message pending', () =>
		Effect.gen(function* () {
			yield* open();
			const { id, conversation } = yield* orphan('lost twice');
			// the pending row no longer decodes, so the decision itself fails
			yield* t.db.write({
				text: `UPDATE sys_conversation SET inputs = jsonb_build_array(jsonb_build_object('message', $1::text, 'id', 7)) WHERE id = $2 RETURNING id`,
				params: [id, conversation]
			});
			t.clock.advance(`${TAKEOVER_MS / 1000}s`);
			yield* t.run_due();
			yield* t.db.write({
				text: `UPDATE sys_conversation SET inputs = '[]'::jsonb WHERE id = $1 RETURNING id`,
				params: [conversation]
			});
			yield* t.settled();
			yield* covered();
			expect(yield* row('lost twice')).toMatchObject({ state: 'queued' });
			yield* inWorkspace(agents.drain(conversation));
			expect((yield* row('lost twice'))['delivered_turn']).not.toBeNull();
		})
	);
	it.live('a turn it admitted holds nothing: the next message of that chat is still decided', () =>
		Effect.gen(function* () {
			yield* open();
			const gate = yield* Deferred.make<void>();
			ai.gate = gate;
			port.script = ['ignore'];
			yield* say(DM, '@bot long job', { ...group(5), invocation: 'mention' });
			while (ai.requests.length === 0) yield* Effect.sleep('5 millis');
			yield* say(CAL_WA, 'chatter during the turn', group(5));
			// answered while the turn runs, not after it: this is what used to wedge
			expect(yield* row('chatter during the turn')).toMatchObject({ addressed: false });
			yield* say(DM, 'a direct word meanwhile');
			yield* Deferred.succeed(gate, undefined);
			ai.gate = null;
			yield* t.settled();
			expect((yield* row('a direct word meanwhile'))['delivered_turn']).not.toBeNull();
		})
	);
	it.live('a run due after its burst left finds nothing and goes', () =>
		Effect.gen(function* () {
			yield* open();
			port.script = [{ action: 'wait', hold: 1 }];
			yield* say(DM, 'held then flushed');
			yield* inWorkspace(
				q(`SELECT id FROM sys_conversation WHERE thread = $1`, DM).pipe(
					Effect.flatMap(([c]) => throttle.release(String(c?.['id'])))
				)
			);
			t.clock.advance('1s');
			yield* t.run_due();
			yield* t.settled();
			expect(yield* queued()).toEqual([]);
			expect(port.inputs).toHaveLength(1);
		})
	);
});
