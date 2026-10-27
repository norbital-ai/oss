// The test kit's provider cassette (L-BOLT-1015): `TestWorkspace.layer({ fakes: { ai: { cassette } } })` replays recorded
// responses per model class through the real agent loop; an unmapped class is Unavailable, a malformed recording fails
// the kit, a class played past its end throws. And the cassette latency budget (L-BOLT-434): with an instant provider
// the send reaches the provider, and the first part streams, within 100 ms at p95 over ten turns.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { describe, expect, it } from '@effect/vitest';
import { Context, Deferred, Effect, Fiber, Layer, Option, Result, Schema, Stream } from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { Agents, Live } from '../src/engine/services.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import type { AiResponse } from '../src/engine/contracts.ts';
import { TestWorkspace, type TestOptions } from '../src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: {
			tz: 'UTC',
			locale: 'en',
			agent: { triage: false },
			ai: { models: ['default', 'fast'], default: 'default' }
		},
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
const reply = (content: string): AiResponse => ({
	content,
	toolCalls: [],
	finish: 'stop',
	usage: { input: 10, output: 5 }
});
const scratch = join(tmpdir(), 'norbital-scratch', `cassette-${randomUUID()}`);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const member = (id: string) => ({
	text: `INSERT INTO sys_user (id, email, name, admin) VALUES ($1, $2, $1, true)`,
	params: [id, `${id}@x.test`]
});

const setup = (
	options: Omit<Extract<TestOptions, { artifact?: never }>, 'root' | 'manifest'> = {}
) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(TestWorkspace.layer({ manifest, ...options }));
		return {
			t: Context.get(context, TestWorkspace),
			agent: Context.get(context, Agents),
			live: Context.get(context, Live)
		};
	});

describe('Fakes.ai.cassette', () => {
	it.live('replays a recorded file through the loop, in order, and reports what it played', () =>
		Effect.scoped(
			Effect.gen(function* () {
				mkdirSync(scratch, { recursive: true });
				const file = join(scratch, 'two.json');
				writeFileSync(
					file,
					JSON.stringify({
						meta: { recordedAt: '2026-09-26' },
						turns: [reply('First.'), reply('Second.')]
					})
				);
				const { t, agent } = yield* setup({ fakes: { ai: { cassette: { default: file } } } });
				yield* t.db.write(member('ann'));
				const c = yield* agent.start({ owner: 'ann' });
				yield* agent.post({ conversation: c, as: { member: 'ann' }, text: 'one' });
				expect((yield* agent.drain(c)).reply?.text).toBe('First.');
				yield* agent.post({ conversation: c, as: { member: 'ann' }, text: 'two' });
				expect((yield* agent.drain(c)).reply?.text).toBe('Second.');
				expect(t.fakes.ai?.requests.map((r) => r.model)).toEqual(['default', 'default']);
				expect(t.fakes.ai?.remaining()).toEqual({ default: 0 });
			})
		)
	);

	it.live(
		'a class the cassette does not name is Unavailable at call time, not an activation failure',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, agent } = yield* setup({
						fakes: { ai: { cassette: { default: [reply('never')] } } }
					});
					yield* t.db.write(member('ann'));
					const c = yield* agent.start({ owner: 'ann', model: 'fast' });
					yield* agent.post({ conversation: c, as: { member: 'ann' }, text: 'hi' });
					yield* agent.drain(c);
					const row = t.fakes.logs.find((r) => r.event === 'agent.failed' && r.conversation === c);
					expect(row?.attributes).toMatchObject({
						code: 'unavailable',
						message: "no model is mapped to the class 'fast'"
					});
					expect(t.fakes.ai?.requests).toEqual([]);
				})
			)
	);

	it.live('a malformed recording fails the kit; `ai` and `fakes.ai` together are refused', () =>
		Effect.scoped(
			Effect.gen(function* () {
				mkdirSync(scratch, { recursive: true });
				const file = join(scratch, 'malformed.json');
				writeFileSync(file, JSON.stringify({ turns: [{ content: 'x', finish: 'done' }] }));
				const malformed = yield* Effect.flip(
					Layer.build(
						TestWorkspace.layer({ manifest, fakes: { ai: { cassette: { default: file } } } })
					)
				);
				expect(malformed.message).toMatch(/'default' turn 0 is not an AiResponse/);
				const ambiguous = yield* Effect.flip(
					Layer.build(
						TestWorkspace.layer({
							manifest,
							ports: Ai.unavailable,
							fakes: { ai: { cassette: {} } }
						})
					)
				);
				expect(ambiguous.message).toMatch(/not both/);
			})
		)
	);
});

describe('cassette latency (L-BOLT-434)', () => {
	const percentile = (xs: readonly number[], q: number) =>
		xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)]!;
	it.live(
		'send → provider and send → first streamed part stay under 100 ms at p95 over ten turns',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const TURNS = 10;
					let firstPart = 0;
					let part = yield* Deferred.make<void>();
					const { t, agent, live } = yield* setup({
						fakes: {
							ai: {
								cassette: { default: Array.from({ length: TURNS }, (_, i) => reply(`Reply ${i}.`)) }
							}
						}
					});
					yield* t.db.write(member('ann'));
					const c = yield* agent.start({ owner: 'ann' });
					const connected = yield* Deferred.make<string>();
					yield* Effect.forkScoped(
						live.connect(yield* t.signIn('ann@x.test')).pipe(
							Stream.runForEach((frame) =>
								Effect.gen(function* () {
									if (frame.t === 'hello') yield* Deferred.succeed(connected, frame.conn);
									if (
										firstPart === 0 &&
										frame.t === 'patch' &&
										frame.ops.some(
											(op) =>
												op.op === 'upsert' &&
												Option.isSome(
													Schema.decodeUnknownOption(
														Schema.Struct({ role: Schema.Literal('assistant') })
													)(op.row)
												)
										)
									) {
										firstPart = performance.now();
										yield* Deferred.succeed(part, undefined);
									}
								})
							)
						)
					);
					yield* live.register(yield* Deferred.await(connected), 'transcript', {
						read: { kind: 'transcript', model: 'sys_message', conversation: c, thread: false }
					});
					yield* live.settled;
					const toProvider: number[] = [],
						toFirstPart: number[] = [];
					const ai = t.fakes.ai;
					if (ai === undefined) throw new Error('missing cassette');
					for (let i = 0; i < TURNS; i++) {
						firstPart = 0;
						part = yield* Deferred.make<void>();
						const before = ai.requests.length;
						const sent = performance.now();
						let settled = false;
						const turn = yield* Effect.forkChild(
							agent.post({ conversation: c, as: { member: 'ann' }, text: `turn ${i}` }).pipe(
								Effect.andThen(agent.drain(c)),
								Effect.ensuring(
									Effect.sync(() => {
										settled = true;
									})
								)
							)
						);
						while (ai.requests.length === before && !settled) yield* Effect.yieldNow;
						const asked = performance.now();
						yield* Fiber.join(turn);
						yield* live.settled;
						yield* Deferred.await(part);
						toProvider.push(asked - sent);
						toFirstPart.push(firstPart - sent);
					}
					expect(ai.remaining()).toEqual({ default: 0 });
					expect(percentile(toProvider, 0.95)).toBeLessThan(100);
					expect(percentile(toFirstPart, 0.95)).toBeLessThan(100);
				})
			)
	);
});
