// repository-health:allow SEM_PARALLEL -- subscribe consumes sync-client's change decoder over the
// #lib alias, so the pair is linked, not parallel.
import { Result } from 'effect';
import { workspaceSession } from '#lib/client/session.js';
import type { SyncChange, SyncCursor } from '#lib/runtime/sync/sync.js';
import { decodeChanges } from '#lib/client/replica/sync-client.js';

/**
 * The browser's one ordered change stream.
 *
 * The host reads the database outbox through the same authenticated `sync.diff` runtime command and
 * puts those permission-filtered `SyncChange` batches on SSE. The browser never asks for a diff and
 * never polls: it applies each frame directly. EventSource owns network backoff and Last-Event-ID;
 * the cursor query is the persisted replica's starting point on the first connection.
 */

type SubscribeOptions = Readonly<{
	/** The cursor durably reflected by the replica right now. */
	readonly cursor: () => SyncCursor;
	readonly onChange: (changes: ReadonlyArray<SyncChange>) => void;
	/** Called when initial/reconnect catch-up has reached the stream's live edge. */
	readonly onOpen?: () => void;
	readonly onError?: ((cause: unknown) => void) | undefined;
	/** Overridable so a test can supply a stub; the browser's own `EventSource` otherwise. */
	readonly source?: (url: string) => EventSourceLike;
}>;

/** The slice of `EventSource` this uses, so a test needs no DOM. */
export type EventSourceLike = {
	addEventListener: (
		type: string,
		listener: (event: { data?: string; lastEventId?: string }) => void
	) => void;
	close: () => void;
	onerror: ((event: unknown) => void) | null;
};

export type Subscription = Readonly<{ readonly stop: () => void }>;

/** How long after a failed stream construction to try again. */
const RETRY_OPEN_MILLIS = 2_000;

const withCursor = (url: string, cursor: SyncCursor): string => {
	const hashAt = url.indexOf('#');
	const base = hashAt < 0 ? url : url.slice(0, hashAt);
	const hash = hashAt < 0 ? '' : url.slice(hashAt);
	const separator = base.includes('?') ? '&' : '?';
	return `${base}${separator}cursor=${encodeURIComponent(JSON.stringify(cursor))}${hash}`;
};

const parseChanges = (
	data: string | undefined
): Result.Result<ReadonlyArray<SyncChange>, unknown> =>
	Result.try(() => decodeChanges(JSON.parse(data ?? '')));

/** Opens the stream and reports its typed database deltas. */
export const subscribeToChanges = (options: SubscribeOptions): Subscription => {
	const create =
		options.source ??
		((url: string): EventSourceLike => {
			const source = new EventSource(url, { withCredentials: true });
			return {
				addEventListener: (type, listener) =>
					source.addEventListener(type, (event) => {
						listener(
							event instanceof MessageEvent
								? { data: String(event.data), lastEventId: event.lastEventId }
								: {}
						);
					}),
				close: () => source.close(),
				set onerror(listener: ((event: unknown) => void) | null) {
					source.onerror = listener;
				}
			};
		});

	let stopped = false;
	let current: EventSourceLike | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	const open = (): void => {
		if (stopped) return;
		const opened = Result.try(() =>
			create(withCursor(workspaceSession().syncStreamUrl, options.cursor()))
		);
		if (Result.isFailure(opened)) {
			options.onError?.(opened.failure);
			// One failed construction must not permanently silence the stream: EventSource owns its own
			// reconnection only once it exists, so a throw before it exists — a session field not yet
			// populated, a constructor rejection — used to leave a healthy leader with no feed and no
			// error anyone could see. The workspace then simply never updated until a reload.
			retry = setTimeout(open, RETRY_OPEN_MILLIS);
			return;
		}
		const source = opened.success;
		current = source;
		source.addEventListener('sync', (event) => {
			const decoded = parseChanges(event.data);
			if (Result.isSuccess(decoded)) {
				options.onChange(decoded.success);
				return;
			}
			// An unreadable frame must not advance past data the replica never applied. Reopen from the
			// durable cursor in the URL; the server replays the ordered batch from that exact point.
			options.onError?.(decoded.failure);
			source.close();
			if (current === source) current = undefined;
			open();
		});
		source.addEventListener('ready', () => options.onOpen?.());
		// Native EventSource reconnects this same object with Last-Event-ID and browser backoff. Do not
		// close it on an ordinary network error or the browser would never resume it.
		source.onerror = (event) => options.onError?.(event);
	};
	open();

	return {
		stop: () => {
			stopped = true;
			if (retry !== undefined) clearTimeout(retry);
			const source = current;
			current = undefined;
			if (source !== undefined) void Result.try(() => source.close());
		}
	};
};
