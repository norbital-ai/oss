import { describe, expect, it } from 'vitest';
import { Effect, Schema } from 'effect';
import { createRemoteQuery } from '../../src/client/remote-query.svelte.js';

/**
 * What a failing remote tells the reader.
 *
 * `refresh` catches so the reactive `error` cell can hold the cause, which left the awaited half with
 * nothing but "the value is undefined" to say — it raised `Remote invocation completed without a
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
});
