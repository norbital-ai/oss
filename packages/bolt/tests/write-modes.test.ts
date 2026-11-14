import { assert, it } from '@effect/vitest';
import { Effect } from 'effect';
import { replayOnce } from '../src/engine/write/replay.ts';

it.effect('a serialization replay retries exactly once before settling', () =>
	Effect.gen(function* () {
		let attempts = 0;
		const answer = yield* replayOnce<string, never, never>((replay) =>
			Effect.suspend(() => {
				attempts++;
				return replay(Effect.succeed('conflict'));
			})
		);
		assert.strictEqual(attempts, 2);
		assert.strictEqual(answer, 'conflict');
	})
);
