// In-app triage (rule 60a): parts posted without `now` wait for more; respond-now and a `now` post start the turn at
// once with every pending part, and never ask the decider.
import { describe, expect, it } from '@effect/vitest';
import { Clock, Context, Effect, Layer, Predicate, Result, Schema, Stream } from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import type { System1Request } from '../src/engine/decisions/index.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { TestWorkspace } from '../src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {},
		relationships: {},
		exposures: {},
		policies: {},
		agent: { internal: 'Staff brief.', skills: {} },
		integrations: {},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {}
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
		const ask: Ai['Service']['ask'] = (r) =>
			Effect.sync(() => {
				inputs.push(r);
				return {
					answers: {
						action: { type: 'choice', choice: 'wait', confidence: 1, probabilities: { wait: 1 } },
						wait: {
							type: 'score',
							score: 10,
							level: 10,
							confidence: 1,
							probabilities: {},
							legend: {}
						}
					},
					costUsd: 0,
					provider: 'scripted'
				};
			});
		const infer: Ai['Service']['infer'] = (r) =>
			Stream.suspend(() => {
				turns.push(
					r.messages
						.filter((m) => m.role === 'user' && !text(m.content).startsWith('Now: '))
						.map((m) => text(m.content))
				);
				return Stream.succeed({
					_tag: 'Response',
					response: {
						content: 'On it.',
						toolCalls: [],
						finish: 'stop',
						usage: { input: 1, output: 1 }
					}
				});
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
			route = yield* routeFixture(context);
		yield* t.db.write({
			text: `INSERT INTO sys_user (id, email, name) VALUES ('ann', 'ann@x.test', 'Ann')`,
			params: []
		});
		const ann = yield* new Authorities(manifest, 'test').member(t.db, 'ann');
		if (ann === null) throw new Error('Ann has no authority');
		const act = (callable: string, input: Json) =>
			actReply(route, ann, { callable, input, issuedAt: t.clock.now() }).pipe(
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
				Effect.andThen(route.settled)
			);
		return {
			t,
			inputs,
			turns,
			post,
			respondNow: act('sys_conversation.respondNow', { conversation: id }).pipe(
				Effect.andThen(route.settled)
			)
		};
	});

describe('in-app triage (G5, rule 60a)', () => {
	it.live('plain parts wait; respond-now and a `now` post answer every pending part as one turn, never asking the decider', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const p = yield* panel();
				yield* p.post('draft a note');
				yield* p.post('for the Kismis job');
				expect(p.turns).toHaveLength(0);
				yield* p.respondNow;
				expect(p.turns).toEqual([['draft a note', 'for the Kismis job']]);
				yield* p.post('first part');
				yield* p.post('second part', true);
				expect(p.turns).toHaveLength(2);
				expect(p.turns[1]?.slice(-2)).toEqual(['first part', 'second part']);
				yield* p.t.runDue(); // the decisions the plain parts queued find nothing pending
				expect(p.inputs).toHaveLength(0);
			})
		)
	);
});
