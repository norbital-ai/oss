import './dom.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Effect, Stream } from 'effect';
import type { Live, LiveError } from '../src/client/contract.ts';
import { browser, streamSource } from './view-fixture.ts';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./live-harness.svelte');
const { reactive } = await import('./kit-state.svelte.js');
const settle = async () => {
	flushSync();
	await tick();
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	flushSync();
};

it.live('live adapter follows scope, clears stale values/errors and releases subscriptions', () =>
	Effect.gen(function* () {
		const first = streamSource<number, LiveError>(),
			second = streamSource<number, LiveError>();
		const state = reactive({ source: (): Live<number> | null => first.stream });
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, { target, props: state });
		const text = () => target.querySelector('output')?.textContent;
		try {
			yield* browser(settle);
			assert.equal(text(), 'loading:empty:');
			assert.equal(first.listeners.size, 1);
			first.emit(0);
			yield* browser(settle);
			assert.equal(text(), 'ready:0:');
			first.fail(Object.assign(new Error('No access'), { code: 'forbidden' }));
			yield* browser(settle);
			assert.equal(text(), 'noAccess:empty:No access');
			state.source = () => null;
			yield* browser(settle);
			assert.equal(first.listeners.size, 0);
			assert.equal(text(), 'empty:empty:');
			state.source = () => second.stream;
			yield* browser(settle);
			assert.equal(second.listeners.size, 1);
			assert.equal(text(), 'loading:empty:');
			first.emit(99);
			yield* browser(settle);
			assert.equal(text(), 'loading:empty:');
			second.emit(2);
			yield* browser(settle);
			assert.equal(text(), 'ready:2:');
		} finally {
			yield* browser(() => unmount(app));
			target.remove();
		}
		assert.equal(first.listeners.size, 0);
		assert.equal(second.listeners.size, 0);
	})
);

it.live('live emissions do not become reactive subscription dependencies', () =>
	Effect.gen(function* () {
		const snapshot = reactive({ current: 1 });
		let subscriptions = 0,
			releases = 0;
		const source = streamSource<number>();
		const live: Live<number> = Stream.unwrap(
			Effect.sync(() => {
				subscriptions++;
				return Stream.make(snapshot.current).pipe(
					Stream.concat(source.stream),
					Stream.ensuring(
						Effect.sync(() => {
							releases++;
						})
					)
				);
			})
		);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, { target, props: { source: () => live } });
		try {
			yield* browser(settle);
			snapshot.current = 2;
			source.emit(snapshot.current);
			yield* browser(settle);
			assert.equal(target.querySelector('output')?.textContent, 'ready:2:');
			assert.equal(subscriptions, 1);
			assert.equal(releases, 0);
		} finally {
			yield* browser(() => unmount(app));
			target.remove();
		}
		assert.equal(releases, 1);
	})
);
