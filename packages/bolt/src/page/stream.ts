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
/**
 * One live connection per browser for `url`, however many tabs show it: HTTP/1.1 allows six connections a host, so a
 * stream per tab starves every other request of the sixth tab. The tab holding the Web Lock opens the stream and relays
 * its frames over a BroadcastChannel; the others follow, and one that joins later asks the leader for its `hello` (a
 * stream's first frame). When the leader goes its lock passes to the next tab, whose `hello` re-registers every tab's
 * views. Frames name their views, so each tab applies only its own (view ids are unique a tab).
 */
/** A browser page with BroadcastChannel and Web Locks. */
export const shareable = (): boolean =>
	typeof window !== 'undefined' &&
	typeof BroadcastChannel !== 'undefined' &&
	navigator.locks !== undefined;
/** On a tab's channel: a frame the leader relays, a joining tab's question, or the leader's `hello` answering it. */
const Relayed = Schema.Union([
	Schema.String,
	Schema.Struct({ ask: Schema.String }),
	Schema.Struct({ to: Schema.String, hello: Schema.String })
]);
const decodeRelayed = Schema.decodeUnknownOption(Relayed);
export function sharedSource(url: string, open: () => EventSourceLike): EventSourceLike {
	const name = `bolt-live:${url}`,
		me = crypto.randomUUID(),
		channel = new BroadcastChannel(name),
		waiting = new AbortController();
	let source: EventSourceLike | undefined,
		hello: string | undefined,
		heard = false,
		release: (() => void) | undefined;
	const self: EventSourceLike = {
		onmessage: null,
		onerror: null,
		close: () => {
			waiting.abort();
			channel.close();
			source?.close();
			release?.();
		}
	};
	const deliver = (data: string) => {
		heard = true;
		self.onmessage?.(new MessageEvent('message', { data }));
	};
	channel.onmessage = (event: MessageEvent<unknown>) => {
		const message = decodeRelayed(event.data);
		if (message._tag === 'None') return;
		const m = message.value;
		if (typeof m === 'string') {
			if (source === undefined) deliver(m);
		} else if ('ask' in m) {
			if (hello !== undefined) channel.postMessage({ to: m.ask, hello });
		} else if (m.to === me && !heard) deliver(m.hello);
	};
	navigator.locks
		.request(name, { signal: waiting.signal }, () =>
			new Promise<void>((resolve) => {
				release = resolve;
				try {
					source = open();
				} catch {
					self.onerror?.(new Event('error'));
					return resolve();
				}
				source.onmessage = (event) => {
					hello ??= event.data;
					channel.postMessage(event.data);
					deliver(event.data);
				};
				source.onerror = (event) => self.onerror?.(event);
			})
		)
		.catch(() => undefined);
	// only the asker takes the answer: every other tab already registered on that connection
	channel.postMessage({ ask: me });
	return self;
}
const decodeFrame = Schema.decodeUnknownResult(Schema.fromJsonString(Frame));
const reconnect = Schedule.min([
	Schedule.exponential('500 millis').pipe(
		Schedule.modifyDelay(({ duration }) =>
			Random.nextBetween(0.5, 1.5).pipe(Effect.map((factor) => Duration.times(duration, factor)))
		)
	),
	Schedule.spaced('30 seconds')
]);
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
/** Waits while the page is hidden: a poll skips the reads nobody sees. */
export const visible: Effect.Effect<void> = Effect.suspend(() => {
	const page = pageSignals();
	return page === undefined ? Effect.void : until(false, page);
});
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
