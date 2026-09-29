// `$bolt` over a test fetch: its live stream is the handler's own SSE body, read as an EventSource would.
import { createBolt, type Bolt } from '../../src/client/bolt.ts';
import type { EventSourceLike } from '../../src/client/stream.ts';

/** A test EventSource over the handler's SSE body. */
export function sse(fetch: (url: string) => Promise<Response>, url: string): EventSourceLike {
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const source: EventSourceLike = { onmessage: null, onerror: null, close: () => void reader?.cancel() };
	void (async () => {
		reader = (await fetch(url)).body!.getReader();
		const text = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
			if (done) return;
			buffer += text.decode(value, { stream: true });
			for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
				const data = buffer.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
				buffer = buffer.slice(i + 2);
				if (data !== '') source.onmessage?.(new MessageEvent('message', { data }));
			}
		}
	})();
	return source;
}

/** The agent panel's `bolt` (its live transcript) over the same fetch as its `api`. */
export const liveBolt = (fetch: typeof globalThis.fetch): Bolt =>
	createBolt({ actor: null, locale: 'en', fetch, openStream: (url) => sse((u) => fetch(u), url) });
