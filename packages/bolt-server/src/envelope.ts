import { Deferred, Effect, Latch, Option, Queue, Ref, Semaphore } from 'effect';
import { BoltError } from '@norbital-ai/bolt/engine';
/** One activation's FIFO envelope; the first lane is interactive, the second is background work. */
export const envelope = (max: number) =>
	Effect.gen(function* () {
		const capacity = max === Infinity ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.ceil(max));
		const permits = yield* Semaphore.make(capacity),
			idle = yield* Latch.make(true),
			open = yield* Ref.make(true);
		type Waiter = {
			readonly ready: Deferred.Deferred<void, BoltError>;
			readonly state: Ref.Ref<'Waiting' | 'Granted' | 'Released'>;
		};
		const lanes = [yield* Queue.unbounded<Waiter>(), yield* Queue.unbounded<Waiter>()] as const;
		const busy = () => BoltError.make('busy', 'admission', 'The server is draining.');
		const next = Effect.gen(function* () {
			while (yield* permits.takeIfAvailable(1)) {
				const high = yield* Queue.poll(lanes[0]),
					waiter = Option.isSome(high) ? high : yield* Queue.poll(lanes[1]);
				if (Option.isNone(waiter)) {
					yield* permits.release(1);
					break;
				}
				const granted = yield* Ref.modify(waiter.value.state, (state) =>
					state === 'Waiting' ? ([true, 'Granted'] as const) : ([false, state] as const)
				);
				if (!granted) {
					yield* permits.release(1);
					continue;
				}
				yield* idle.close;
				yield* Deferred.succeed(waiter.value.ready, undefined);
			}
			if (yield* permits.takeIfAvailable(capacity)) {
				yield* permits.release(capacity);
				yield* idle.open;
			}
		}).pipe(Effect.uninterruptible);
		const admit = <A, E, R>(lane: 0 | 1, work: Effect.Effect<A, E, R>) =>
			Effect.acquireUseRelease(
				Effect.gen(function* () {
					if (!(yield* Ref.get(open))) return yield* Effect.fail(busy());
					const waiter: Waiter = {
						ready: yield* Deferred.make<void, BoltError>(),
						state: yield* Ref.make<'Waiting' | 'Granted' | 'Released'>('Waiting')
					};
					yield* Queue.offer(lanes[lane], waiter);
					yield* next;
					return waiter;
				}),
				(waiter) => Deferred.await(waiter.ready).pipe(Effect.andThen(work)),
				(waiter) =>
					Ref.getAndSet(waiter.state, 'Released').pipe(
						Effect.flatMap((state) =>
							state === 'Granted' ? permits.release(1).pipe(Effect.andThen(next)) : next
						)
					)
			);
		const drain = (ms: number) =>
			Effect.gen(function* () {
				yield* Ref.set(open, false);
				for (const lane of lanes)
					while (true) {
						const waiting = yield* Queue.poll(lane);
						if (Option.isNone(waiting)) break;
						yield* Deferred.fail(waiting.value.ready, busy());
					}
				return Option.isSome(yield* idle.await.pipe(Effect.timeoutOption(ms)));
			});
		yield* Effect.addFinalizer(() => drain(10_000).pipe(Effect.asVoid));
		return { admit, drain };
	});
