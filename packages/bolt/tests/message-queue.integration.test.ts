// The message queue through its callables: a message goes at once, a running turn takes it at its next step, and only the
// sender holds one back, for a time or for the work to finish (the verifier and sub-agents included).
import { describe, expect, it } from '@effect/vitest';
import {
	Clock,
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Predicate,
	Result,
	Schema,
	Stream
} from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { MessageQueue } from '../src/engine/agent/queue.ts';
import { Port } from '../src/engine/port.ts';
import { decode_projected_manifest } from '../src/engine/manifest.ts';
import { act_reply, route_fixture } from './support/route-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import type { System1Request } from '../src/engine/decision.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';

const manifest = Result.getOrThrow(
	decode_projected_manifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {},
		relationships: {},
		exposures: {},
		policies: {},
		agent: { internal: 'Staff brief.', skills: {} },
		integrations: {},
		teams: {},
		automations: {},

		mcp: {},
		apps: {},
		custom_fields: {}
	})
);

/** A user message's text without its envelope's sender header (`[who] `). */
const text = (c: Json) =>
	(typeof c === 'string' ? c : Predicate.isObject(c) ? String(c['text'] ?? '') : '').replace(
		/^\[[^\]]*\]\s*/,
		''
	);

const panel = () =>
	Effect.gen(function* () {
		const inputs: System1Request[] = [],
			turns: string[][] = [];
		/** While set, the model's answer waits here: the turn stays running. */
		const hold: { gate: Deferred.Deferred<void> | null } = { gate: null };
		/** What the model did, in order, and the verifier's answers and the tool calls it is scripted to make. */
		const events: string[] = [],
			verdicts: boolean[] = [];
		const decider = { partial: false };
		const ask: Ai['Service']['ask'] = (r) =>
			Effect.sync(() => {
				inputs.push(r);
				return {
					answers: {
						text: {
							type: 'choice',
							choice: decider.partial ? 'partial' : 'complete',
							confidence: 1,
							probabilities: decider.partial ? { partial: 1 } : { complete: 1 }
						},
						hold: {
							type: 'score',
							score: 3,
							level: 3,
							confidence: 1,
							probabilities: {},
							legend: {}
						}
					},
					cost_usd: 0,
					provider: 'scripted'
				};
			});
		const infer: Ai['Service']['infer'] = (r) =>
			Stream.suspend(() => {
				if (r.messages.at(-1)?.content !== 'Give your verdict.')
					turns.push(
						r.messages
							.filter((m) => m.role === 'user' && !text(m.content).startsWith('Now: ')
								// the step's action catalogue note, not a posted part
								&& !text(m.content).startsWith('[Available actions for this step]'))
							.map((m) => text(m.content))
					);
				const gate = hold.gate;
				const verifying = r.messages.at(-1)?.content === 'Give your verdict.';
				const complete = verifying ? (verdicts.shift() ?? true) : true;
				if (verifying) events.push(`verdict: ${complete}`);
				else events.push(turns.at(-1)?.at(-1) ?? '');
				return Stream.fromEffect(gate === null ? Effect.void : Deferred.await(gate)).pipe(
					Stream.map(() => ({
						_tag: 'Response' as const,
						response: {
							content: verifying
								? JSON.stringify({ complete, gaps: complete ? [] : ['not done'] })
								: 'On it.',
							tool_calls: [],
							finish: 'stop' as const,
							usage: { input: 1, output: 1 }
						}
					}))
				);
			});
		const ports = Layer.succeed(Ai, {
			ask,
			infer,
			models: ['default'],
			maxChoices: undefined,
			catalog: Port.unavailable('ai.catalog'),
			embed: () => Port.unavailable('ai.embed')
		});
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				ports,
				now: new Date(yield* Clock.currentTimeMillis).toISOString()
			})
		);
		const t = Context.get(context, TestWorkspace),
			route = yield* route_fixture(context);
		yield* t.db.write({
			text: `INSERT INTO sys_user (id, email, name) VALUES ('ann', 'ann@x.test', 'Ann')`,
			params: []
		});
		const ann = yield* new Authorities(manifest, 'test').member(t.db, 'bootstrap', 'ann');
		if (ann === null) throw new Error('Ann has no authority');
		const act = (callable: string, input: Json) =>
			act_reply(route, ann, { callable, input, issued_at: t.clock.now() }).pipe(
				Effect.map((reply) => reply.outcome)
			);
		const started = yield* act('sys_conversation.start', {});
		if (started.kind !== 'committed') throw new Error('conversation not started');
		const { id } = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
			started.output
		);
		const post = (text: string, now?: boolean) =>
			act('sys_message.post', { conversation: id, text, ...(now === true ? { now } : {}) }).pipe(
				Effect.tap((outcome) => Effect.sync(() => expect(outcome.kind).toBe('committed'))),
				Effect.andThen(route.settled),
				Effect.andThen(t.settled())
			);
		/** The message's stored row. */
		const row = (body: string) =>
			t.db
				.read([
					{
						text: `SELECT state, seq::int AS seq, meta FROM sys_message WHERE conversation = $1 AND text = $2`,
						params: [id, body]
					}
				])
				.pipe(Effect.map(([r]) => r?.rows[0]));
		const lastReply = t.db
			.read([
				{
					text: `SELECT max(seq)::int AS seq FROM sys_message WHERE conversation = $1 AND role = 'assistant'`,
					params: [id]
				}
			])
			.pipe(Effect.map(([r]) => Number(r?.rows[0]?.['seq'])));
		const runs = (automation: string) =>
			t.db
				.read([
					{
						text: `SELECT id FROM sys_run WHERE automation = $1 AND state = 'queued'`,
						params: [automation]
					}
				])
				.pipe(Effect.map(([r]) => r?.rows.length ?? 0));
		/** Starts a turn and leaves it running on the model's answer; `finish` lets it answer. */
		const running = Effect.gen(function* () {
			const gate = yield* Deferred.make<void>();
			hold.gate = gate;
			const before = turns.length;
			yield* act('sys_message.post', { conversation: id, text: 'start', now: true });
			while (turns.length === before) yield* Effect.sleep('5 millis');
			return Deferred.succeed(gate, undefined).pipe(
				Effect.andThen(
					Effect.sync(() => {
						hold.gate = null;
					})
				),
				Effect.andThen(route.settled)
			);
		});
		return {
			t,
			inputs,
			turns,
			events,
			verdicts,
			queue: Context.get(context, MessageQueue),
			post,
			/** The decider reads every message as partial from here on. */
			holds: () => {
				decider.partial = true;
			},
			act,
			id,
			row,
			lastReply,
			runs,
			running,
			settled: route.settled,
			stop: act('sys_conversation.stop', { conversation: id }).pipe(Effect.andThen(route.settled)),
			resume: act('sys_conversation.resume', { conversation: id }).pipe(
				Effect.andThen(route.settled)
			),
			respondNow: act('sys_conversation.respond_now', { conversation: id }).pipe(
				Effect.andThen(route.settled)
			)
		};
	});

describe('the message queue', () => {
	it.live('Resume admits a follow-up still held by in-app triage', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel();
				p.holds();
				yield* p.stop;
				yield* p.post('Continue with this follow-up.');
				expect(p.turns).toHaveLength(0);
				yield* p.resume;
				expect(p.turns).toHaveLength(1);
				expect(p.turns[0]).toContain('Continue with this follow-up.');
			})
		)
	);
	it.live(
		'a held part waits; respond-now and a `now` post answer every pending part as one turn',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const p = yield* panel();
					p.holds();
					yield* p.post('draft a note');
					yield* p.post('for the Bismis job');
					expect(p.turns).toHaveLength(0);
					yield* p.respondNow;
					expect(p.turns).toEqual([['draft a note', 'for the Bismis job']]);
					yield* p.post('first part');
					yield* p.post('second part', true);
					expect(p.turns).toHaveLength(2);
					expect(p.turns[1]?.slice(-2)).toEqual(['first part', 'second part']);
					yield* p.t.run_due(); // the holds the plain parts started find nothing pending
					expect(p.inputs).toHaveLength(2); // one per burst: a held burst's next part asks nothing
				})
			)
	);
	it.live('a message sent while a turn runs steers its next step and is never held', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel();
				const finish = yield* p.running;
				const sent = yield* p.act('sys_message.post', {
					conversation: p.id,
					text: 'What are you doing'
				});
				expect(sent.kind).toBe('committed');
				expect(yield* p.row('What are you doing')).toMatchObject({ state: 'queued' });
				expect(yield* p.runs('agent.triage')).toBe(0);
				yield* finish;
				expect(p.turns.at(-1)).toContain('What are you doing');
				expect(p.inputs).toHaveLength(0); // no decider: only `now` started this turn
				// heard after the reply it steered: what the model already read never moved
				const steered = yield* p.row('What are you doing');
				expect(steered).toMatchObject({ state: 'consumed' });
				expect(Number(steered?.['seq'])).toBeGreaterThan(
					yield* p.row('start').pipe(Effect.map((row) => Number(row?.['seq'])))
				);
			})
		)
	);
	it.live('a message scheduled for the finish goes when the turn would end, one at a time', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel();
				const finish = yield* p.running;
				for (const text of ['next task', 'last task'])
					yield* p.act('sys_message.post', { conversation: p.id, text, schedule: 'finish' });
				expect(yield* p.row('next task')).toMatchObject({ state: 'scheduled' });
				yield* finish;
				expect(p.turns.map((t) => t.at(-1))).toEqual(['start', 'next task', 'last task']);
				const reply = yield* p.lastReply;
				expect(Number((yield* p.row('last task'))?.['seq'])).toBeLessThan(reply);
			})
		)
	);
	it.live('after-generation waits for the verifier to clear the work', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel();
				yield* p.t.db.write({
					text: `UPDATE sys_conversation SET plan = '{"revision":1,"body":"Ship it.","status":"active","checkpoint":0,"verdicts":0}'::jsonb WHERE id = $1`,
					params: [p.id]
				});
				p.verdicts.push(false, true);
				const finish = yield* p.running;
				yield* p.act('sys_message.post', {
					conversation: p.id,
					text: 'next task',
					schedule: 'finish'
				});
				yield* finish;
				expect(p.events.filter((e) => e.startsWith('verdict') || e === 'next task')).toEqual([
					'verdict: false',
					'verdict: true',
					'next task'
				]);
			})
		)
	);
	it.live('after-generation waits for a running sub-agent', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel();
				yield* p.t.db.write({
					text: `INSERT INTO sys_conversation (id, owner, parent, status, model) VALUES ('child', 'ann', $1, 'running', 'default')`,
					params: [p.id]
				});
				const finish = yield* p.running;
				yield* p.act('sys_message.post', {
					conversation: p.id,
					text: 'next task',
					schedule: 'finish'
				});
				yield* finish;
				expect(yield* p.row('next task')).toMatchObject({ state: 'scheduled' });
				yield* p.t.db.write({
					text: `UPDATE sys_conversation SET status = 'idle' WHERE id = 'child'`,
					params: []
				});
				yield* p.post('the report came in', true);
				expect(p.events.at(-1)).toBe('next task');
			})
		)
	);
	it.live('an open wait hears a message the moment it lands, and only for its conversation', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel();
				const finish = yield* p.running;
				const heard = yield* Effect.forkChild(p.queue.heard(p.id));
				yield* p.queue.ring('another conversation');
				yield* Effect.sleep('20 millis');
				expect(heard.pollUnsafe()).toBeUndefined();
				yield* p.act('sys_message.post', { conversation: p.id, text: 'stop waiting' });
				yield* Fiber.join(heard);
				yield* finish;
				expect(p.turns.at(-1)).toContain('stop waiting');
			})
		)
	);
	it.live('a queued message cannot be lost with the process: its turn run is written with it', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel();
				const finish = yield* p.running;
				yield* p.act('sys_message.post', { conversation: p.id, text: 'kept' });
				expect(yield* p.runs('agent.turn')).toBe(1);
				yield* finish;
				expect(yield* p.runs('agent.turn')).toBe(0);
			})
		)
	);
	it.live('a stop leaves nothing pending: a held message goes with what was queued', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel();
				p.holds();
				yield* p.post('half a thought');
				expect(yield* p.row('half a thought')).toMatchObject({ state: 'pending' });
				yield* p.stop;
				expect(yield* p.row('half a thought')).toMatchObject({ state: 'cancelled' });
			})
		)
	);
	it.live('a scheduled message is edited in place', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel();
				const at = new Date(Date.parse(p.t.clock.now()) + 3_600_000).toISOString();
				const held = yield* p.act('sys_message.post', {
					conversation: p.id,
					text: 'draft',
					schedule: at
				});
				if (held.kind !== 'committed') throw new Error('not scheduled');
				const { id } = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
					held.output
				);
				yield* p.act('sys_message.revise', { message: id, text: 'final' });
				expect(yield* p.row('final')).toMatchObject({ state: 'scheduled' });
				expect(yield* p.row('draft')).toBeUndefined();
			})
		)
	);
	it.live('finish with no turn running goes now', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel();
				yield* p.act('sys_message.post', { conversation: p.id, text: 'now', schedule: 'finish' });
				yield* p.t.settled();
				yield* p.settled;
				expect(p.turns.at(-1)).toContain('now');
			})
		)
	);
	it.live('a stop cancels what waits for the finish, not what waits for a time', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel();
				const finish = yield* p.running;
				const at = new Date(Date.parse(p.t.clock.now()) + 3_600_000).toISOString();
				yield* p.act('sys_message.post', { conversation: p.id, text: 'after', schedule: 'finish' });
				yield* p.act('sys_message.post', { conversation: p.id, text: 'later', schedule: at });
				yield* p.stop;
				yield* finish;
				expect(yield* p.row('after')).toMatchObject({ state: 'cancelled' });
				expect(yield* p.row('later')).toMatchObject({ state: 'scheduled' });
			})
		)
	);
	it.live('a scheduled time sends it, reopens a stopped conversation and refuses the past', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel();
				yield* p.stop;
				const at = new Date(Date.parse(p.t.clock.now()) + 3_600_000).toISOString();
				yield* p.act('sys_message.post', { conversation: p.id, text: 'at noon', schedule: at });
				expect(yield* p.row('at noon')).toMatchObject({
					state: 'scheduled',
					meta: { tag: 'scheduled', at }
				});
				expect(p.turns).toHaveLength(0);
				p.t.clock.advance('1h');
				yield* p.t.run_due();
				yield* p.t.settled();
				yield* p.settled;
				expect(p.turns.at(-1)).toContain('at noon');
				const past = yield* p
					.act('sys_message.post', {
						conversation: p.id,
						text: 'too late',
						schedule: new Date(Date.parse(p.t.clock.now()) - 1000).toISOString()
					})
					.pipe(Effect.flip);
				expect(past.message).toBe('Pick a time in the future.');
			})
		)
	);
	it.live('removing a scheduled message takes its run with it', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel();
				const at = new Date(Date.parse(p.t.clock.now()) + 3_600_000).toISOString();
				const held = yield* p.act('sys_message.post', {
					conversation: p.id,
					text: 'never',
					schedule: at
				});
				expect(yield* p.runs('agent.scheduled')).toBe(1);
				if (held.kind !== 'committed') throw new Error('not scheduled');
				const { id } = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
					held.output
				);
				yield* p.act('sys_message.dequeue', { message: id });
				expect(yield* p.runs('agent.scheduled')).toBe(0);
				expect(yield* p.row('never')).toMatchObject({ state: 'cancelled' });
			})
		)
	);
});
