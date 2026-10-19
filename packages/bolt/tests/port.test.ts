// `Port` (L-BOLT-288, 289): a port call is bounded by its wall, and a missing port, a throw, a rejection or a bad answer
// is a typed failure — never a throw.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { FacilityFailure, Unavailable } from '../src/decl/errors.ts';
import { Port } from '../src/engine/port.ts';

describe('Port', () => {
	it.effect('unavailable: the host provides no such port', () =>
		Effect.gen(function* () {
			const e = yield* Effect.flip(Port.unavailable('geo'));
			expect(e).toBeInstanceOf(Unavailable);
			expect(e).toMatchObject({ facility: 'geo', reason: 'the host provides no geo' });
		})
	);

	it.live(
		'call: past its wall the call is interrupted, its signal aborted, and it fails timeout',
		() =>
			Effect.gen(function* () {
				let aborted = false;
				const never = Port.attempt(
					'geo',
					(signal) =>
						new Promise<number>(() => {
							signal.addEventListener('abort', () => {
								aborted = true;
							});
						})
				);
				const e = yield* Effect.flip(never.pipe(Port.call('geo', 20)));
				expect(e).toBeInstanceOf(FacilityFailure);
				expect(e).toMatchObject({ kind: 'timeout', message: 'geo did not answer within 20 ms' });
				expect(aborted).toBe(true);
				expect(yield* Port.attempt('geo', async () => 7).pipe(Port.call('geo', 1_000))).toBe(7);
			})
	);

	it.effect(
		'fromPromise: a throw or rejection is upstream, a bad answer is upstream, a good one decodes',
		() =>
			Effect.gen(function* () {
				expect(
					yield* Effect.flip(
						Port.fromPromise(
							() => {
								throw new Error('sync');
							},
							Schema.Number,
							'geo'
						)
					)
				).toMatchObject({ kind: 'upstream', message: 'sync' });
				expect(
					yield* Effect.flip(
						Port.fromPromise(() => Promise.reject(new Error('')), Schema.Number, 'geo')
					)
				).toMatchObject({ kind: 'upstream', message: 'geo failed' });
				expect(
					yield* Effect.flip(Port.fromPromise(async () => 'x', Schema.Number, 'geo'))
				).toMatchObject({
					kind: 'upstream',
					message: 'geo answered something that is not its result'
				});
				expect(yield* Port.fromPromise(async () => 7, Schema.Number, 'geo')).toBe(7);
			})
	);

	it.effect(
		'a thrown FacilityError keeps its kind; a thrown unavailable value is Unavailable',
		() =>
			Effect.gen(function* () {
				const limited = yield* Effect.flip(
					Port.attempt('speech', () =>
						Promise.reject({ kind: 'rateLimited', message: 'slow down', status: 429 })
					)
				);
				expect(limited).toBeInstanceOf(FacilityFailure);
				expect(limited).toMatchObject({ kind: 'rateLimited', message: 'slow down', status: 429 });
				const absent = yield* Effect.flip(
					Port.attempt('speech', () =>
						Promise.reject({ kind: 'unavailable', facility: 'ai.speak', reason: 'no voice' })
					)
				);
				expect(absent).toBeInstanceOf(Unavailable);
				expect(absent).toMatchObject({ facility: 'ai.speak', reason: 'no voice' });
				expect(
					yield* Effect.flip(Port.attempt('speech', () => Promise.reject('just a string')))
				).toMatchObject({ kind: 'upstream', message: 'speech failed' });
			})
	);
});
