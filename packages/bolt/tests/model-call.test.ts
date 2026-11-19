// The model idle wall preserves partial text and identifies a cut tool call separately from no output; the
// administrator's System 1 and System 2 picks reach every decision and model class.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Result, Stream } from 'effect';
import { type AiRequest, type DecisionRequest, Unavailable } from '@norbital-ai/host-api';
import { modelCall } from '../src/engine/agent/ai.ts';
import { AdminAi } from '../src/engine/agent/settings.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Ai } from '../src/engine/ports.ts';
import type { AiEvent } from '@norbital-ai/host-api';
import { clock_probe } from './support/clock-probe.ts';

const request = { model: 'default', system: '', messages: [] };
const atWall = (events: readonly AiEvent[]) =>
	Effect.gen(function* () {
		const unused = () => Effect.fail(new Unavailable({ facility: 'ai', reason: 'unused' }));
		const ai: Ai['Service'] = {
			ask: unused,
			embed: unused,
			models: ['default'],
			maxChoices: undefined,
			deciders: Effect.succeed({ models: [], default: '' }),
			catalog: Effect.succeed({ models: [], default: 'default' }),
			infer: () => Stream.concat(Stream.fromIterable(events), Stream.fromEffect(Effect.never))
		};
		return yield* clock_probe(modelCall(ai, request, { wallMs: 20 }).pipe(Effect.result), 21);
	});

describe('modelCall at its wall', () => {
	it.effect('text so far: a cut step', () =>
		Effect.gen(function* () {
			const result = yield* atWall([{ _tag: 'Delta', text: 'partial' }]);
			expect(Result.getOrThrow(result)).toMatchObject({ finish: 'cut', content: 'partial' });
		})
	);
	it.effect('only a tool call in progress: cutTool', () =>
		Effect.gen(function* () {
			const result = yield* atWall([{ _tag: 'Progress', reasoning: undefined }]);
			expect(Result.isFailure(result)).toBe(true);
			if (Result.isFailure(result))
				expect(result.failure).toMatchObject({ kind: 'timeout', cutTool: true });
		})
	);
	it.effect('nothing at all: yielded nothing', () =>
		Effect.gen(function* () {
			const result = yield* atWall([]);
			expect(Result.isFailure(result)).toBe(true);
			if (Result.isFailure(result)) {
				expect(result.failure).toMatchObject({ kind: 'timeout' });
				expect('cutTool' in result.failure).toBe(false);
			}
		})
	);
});

describe("the administrator's System 1 and System 2", () => {
	const listing = (...ids: string[]) =>
		Effect.succeed({ models: ids.map((id) => ({ id, label: id })), default: ids[0] ?? '' });
	/** The host's AI under `settings`, recording the model each decision and inference was asked with. */
	const under = (settings: { system1: string | null; system2: string | null }) => {
		const asked: (string | undefined)[] = [],
			inferred: string[] = [];
		const host = Layer.succeed(Ai, {
			ask: (_request, model) =>
				Effect.sync(() => {
					asked.push(model);
					return { answers: {}, cost_usd: 0, provider: 'p' };
				}),
			maxChoices: undefined,
			deciders: listing('jev', 'fast-1'),
			models: ['default', 'strong'],
			catalog: listing('big-1', 'big-2'),
			embed: () => Effect.fail(new Unavailable({ facility: 'ai', reason: 'unused' })),
			infer: (request) => {
				inferred.push(request.model);
				return Stream.empty;
			}
		});
		const db = Layer.succeed(
			TenantDb,
			TenantDb.typed({
				read: (statements) =>
					Effect.succeed(
						statements.map(() => ({
							rows: [{ value: JSON.stringify({ monthly: null, member: null, models: [], ...settings }) }],
							affected: 1
						}))
					),
				write: () => Effect.succeed({ rows: [], affected: 0 }),
				transaction: () => Effect.succeed([])
			})
		);
		const decision: DecisionRequest = { state: 's', questions: { q: { type: 'noul' } } };
		const run = (request: AiRequest) =>
			Effect.gen(function* () {
				const ai = yield* Ai;
				yield* ai.ask(decision);
				yield* ai.ask(decision, 'named');
				yield* Stream.runDrain(ai.infer(request));
				return { asked, inferred };
			}).pipe(Effect.provide(AdminAi.pipe(Layer.provide(Layer.merge(host, db)))));
		return run;
	};
	it.effect('decisions run on System 1, every model class on System 2; a named model goes as is', () =>
		Effect.gen(function* () {
			const run = under({ system1: 'fast-1', system2: 'big-2' });
			expect(yield* run({ model: 'strong', messages: [] })).toEqual({
				asked: ['fast-1', 'named'],
				inferred: ['big-2']
			});
			expect((yield* run({ model: 'big-1', messages: [] })).inferred).toEqual(['big-2', 'big-1']);
		})
	);
	it.effect("a pick the provider no longer lists, or none, leaves the host's own", () =>
		Effect.gen(function* () {
			expect(yield* under({ system1: 'gone', system2: 'gone' })({ model: 'default', messages: [] })).toEqual({
				asked: [undefined, 'named'],
				inferred: ['default']
			});
			expect(yield* under({ system1: null, system2: null })({ model: 'default', messages: [] })).toEqual({
				asked: [undefined, 'named'],
				inferred: ['default']
			});
		})
	);
});
