// The model idle wall preserves partial text and identifies a cut tool call separately from no output.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Result, Stream } from 'effect';
import { Unavailable } from '../src/decl/errors.ts';
import { modelCall } from '../src/engine/agent/ai.ts';
import type { Ai, AiEvent } from '../src/engine/ports.ts';
import { clockProbe } from './support/clock-probe.ts';

const request = { model: 'default', system: '', messages: [] };
const atWall = (events: readonly AiEvent[]) =>
	Effect.gen(function* () {
		const unused = () => Effect.fail(new Unavailable({ facility: 'ai', reason: 'unused' }));
		const ai: Ai['Service'] = {
			ask: unused,
			embed: unused,
			models: ['default'],
			maxChoices: undefined,
			catalog: Effect.succeed({ models: [], default: 'default' }),
			infer: () => Stream.concat(Stream.fromIterable(events), Stream.fromEffect(Effect.never))
		};
		return yield* clockProbe(modelCall(ai, request, { wallMs: 20 }).pipe(Effect.result), 21);
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
