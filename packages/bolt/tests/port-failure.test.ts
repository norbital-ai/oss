// A host tool's rejection keeps its message: Studio rejects with an encoded `HostFailure` object, not an `Error`.
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { Port } from '../src/engine/port.ts';

it.effect('a rejected HostFailure object keeps its message', () =>
	Effect.gen(function* () {
		const failure = yield* Port.attempt('workspace_write', () =>
			Promise.reject({
				_tag: 'HostFailure',
				code: 'refused',
				phase: 'admission',
				message: 'Open Studio first'
			})
		).pipe(Effect.flip);
		expect(failure.message).toBe('Open Studio first');
	})
);

it.effect('a rejection with no message names its facility', () =>
	Effect.gen(function* () {
		const failure = yield* Port.attempt('workspace_write', () => Promise.reject(new Error(''))).pipe(
			Effect.flip
		);
		expect(failure.message).toBe('workspace_write failed');
	})
);
