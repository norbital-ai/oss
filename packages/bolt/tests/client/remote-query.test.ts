import { describe, expect, it } from 'vitest';
import { Effect, Schema } from 'effect';
import { createRemoteQuery } from '../../src/client/remote-query.svelte.js';

/**
 * What a failing remote tells the reader.
 *
 * The query loader records the cause in the reactive `error` cell, which previously left the awaited
 * half with nothing but "the value is undefined" to say — it raised `Remote invocation completed without a
 * value`, naming neither the command nor the reason. A remote failing on
 * `operator does not exist: text = uuid` reached the screen as "could not be loaded" and the console
 * as a sentence about undefined, and the Postgres message the server had already put in the response
 * body was discarded one frame from the reader.
 */
describe('remote query failure reporting', () => {
	it('rejects with the cause the command failed on', async () => {
		const cause = new Error('PostgreSQL operation failed: operator does not exist: text = uuid');
		const query = createRemoteQuery(() => Effect.fail(cause), undefined, Schema.Json);
		await expect(Promise.resolve(query)).rejects.toThrow('operator does not exist: text = uuid');
		expect(query.error).toBe(cause);
		expect(query.current).toBeUndefined();
		expect(Reflect.has(query, 'refresh')).toBe(false);
	});

	/** A command that answers nothing at all still has to say so, rather than resolving `undefined`. */
	it('still names a command that completed without a value', async () => {
		const query = createRemoteQuery(
			() => Effect.succeed(undefined as never),
			undefined,
			Schema.Json
		);
		await expect(Promise.resolve(query)).rejects.toThrow(
			'Remote invocation completed without a value'
		);
	});

	it('keeps the last value visible and rejects an older response after a newer reload', async () => {
		let reload: (() => Effect.Effect<void, unknown>) | undefined;
		let call = 0;
		let resolveSecond: (value: string) => void = () => undefined;
		let resolveThird: (value: string) => void = () => undefined;
		const query = createRemoteQuery(
			() => {
				call += 1;
				if (call === 1) return Effect.succeed('retained');
				return Effect.promise(
					() =>
						new Promise<string>((resolve) => {
							if (call === 2) resolveSecond = resolve;
							else resolveThird = resolve;
						})
				);
			},
			{
				key: 'window',
				collections: ['jobs'],
				cache: {
					hydrated: Effect.void,
					read: () => Effect.succeed(undefined),
					write: () => undefined,
					invalidate: () => [],
					clear: () => undefined
				},
				registry: {
					register: (registration) => {
						reload = registration.reexecute;
					},
					reexecuteAffected: () => 0,
					size: () => 1
				}
			},
			Schema.String
		);
		expect(await Promise.resolve(query)).toBe('retained');
		const older = Effect.runPromise(reload?.() ?? Effect.void);
		expect(query.current).toBe('retained');
		expect(query.loading).toBe(true);
		const newer = Effect.runPromise(reload?.() ?? Effect.void);
		resolveThird('newest');
		await newer;
		resolveSecond('superseded');
		await older;
		expect(query.current).toBe('newest');
		expect(query.loading).toBe(false);
	});
});
