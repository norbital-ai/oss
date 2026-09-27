// The browser live stream (rule 67): one `EventSource` per visible tab, opened while any view is live, closed 30 s after
// the tab hides and reopened when it shows. No WebSocket, no cross-tab broker, no durable store.
import type { Frame } from '../protocol/wire.ts';

export type EventSourceLike = { onmessage: ((event: MessageEvent<string>) => void) | null; close(): void };
export type Visibility = { readonly hidden: boolean; addEventListener(type: 'visibilitychange', listener: () => void): void };
export const HIDDEN_CLOSE_MS = 30_000;

export function liveStream(open: () => EventSourceLike, onFrame: (frame: Frame) => void, onDown: () => void, visibility?: Visibility) {
	let source: EventSourceLike | null = null, wanted = false;
	let hidden: ReturnType<typeof setTimeout> | undefined;
	const start = () => {
		if (source !== null || !wanted || visibility?.hidden) return;
		source = open();
		// EventSource reconnects by itself after a network error; the server's new `hello` re-registers every view
		source.onmessage = (event) => onFrame(JSON.parse(event.data) as Frame);
	};
	const stop = () => {
		if (source === null) return;
		source.close();
		source = null;
		onDown();
	};
	visibility?.addEventListener('visibilitychange', () => {
		clearTimeout(hidden);
		if (visibility.hidden) hidden = setTimeout(stop, HIDDEN_CLOSE_MS);
		else start();
	});
	return {
		get open() { return source !== null; },
		want(on: boolean) {
			wanted = on;
			if (on) start();
			else stop();
		},
	};
}
