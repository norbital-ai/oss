// The browser live stream (rule 67, design rule 28): one `EventSource` per visible tab, opened while any view is live,
// closed once the tab has been hidden for 30 s and reopened when it shows. The link is a function of two facts — someone is
// watching, and the tab is not long hidden — and `reconcile` is the only thing that acts on them, so no timer or event can
// leave the stream in a state nothing later revisits. A drop is retried here rather than left to the browser, which retries a
// transient failure but gives up for good on a refused or malformed one. No WebSocket, no cross-tab broker, no durable store.
import type { Frame } from '../protocol/wire.ts';

export type EventSourceLike = { onmessage: ((event: MessageEvent<string>) => void) | null; onerror: ((event: Event) => void) | null; close(): void };
/** The two signals the link's liveness rides on: whether the tab is hidden, and whether the browser is back online. */
export type Signals = { readonly hidden: boolean; addEventListener(type: 'visibilitychange' | 'online', listener: () => void): void };
export const HIDDEN_CLOSE_MS = 30_000;
/** From 0.5 s, doubling to 30 s, each wait spread ±50% so a hundred tabs that dropped together do not all return together. */
const BACKOFF_MS = 500, BACKOFF_MAX_MS = 30_000;

export function liveStream(open: () => EventSourceLike, onFrame: (frame: Frame) => void, onDown: () => void, signals?: Signals) {
	let source: EventSourceLike | null = null, wanted = false, attempt = 0, retrying = false, hiddenSince = 0;
	let retry: ReturnType<typeof setTimeout> | undefined, grace: ReturnType<typeof setTimeout> | undefined;

	/** The link is gone: every view stops trusting what it held until the next `hello` re-answers it. */
	const drop = () => { if (source === null) return; source.close(); source = null; onDown(); };
	/** The whole lifecycle, as one fact: someone is watching, and this tab is not long hidden. */
	const shouldBeUp = () => wanted && (signals === undefined || !signals.hidden || Date.now() - hiddenSince < HIDDEN_CLOSE_MS);

	/**
	 * The only thing that opens or closes the stream, and it re-derives rather than steps: every event runs it, so a timer
	 * that fires after the world moved on finds the stream already where it belongs instead of stranding it.
	 */
	function reconcile(): void {
		clearTimeout(retry);
		if (!shouldBeUp()) { retrying = false; drop(); return; }
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

	signals?.addEventListener('visibilitychange', () => {
		hiddenSince = signals.hidden ? Date.now() : 0;
		// hidden: the stream rides out a quick tab switch, and the grace timer is the one thing that re-derives it after 30 s.
		// shown: it comes straight back, whatever left it down, and a backoff in flight starts over rather than resuming.
		if (signals.hidden) grace = setTimeout(reconcile, HIDDEN_CLOSE_MS);
		else { clearTimeout(grace); reconcile(); }
	});
	// back online: a wait that was only the network's is over, so a drop comes back at once rather than after its backoff
	signals?.addEventListener('online', reconcile);

	return {
		get open() { return source !== null; },
		/** A drop is being retried: the link is down, not merely unasked-for (the shell's `connecting` says so). */
		get retrying() { return retrying; },
		want(on: boolean) {
			wanted = on;
			// a new view in a hidden tab is someone reading it (a background load, an automated browser): the grace restarts
			// from now, so the read is answered rather than left loading until the tab is shown
			if (on && signals?.hidden === true) {
				hiddenSince = Date.now();
				clearTimeout(grace);
				grace = setTimeout(reconcile, HIDDEN_CLOSE_MS);
			}
			reconcile();
		},
	};
}
