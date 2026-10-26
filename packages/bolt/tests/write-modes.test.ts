import { assert, it } from '@effect/vitest';
import { Effect } from 'effect';
import { modeContext } from '../src/engine/write/act.ts';
import { replayOnce } from '../src/engine/write/replay.ts';
import type { ActMode } from '../src/engine/services.ts';

it.effect('all act modes preserve their distinct planning inputs', () =>
	Effect.gen(function* () {
		const direct: ActMode = { _tag: 'Direct' };
		const sync: ActMode = {
			_tag: 'Sync',
			sync: 'contacts.sync.remote',
			instance: 'remote',
			fields: ['name'],
			deletes: [],
			pieces: () => {}
		};
		const record: ActMode = { _tag: 'Record', pending: new Map(), sink: () => {} };
		assert.deepStrictEqual(modeContext(direct), {});
		assert.strictEqual(modeContext(sync).sync, sync);
		assert.strictEqual(modeContext(record).pending, record.pending);
		assert.strictEqual(modeContext(record).sink, record.sink);
	})
);
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
