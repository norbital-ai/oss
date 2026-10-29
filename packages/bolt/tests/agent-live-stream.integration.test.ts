// A reply streams into one `streaming` row, rewritten with the text so far at most every STREAM_FLUSH_MS while the model is
// still writing; the final write lands on that same row. A stop mid-reply keeps the partial text, finished as `cut`.
import { describe, expect, layer } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Result, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { Agents } from '../src/engine/services.ts';
import { Ai, type AiEvent } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { STREAM_FLUSH_MS } from '../src/engine/agent/index.ts';
import type { MessageRow } from '../src/engine/agent/schema.ts';
import { respondSystem1, TestWorkspace } from '../../bolt-cli/src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
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
const usage = { input: 1, output: 1 };

/** The model of the running test: emits its first delta, signals `emitted`, then waits on `gate`. */
const script = {
	emitted: Deferred.makeUnsafe<void>(),
	gate: Deferred.makeUnsafe<void>(),
	rest: [] as AiEvent[]
};
const ports = Layer.succeed(Ai, {
	ask: respondSystem1,
	maxChoices: undefined,
	models: ['default'],
	catalog: Port.unavailable('ai.catalog'),
	embed: () => Port.unavailable('ai.embed'),
	infer: () =>
		Stream.concat(
			Stream.fromIterable<AiEvent>([{ _tag: 'Delta', text: 'Half ' }]),
			Stream.unwrap(
				Effect.gen(function* () {
					yield* Deferred.succeed(script.emitted, undefined);
					yield* Deferred.await(script.gate);
					return Stream.fromIterable(script.rest);
				})
			)
		)
});
const arm = (rest: AiEvent[]) =>
	Effect.sync(() => {
		script.emitted = Deferred.makeUnsafe<void>();
		script.gate = Deferred.makeUnsafe<void>();
		script.rest = rest;
	});

const start = Effect.gen(function* () {
	const t = yield* TestWorkspace,
		agent = yield* Agents;
	yield* t.db.write({
		text: `INSERT INTO sys_user (id, email, name) VALUES ('ann', 'ann@x.test', 'Ann') ON CONFLICT DO NOTHING`,
		params: []
	});
	const c = yield* agent.start({ owner: 'ann' });
	yield* agent.post({ conversation: c, as: { member: 'ann' }, text: 'go' });
	// a post only queues the input; the host drives the turn
	const turn = yield* Effect.forkChild(agent.drain(c));
	yield* Deferred.await(script.emitted);
	const replies = agent
		.transcript(c)
		.pipe(Effect.map((rows) => rows.filter((r) => r.role === 'assistant')));
	// the flush is a clock window: advance it until the partial reply is written
	let streamed: MessageRow | undefined;
	for (let i = 0; i < 100 && streamed === undefined; i++) {
		yield* TestClock.adjust(STREAM_FLUSH_MS);
		streamed = (yield* replies).find((r) => r.state === 'streaming');
	}
	expect(streamed?.text).toBe('Half ');
	return { agent, c, replies, streamed, turn };
});

// the kit's Clock sleeps in real time; the stream window runs on a TestClock set to the kit's instant
const virtual = <A, E, R>(body: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const t = yield* TestWorkspace;
		return yield* Effect.andThen(TestClock.setTime(Date.parse(t.clock.now())), body).pipe(
			Effect.provide(TestClock.layer())
		);
	});

layer(TestWorkspace.layer({ manifest, ports }))('agent streaming', (it) => {
	describe('a streamed reply', () => {
		it.effect('flushes while the model writes; the final write is the same row', () =>
			virtual(
				Effect.gen(function* () {
					yield* arm([
						{ _tag: 'Delta', text: 'done.' },
						{
							_tag: 'Response',
							response: { content: 'Half done.', toolCalls: [], finish: 'stop', usage }
						}
					]);
					const { replies, streamed, turn } = yield* start;
					yield* Deferred.succeed(script.gate, undefined);
					yield* Fiber.join(turn);
					expect(yield* replies).toEqual([
						expect.objectContaining({ id: streamed?.id, state: null, text: 'Half done.' })
					]);
				})
			)
		);

		it.effect('a stop mid-reply keeps what was written, finished as cut', () =>
			virtual(
				Effect.gen(function* () {
					yield* arm([]);
					const { agent, c, replies, turn } = yield* start;
					yield* agent.stop(c);
					yield* Fiber.await(turn);
					expect((yield* replies).at(-1)).toMatchObject({
						state: null,
						text: 'Half ',
						meta: { tag: 'cut' }
					});
				})
			)
		);
	});
});
