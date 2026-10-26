// One scoped EventSource connection; every reconnect wait belongs to the consuming runtime. A page hidden for 30 s lets
// its connection go (the server's `every` timers and the stream's hold on the cell end with it) until it is visible.
import { Cause, Duration, Effect, Queue, Random, Schedule, Schema, Stream } from 'effect';
import { ProtocolFailed } from '../decl/errors.ts';
import { Frame } from '../protocol/schema.ts';

export type EventSourceLike = {
	onmessage: ((event: MessageEvent<string>) => void) | null;
	onerror: ((event: Event) => void) | null;
	close(): void;
};
export type Signals = {
	readonly hidden: boolean;
	addEventListener(type: 'visibilitychange' | 'online', listener: () => void): void;
	removeEventListener?(type: 'visibilitychange' | 'online', listener: () => void): void;
};
/** The browser page's visibility (document) and connectivity (window); none outside a page. */
export const pageSignals = (): Signals | undefined =>
	typeof document === 'undefined'
		? undefined
		: {
				get hidden() {
					return document.hidden;
				},
				addEventListener: (type, listener) => {
					if (type === 'online') window.addEventListener(type, listener);
					else document.addEventListener(type, listener);
				},
				removeEventListener: (type, listener) => {
					if (type === 'online') window.removeEventListener(type, listener);
					else document.removeEventListener(type, listener);
				}
			};
const decodeFrame = Schema.decodeUnknownResult(Schema.fromJsonString(Frame));
const reconnect = Schedule.min([
	Schedule.exponential('500 millis').pipe(
		Schedule.modifyDelay(({ duration }) =>
			Random.nextBetween(0.5, 1.5).pipe(Effect.map((factor) => Duration.times(duration, factor)))
		)
	),
	Schedule.spaced('30 seconds')
]);
/** How long a hidden page keeps its live connection. */
const HIDDEN = Duration.seconds(30);

export function liveStream(
	open: () => EventSourceLike,
	onDown: Effect.Effect<void> = Effect.void,
	signals?: Signals,
	restart?: Effect.Effect<void>
): Stream.Stream<Frame, ProtocolFailed> {
	const missing = new ProtocolFailed({ message: 'The live connection is gone.' }),
		asleep = new ProtocolFailed({ message: 'The page is hidden.' });
	const until = (hidden: boolean, page: Signals) =>
		Effect.suspend(() =>
			page.hidden === hidden
				? Effect.void
				: Effect.callback<void>((resume) => {
						const check = () => {
							if (page.hidden === hidden) resume(Effect.void);
						};
						page.addEventListener('visibilitychange', check);
						return Effect.sync(() => page.removeEventListener?.('visibilitychange', check));
					})
		);
	const retry = reconnect.pipe(
		Schedule.modifyDelay(({ input, duration }) =>
			input === missing
				? Effect.succeed(Duration.zero)
				: signals === undefined
					? Effect.succeed(duration)
					: input === asleep
						? until(false, signals).pipe(Effect.as(Duration.zero))
						: Effect.raceFirst(
								Effect.sleep(duration),
								Effect.callback<void>((resume) => {
									const ready = () => resume(Effect.void);
									const visible = () => {
										if (!signals.hidden) ready();
									};
									signals.addEventListener('visibilitychange', visible);
									signals.addEventListener('online', ready);
									return Effect.sync(() => {
										signals.removeEventListener?.('visibilitychange', visible);
										signals.removeEventListener?.('online', ready);
									});
								})
							).pipe(Effect.as('0 millis'))
		)
	);
	const connection = Stream.callback<Frame, ProtocolFailed>((queue) =>
		Effect.acquireRelease(
			Effect.try({
				try: open,
				catch: () => new ProtocolFailed({ message: 'The live connection could not be opened.' })
			}),
			(source) => Effect.sync(() => source.close()).pipe(Effect.andThen(onDown))
		).pipe(
			Effect.flatMap((source) =>
				Effect.sync(() => {
					source.onmessage = (event) => {
						const frame = decodeFrame(event.data);
						if (frame._tag === 'Success') Queue.offerUnsafe(queue, frame.success);
						else
							Queue.failCauseUnsafe(
								queue,
								Cause.fail(
									new ProtocolFailed({ message: 'The live connection returned an invalid frame.' })
								)
							);
					};
					source.onerror = () =>
						Queue.failCauseUnsafe(
							queue,
							Cause.fail(new ProtocolFailed({ message: 'The live connection was interrupted.' }))
						);
				})
			)
		)
	);
	const restarting =
		restart === undefined
			? connection
			: connection.pipe(Stream.mergeEffect(restart.pipe(Effect.andThen(Effect.fail(missing)))));
	return (
		signals === undefined
			? restarting
			: restarting.pipe(
					Stream.mergeEffect(
						until(true, signals).pipe(
							Effect.andThen(
								Effect.raceFirst(
									Effect.sleep(HIDDEN).pipe(Effect.andThen(Effect.fail(asleep))),
									until(false, signals)
								)
							),
							Effect.forever
						)
					)
				)
	).pipe(Stream.retry(retry));
}
