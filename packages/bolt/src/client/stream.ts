// One live stream for every query in this client, retained while views are subscribed, including in background tabs.
import type { Frame } from '../protocol/wire.ts';

export type EventSourceLike = { onmessage: ((event: MessageEvent<string>) => void) | null; onerror: ((event: Event) => void) | null; close(): void };
/** The two signals the link's liveness rides on: whether the tab is hidden, and whether the browser is back online. */
export type Signals = { readonly hidden: boolean; addEventListener(type: 'visibilitychange' | 'online', listener: () => void): void };
/** From 0.5 s, doubling to 30 s, each wait spread ±50% so a hundred tabs that dropped together do not all return together. */
const BACKOFF_MS = 500, BACKOFF_MAX_MS = 30_000;

export function liveStream(open: () => EventSourceLike, onFrame: (frame: Frame) => void, onDown: () => void, signals?: Signals) {
	let source: EventSourceLike | null = null, wanted = false, attempt = 0, retrying = false;
	let retry: ReturnType<typeof setTimeout> | undefined;

	/** The link is gone: every view stops trusting what it held until the next `hello` re-answers it. */
	const drop = () => { if (source === null) return; source.close(); source = null; onDown(); };
	/**
	 * The only thing that opens or closes the stream, and it re-derives rather than steps: every event runs it, so a timer
	 * that fires after the world moved on finds the stream already where it belongs instead of stranding it.
	 */
	function reconcile(): void {
		clearTimeout(retry);
		if (!wanted) { retrying = false; drop(); return; }
		if (source !== null) return;
		retrying = false;
		source = open();
		source.onmessage = (event) => { attempt = 0; onFrame(JSON.parse(event.data) as Frame); };
		source.onerror = () => {
			drop();
			retrying = true;
			retry = setTimeout(reconcile, Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** attempt++ * (0.5 + Math.random())));
		};
	}

	// Returning to the tab or network retries a dropped connection immediately.
	signals?.addEventListener('visibilitychange', reconcile);
	signals?.addEventListener('online', reconcile);

	return {
		get open() { return source !== null; },
		/** A drop is being retried: the link is down, not merely unasked-for (the shell's `connecting` says so). */
		get retrying() { return retrying; },
		restart() { drop(); reconcile(); },
		want(on: boolean) {
			wanted = on;
			reconcile();
		},
	};
}
