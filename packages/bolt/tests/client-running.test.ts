// An act past the person-wait answers `running` (202, compute model §3): the client decodes it as an answer, not a failure.
import { Effect } from 'effect';
import { expect, it } from '@effect/vitest';
import { createBolt } from '../src/page/bolt.ts';
import { statusOf } from '../src/protocol/wire.ts';

it.effect('a running reply is the act answer, carrying its run id', () =>
	Effect.gen(function* () {
		const fetch: typeof globalThis.fetch = async () =>
			Response.json({ outcome: { kind: 'running', run: 'r1' }, v: 0 }, { status: 202 });
		const bolt = yield* createBolt({
			base: 'https://workspace.test',
			actor: null,
			locale: 'en',
			fetch
		});
		expect(yield* bolt.act('jobs.create', { title: 'slow' })).toEqual({
			kind: 'running',
			run: 'r1'
		});
		expect(statusOf({ kind: 'running', run: 'r1' })).toBe(202);
	})
);
