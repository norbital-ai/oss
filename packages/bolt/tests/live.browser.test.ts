import { Effect, Stream } from 'effect';
import { expect, it } from '@effect/vitest';
import { page } from 'vitest/browser';
import { liveStream, pageSignals, shareable, sharedSource } from '../src/page/stream.ts';
import { PATHS } from '../src/protocol/wire.ts';

it.live('native EventSource delivers live frames in Chromium (L-BOLT-1012)', () =>
	Effect.gen(function* () {
		const frames = yield* liveStream(() => new EventSource(PATHS.live)).pipe(
			Stream.take(2),
			Stream.runCollect,
			Effect.timeout('5 seconds')
		);
		expect(frames[0]).toEqual({ t: 'hello', conn: 'browser', v: 0 });
		expect(frames[1]).toEqual({ t: 'patch', view: 'orders', v: 1, ops: [] });
		document.body.replaceChildren();
		document.body.append(
			Object.assign(document.createElement('p'), { textContent: frames[0]?.t ?? '' })
		);
		yield* Effect.tryPromise({
			try: () => expect.element(page.getByText('hello')).toBeInTheDocument(),
			catch: () => new Error('hello frame was not rendered')
		});
	})
);

it.live('liveStream parses EventSource frames', () =>
	Effect.gen(function* () {
		const frames = yield* liveStream(() => new EventSource(PATHS.live)).pipe(
			Stream.take(2),
			Stream.runCollect,
			Effect.timeout('5 seconds')
		);
		expect(frames[0]).toEqual({ t: 'hello', conn: 'browser', v: 0 });
		expect(frames[1]).toEqual({ t: 'patch', view: 'orders', v: 1, ops: [] });
	})
);

it.live('a page hands the live stream its own visibility and connectivity', () =>
	Effect.gen(function* () {
		const signals = pageSignals();
		expect(signals?.hidden).toBe(document.hidden);
		let woke = 0;
		const wake = () => {
			woke++;
		};
		signals?.addEventListener('visibilitychange', wake);
		signals?.addEventListener('online', wake);
		document.dispatchEvent(new Event('visibilitychange'));
		window.dispatchEvent(new Event('online'));
		signals?.removeEventListener?.('visibilitychange', wake);
		signals?.removeEventListener?.('online', wake);
		document.dispatchEvent(new Event('visibilitychange'));
		window.dispatchEvent(new Event('online'));
		expect(woke).toBe(2);
	})
);

it.live('two shared sources on one page hold one EventSource and both hear its frames', () =>
	Effect.gen(function* () {
		expect(shareable()).toBe(true);
		let opened = 0;
		const open = () => {
			opened++;
			return new EventSource(PATHS.live);
		};
		const [first, second] = yield* Effect.all(
			[
				liveStream(() => sharedSource(PATHS.live, open)).pipe(Stream.take(2), Stream.runCollect),
				liveStream(() => sharedSource(PATHS.live, open)).pipe(Stream.take(2), Stream.runCollect)
			],
			{ concurrency: 'unbounded' }
		).pipe(Effect.timeout('5 seconds'));
		expect(opened).toBe(1);
		expect(first).toEqual(second);
		expect(first[0]).toEqual({ t: 'hello', conn: 'browser', v: 0 });
	})
);
