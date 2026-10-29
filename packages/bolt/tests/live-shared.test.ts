// sharedSource: one live connection per browser, its frames relayed to every tab (BroadcastChannel + Web Locks).
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { sharedSource, type EventSourceLike } from '../src/page/stream.ts';

/** Every tab's frame or connection is a change; a check waits on changes until it holds. */
const changes = new EventTarget();
const until = (check: () => boolean) =>
	Effect.promise(async () => {
		while (!check())
			await new Promise((resolve) => changes.addEventListener('change', resolve, { once: true }));
	});

/** A tab: the stream it would open when it leads, and every frame it hears. */
const tab = (url: string) => {
	const heard: string[] = [];
	const opened: EventSourceLike[] = [];
	const source = sharedSource(url, () => {
		const stream: EventSourceLike = { onmessage: null, onerror: null, close: () => undefined };
		opened.push(stream);
		changes.dispatchEvent(new Event('change'));
		return stream;
	});
	source.onmessage = (event) => {
		heard.push(event.data);
		changes.dispatchEvent(new Event('change'));
	};
	const send = (data: string) =>
		opened.at(-1)?.onmessage?.(new MessageEvent('message', { data }));
	return { source, heard, opened, send };
};

describe('shared live connection', () => {
	it.live('one tab connects; the others hear its frames; the next tab leads when it goes', () =>
		Effect.gen(function* () {
			const url = `/t${Math.random()}/__bolt/live`;
			const a = tab(url),
				b = tab(url);
			yield* until(() => a.opened.length === 1);
			a.send('{"t":"hello","conn":"c1","v":0}');
			a.send('{"t":"v","v":1}');
			yield* until(() => b.heard.length === 2);
			expect(a.heard).toEqual(b.heard);
			expect(b.opened).toEqual([]);
			// a tab that joins later is answered the leader's hello
			const c = tab(url);
			yield* until(() => c.heard.length === 1);
			expect(c.heard).toEqual(['{"t":"hello","conn":"c1","v":0}']);
			// only the asker: a tab that heard the hello registers its views once
			a.send('{"t":"v","v":2}');
			yield* until(() => b.heard.length === 3 && c.heard.length === 2);
			expect(b.heard).toEqual(a.heard);
			a.source.close();
			yield* until(() => b.opened.length + c.opened.length === 1);
			const next = b.opened.length === 1 ? b : c;
			next.send('{"t":"hello","conn":"c2","v":1}');
			yield* until(() => b.heard.at(-1) === c.heard.at(-1));
			expect(b.heard.at(-1)).toBe('{"t":"hello","conn":"c2","v":1}');
			b.source.close();
			c.source.close();
		})
	);
});
