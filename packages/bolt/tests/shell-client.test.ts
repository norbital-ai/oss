import { expect, it } from '@effect/vitest';
import { Effect, Stream } from 'effect';
import { follow_client } from '../src/shell/runtime.ts';

it.effect('both an online browser and one that missed the release close discover the changed client', () =>
	Effect.gen(function* () {
		for (const states of [
			['connecting', 'live', 'closed', 'connecting', 'live'],
			['connecting', 'live', 'connecting', 'live']
		] as const) {
			let reads = 0, reloads = 0;
			yield* follow_client(Stream.fromIterable(states), Effect.sync(() => {
				reads++;
				return { client: 'new-client' };
			}), () => 'old-client', Effect.sync(() => { reloads++; }));
			expect({ reads, reloads }).toEqual({ reads: 1, reloads: 1 });
		}
	})
);

it.effect('keeps the initial connection and reconnects with an unchanged client in place', () =>
	Effect.gen(function* () {
		let reads = 0, reloads = 0;
		const read = Effect.sync(() => { reads++; return { client: 'same-client' }; });
		const changed = Effect.sync(() => { reloads++; });
		yield* follow_client(Stream.make('connecting', 'live'), read, () => 'same-client', changed);
		expect({ reads, reloads }).toEqual({ reads: 0, reloads: 0 });
		yield* follow_client(Stream.make('live', 'connecting', 'live'), read, () => 'same-client', changed);
		expect({ reads, reloads }).toEqual({ reads: 1, reloads: 0 });
	})
);
