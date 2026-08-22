import { Result, Schema } from 'effect';
import { workspaceSession } from '#lib/client/session.js';
/**
 * Listening for changes instead of asking for them.
 *
 * The replica used to poll `sync.diff` on a backing-off timer. Polling is wrong here in both
 * directions at once: a workspace that is quiet for an afternoon still costs a request per open tab,
 * and a workspace that is busy still shows a change an interval late. Moving the interval trades one
 * against the other and removes neither, because they are not the same problem.
 *
 * So the host tells us. It holds the connection, the write path announces on a topic, and the host
 * fans that out. What arrives is only the names of the collections that changed — the changes
 * themselves still come through `sync.diff`, so the log stays the single ordered account of what
 * happened and this connection stays a hint rather than a second, weaker copy of it.
 *
 * `EventSource` rather than a socket, and that is a deliberate narrowing: the browser reconnects on
 * its own with backoff, resumes from `Last-Event-ID`, and survives a laptop sleeping. A WebSocket
 * would need all three written here, and the traffic is one-way anyway — every write already has a
 * command channel to travel on.
 */

type SubscribeOptions = Readonly<{
	/** Called with the collections a change touched. May be empty, which means "something changed". */
	readonly onChange: (collections: ReadonlyArray<string>) => void;
	/** Called when the connection is established, and again after each reconnect. */
	readonly onOpen?: () => void;
	readonly onError?: ((cause: unknown) => void) | undefined;
	/** Overridable so a test can supply a stub; the browser's own `EventSource` otherwise. */
	readonly source?: (url: string) => EventSourceLike;
}>;

/**
 * The slice of `EventSource` this uses, so a test needs no DOM.
 *
 * `onerror` is deliberately nullable the way the DOM type is: `EventSource` exposes it as a
 * property rather than a method. Adapting a real `EventSource` is a framework boundary — its
 * members are wider (real `MessageEvent`s, positional overloads) — so the narrowing happens in one
 * place below rather than at every call site.
 */
export type EventSourceLike = {
	addEventListener: (type: string, listener: (event: { data?: string }) => void) => void;
	close: () => void;
	onerror: ((event: unknown) => void) | null;
};

export type Subscription = Readonly<{ readonly stop: () => void }>;

/** The one object the host's change fan-out releases: the names of the collections that changed. */
const ChangeFrame = Schema.Struct({
	collections: Schema.Array(Schema.String)
});

const parseCollections = (data: string | undefined): ReadonlyArray<string> => {
	if (data === undefined || data.length === 0) return [];
	return (
		Result.getOrElse(
			Schema.decodeUnknownResult(Schema.fromJsonString(ChangeFrame))(data),
			() => null
		)?.collections ?? []
	);
};

/**
 * Opens the stream and reports what changed.
 *
 * Errors are reported but never terminate the subscription — `EventSource` reconnects on its own,
 * and closing it here on the first network blip would turn a momentary disconnection into a tab that
 * silently stops updating until someone reloads it.
 */
export const subscribeToChanges = (options: SubscribeOptions): Subscription => {
	const create =
		options.source ??
		((url: string): EventSourceLike => {
			// The browser's `EventSource` is wider than the slice this module uses — real
			// `MessageEvent`s, positional overloads, non-nullable members — so the framework boundary
			// is adapted here, once, instead of asserted at each call site.
			const source = new EventSource(url, { withCredentials: true });
			return {
				addEventListener: (type, listener) =>
					source.addEventListener(type, (event) => {
						listener(event instanceof MessageEvent ? { data: String(event.data) } : {});
					}),
				close: () => source.close(),
				set onerror(listener: ((event: unknown) => void) | null) {
					source.onerror = listener;
				}
			};
		});

	const opened = Result.try(() => create(workspaceSession().syncStreamUrl));
	if (Result.isFailure(opened)) {
		// No `EventSource` at all — a non-browser runtime, or a policy that blocks it. The replica
		// still works; it just only learns about changes when something else asks it to drain.
		options.onError?.(opened.failure);
		return { stop: () => undefined };
	}
	const source = opened.success;

	source.addEventListener('sync', (event) => options.onChange(parseCollections(event.data)));
	source.addEventListener('ready', () => options.onOpen?.());
	source.onerror = (event) => options.onError?.(event);

	return { stop: () => void Result.try(() => source.close()) };
};
