// One scoped EventSource connection; every reconnect wait belongs to the consuming runtime. A page hidden for 30 s lets
// its connection go (the server's `every` timers and the stream's hold on the cell end with it) until it is visible.
import { Cause, Duration, Effect, Queue, Random, Schedule, Schema, Stream } from 'effect';
import { uuidv7 } from '@norbital-ai/host-api';
import { ProtocolFailed } from '../decl/errors.ts';
import { Frame, WireRead } from '../protocol/schema.ts';

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
/** A browser page with BroadcastChannel and Web Locks. */
export const shareable = (): boolean =>
	typeof window !== 'undefined' &&
	typeof BroadcastChannel !== 'undefined' &&
	navigator.locks !== undefined;
/** A view a tab holds through the leader: its id (equal for equivalent reads, `create_bolt`) and its read. */
type Attached = { readonly view: string; readonly read: WireRead };
/** What the leader hears of the other tabs: views attached, views detached, and a tab that has gone. */
export type Hold =
	| { readonly tab: string; readonly attach: readonly Attached[] }
	| { readonly tab: string; readonly detach: readonly string[] }
	| { readonly gone: string };
/** A tab's part in the browser's one live connection. */
export type SharedSource = EventSourceLike & {
	/** This tab holds the connection's lock and stream. */
	readonly leads: boolean;
	/** The first frame of the stream this tab opened (its connection's `hello`), once it arrives. */
	readonly own: string | undefined;
	/** The leader passes on a frame once it has applied it; a `hello` makes every tab attach its views again. */
	relay(data: string, hello: boolean): void;
	/** The leader sends one tab a frame: the image of a view it attached, or a refusal. */
	send(tab: string, frame: string): void;
	/** A follower attaches views to the leader's, or detaches them. */
	hold(attach: readonly Attached[], detach: readonly string[]): void;
	/** The leader hears every other tab's holds. */
	onhold: ((hold: Hold) => void) | null;
};
const Attach = Schema.Struct({ view: Schema.String, read: WireRead });
/**
 * On a tab's channel: a frame the leader applied, a joining tab's question, the leader's `hello` (to every tab for a new
 * connection, or to the tab that asked), a frame to one tab, and a follower's attach or detach.
 */
const TabMessage = Schema.Union([
	Schema.String,
	Schema.Struct({ ask: Schema.String }),
	Schema.Struct({ hello: Schema.String, to: Schema.optionalKey(Schema.String) }),
	Schema.Struct({ to: Schema.String, frame: Schema.String }),
	Schema.Struct({ tab: Schema.String, attach: Schema.Array(Attach) }),
	Schema.Struct({ tab: Schema.String, detach: Schema.Array(Schema.String) })
]);
const decodeMessage = Schema.decodeUnknownOption(TabMessage);
/**
 * One live connection per browser for `url`, however many tabs show it: HTTP/1.1 allows six connections a host, so a
 * stream per tab starves every other request of the sixth tab. The tab holding the Web Lock opens the stream and owns
 * every tab's views: equivalent ones are one registration on its connection, and it relays each frame over a
 * BroadcastChannel once applied. A follower attaches its views (`hold`) and is sent each one's current image before any
 * later frame; one that joins asks for the leader's `hello`. Each tab holds a lock of its own for its life: the leader
 * waits on it, so a tab that closes or dies lets its views go without a poll. When the leader goes its lock passes to
 * the next tab, whose `hello` makes every tab attach its views again.
 */
export function sharedSource(url: string, open: () => EventSourceLike): SharedSource {
	const name = `bolt-live:${url}`,
		me = uuidv7(),
		channel = new BroadcastChannel(name),
		waiting = new AbortController(),
		watched = new Set<string>();
	let source: EventSourceLike | undefined,
		own: string | undefined,
		hello: string | undefined,
		release: (() => void) | undefined,
		alive: (() => void) | undefined;
	const post = (message: typeof TabMessage.Type) => channel.postMessage(message);
	const deliver = (data: string) => self.onmessage?.(new MessageEvent('message', { data }));
	const self: SharedSource = {
		onmessage: null,
		onerror: null,
		onhold: null,
		get leads() {
			return source !== undefined;
		},
		get own() {
			return own;
		},
		relay: (data, greet) => {
			if (greet) hello = data;
			post(greet ? { hello: data } : data);
		},
		send: (to, frame) => post({ to, frame }),
		hold: (attach, detach) => {
			if (attach.length > 0) post({ tab: me, attach });
			if (detach.length > 0) post({ tab: me, detach });
		},
		close: () => {
			waiting.abort();
			channel.close();
			source?.close();
			source = undefined;
			release?.();
			alive?.();
		}
	};
	// a holding tab's lock passes to the leader only when that tab closes or dies
	const watch = (tab: string) => {
		if (watched.has(tab)) return;
		watched.add(tab);
		navigator.locks
			.request(`${name}#${tab}`, { signal: waiting.signal }, () => {
				watched.delete(tab);
				if (source !== undefined) self.onhold?.({ gone: tab });
			})
			.catch(() => undefined);
	};
	channel.onmessage = (event: MessageEvent<unknown>) => {
		const message = decodeMessage(event.data);
		if (message._tag === 'None') return;
		const m = message.value;
		if (source !== undefined) {
			if (typeof m === 'string') return;
			if ('ask' in m) {
				if (hello !== undefined) post({ to: m.ask, hello });
			} else if ('attach' in m) {
				watch(m.tab);
				self.onhold?.(m);
			} else if ('detach' in m) self.onhold?.(m);
		} else if (typeof m === 'string') deliver(m);
		// every tab attaches again on a new connection's hello; the answer to its question only while it has none
		else if ('hello' in m) {
			if (m.to === undefined || (m.to === me && hello === undefined)) {
				hello = m.hello;
				deliver(m.hello);
			}
		} else if ('to' in m && m.to === me) deliver(m.frame);
	};
	navigator.locks
		.request(
			`${name}#${me}`,
			{ signal: waiting.signal },
			() =>
				new Promise<void>((resolve) => {
					alive = resolve;
				})
		)
		.catch(() => undefined);
	navigator.locks
		.request(
			name,
			{ signal: waiting.signal },
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
					// a question is answered only with this connection's own hello
					hello = undefined;
					try {
						source = open();
					} catch {
						self.onerror?.(new Event('error'));
						return resolve();
					}
					source.onmessage = (event) => {
						own ??= event.data;
						deliver(event.data);
					};
					source.onerror = (event) => self.onerror?.(event);
				})
		)
		.catch(() => undefined);
	post({ ask: me });
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

/** A frame as the stream decoded it, beside the text it came as (what a leading tab relays). */
export type Received = { readonly message: Frame; readonly data: string };
export function liveStream(
	open: () => EventSourceLike,
	onDown: Effect.Effect<void> = Effect.void,
	signals?: Signals,
	restart?: Effect.Effect<void>
): Stream.Stream<Received, ProtocolFailed> {
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
	const connection = Stream.callback<Received, ProtocolFailed>((queue) =>
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
						if (frame._tag === 'Success')
							Queue.offerUnsafe(queue, { message: frame.success, data: event.data });
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
