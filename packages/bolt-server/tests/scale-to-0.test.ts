import { assert, it } from '@effect/vitest';
import { Effect } from 'effect';
import { makeLocalDatabase } from '../src/facilities/database.js';
import { makeMemoryTransport } from '../src/facilities/transport.js';

it.effect(
	'clears memory transport and local database on close',
	() =>
		Effect.gen(function* () {
			const transport = makeMemoryTransport();
			assert.strictEqual(transport.activeConnections(), 0);
			yield* Effect.promise(transport.close);
			assert.strictEqual(transport.activeConnections(), 0);

			const database = yield* Effect.tryPromise(() =>
				makeLocalDatabase({ dataDirectory: 'memory://' })
			);
			yield* Effect.promise(database.close);
		}),
	30_000
);
