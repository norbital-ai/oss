import { Effect } from 'effect';
import { SerializationReplay } from '../errors.ts';
import { SqlSessionDb } from '../db/tenant-db.ts';

/** Replans once; exhaustion settles the original database decision. */
export function replayOnce<A, E, R>(
	work: (
		replay: (settle: Effect.Effect<A, E, R>) => Effect.Effect<never, SerializationReplay>
	) => Effect.Effect<A, E | SerializationReplay, R>
): Effect.Effect<A, E | SerializationReplay, R> {
	return Effect.gen(function* (): Effect.fn.Return<A, E | SerializationReplay, R> {
		if ((yield* SqlSessionDb) !== undefined)
			return yield* work(() => Effect.fail(new SerializationReplay()));
		let settle: Effect.Effect<A, E, R> | undefined;
		const attempt = Effect.suspend(() =>
			work((value) => {
				settle = value;
				return Effect.fail(new SerializationReplay());
			})
		);
		return yield* attempt.pipe(
			Effect.retry({
				times: 1,
				while: (error) =>
					error instanceof SerializationReplay && error._tag === 'SerializationReplay'
			}),
			Effect.catch((error): Effect.Effect<A, E | SerializationReplay, R> =>
				error instanceof SerializationReplay ? (settle ?? Effect.fail(error)) : Effect.fail(error)
			),
			Effect.withSpan('Bolt.serializationReplay')
		);
	});
}
