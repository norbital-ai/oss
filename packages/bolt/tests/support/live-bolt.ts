// `$bolt` over a test fetch: its live stream is the handler's own SSE body, scoped like the client.
import { Cause, Effect, Fiber, FiberSet, type Scope, Stream } from 'effect';
import { Sse } from 'effect/encoding';
import { createBolt, type Bolt } from '../../src/page/bolt.ts';
import type { EventSourceLike } from '../../src/page/stream.ts';
import { ProtocolFailed } from '../../src/decl/errors.ts';

/** A test EventSource factory whose readers close with the calling test's scope. */
export const sse = <E>(
	fetch: (url: string) => Effect.Effect<Response, E>
): Effect.Effect<(url: string) => EventSourceLike, never, Scope.Scope> =>
	Effect.gen(function* () {
		const run = yield* FiberSet.makeRuntime<never, void, never>();
		return (url: string): EventSourceLike => {
			let closed = false;
			const source: EventSourceLike = {
				onmessage: null,
				onerror: null,
				close: () => {
					closed = true;
					run(Fiber.interrupt(fiber));
				}
			};
			const fiber = run(
				Effect.gen(function* () {
					const response = yield* fetch(url);
					if (response.body === null)
						return yield* Effect.fail(
							new ProtocolFailed({ message: 'The live response has no body.' })
						);
					const body = response.body;
					yield* Stream.fromReadableStream({
						evaluate: () => body,
						onError: (error) => new ProtocolFailed({ message: String(error) })
					}).pipe(
						Stream.decodeText(),
						Stream.pipeThroughChannel(Sse.decode()),
						Stream.runForEach((event) =>
							Effect.sync(() => {
								if (!closed && event.data !== '')
									source.onmessage?.(new MessageEvent('message', { data: event.data }));
							})
						)
					);
				}).pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.void
							: Effect.logWarning(cause).pipe(
									Effect.andThen(
										Effect.sync(() => {
											if (!closed) source.onerror?.(new Event('error'));
										})
									)
								)
					)
				)
			);
			return source;
		};
	});

/** The agent panel's `bolt` over the same browser fetch ABI as its `api`. */
export const liveBolt = (fetch: typeof globalThis.fetch): Effect.Effect<Bolt, never, Scope.Scope> =>
	Effect.gen(function* () {
		const openStream = yield* sse((url) =>
			Effect.tryPromise({
				try: (signal) => fetch(url, { signal }),
				catch: (error) => new ProtocolFailed({ message: String(error) })
			})
		);
		return yield* createBolt({ actor: null, locale: 'en', fetch, openStream });
	});
