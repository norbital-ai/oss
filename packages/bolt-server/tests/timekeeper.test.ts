import { Effect } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { makeTimekeeper } from '../src/timekeeper.js';

afterEach(() => vi.useRealTimers());

it('owns runtime rejection when a running tick is interrupted during shutdown', async () => {
	vi.useFakeTimers();
	let rejectTick: (error: Error) => void = () => {
		throw new Error('tick not started');
	};
	const gate = new Promise<void>((_resolve, reject) => {
		rejectTick = reject;
	});
	const failures: unknown[] = [];
	const keeper = makeTimekeeper({
		tick: () => Effect.succeed(null),
		run: <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
			gate.then(() => Effect.runPromise(effect)),
		onFailure: (cause) => failures.push(cause)
	});
	keeper.announce(Date.now());
	await vi.advanceTimersByTimeAsync(1);
	keeper.stop();
	rejectTick(new Error('managed runtime disposed'));
	await vi.advanceTimersByTimeAsync(1);
	expect(failures).toEqual([]);
	expect(keeper.armedFor()).toBeUndefined();
});

it('reports runner failure and backs off while the host remains active', async () => {
	vi.useFakeTimers();
	const failures: unknown[] = [];
	const cause = new Error('runtime could not start tick');
	const keeper = makeTimekeeper({
		tick: () => Effect.succeed(null),
		run: <A, E>(_effect: Effect.Effect<A, E>): Promise<A> => Promise.reject(cause),
		onFailure: (error) => failures.push(error),
		retryAfterMillis: 60_000
	});
	keeper.announce(Date.now());
	await vi.advanceTimersByTimeAsync(1);
	expect(failures).toEqual([cause]);
	expect(keeper.armedFor()).toBeGreaterThan(Date.now() + 59_000);
	keeper.stop();
});
