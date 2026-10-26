import './dom.ts';
import assert from 'node:assert/strict';
import { afterEach, it, vi } from '@effect/vitest';
import { SvelteMap } from 'svelte/reactivity';
import { browser } from './view-fixture.ts';
import { element } from './elements.ts';
import type { ImageProps } from '../src/primitives/image/image.svelte';

const { flushSync, mount, unmount } = await import('svelte');
const { default: Image } = await import('../src/primitives/image/image.svelte');
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
});
const show = (props: ImageProps) => {
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(Image, { target, props });
	disposals.push(async () => {
		await unmount(app);
		target.remove();
	});
	flushSync();
	return target;
};

it.live('an absent image source stays pending with native alt and no placeholder request', () =>
	browser(async () => {
		const target = show({
			alt: 'Floor plan being prepared'
		});
		const frame = element<HTMLElement>(target, '[data-image]');
		const image = element<HTMLImageElement>(frame, 'img');
		assert.equal(frame.dataset.state, 'pending');
		assert.equal(image.getAttribute('src'), null);
		assert.equal(image.getAttribute('alt'), 'Floor plan being prepared');
		assert.equal(image.getAttribute('loading'), 'lazy');
		assert.equal(image.getAttribute('decoding'), 'async');
	})
);

it.live(
	'native load and error events settle only the current responsive source and retain alt text',
	() =>
		browser(async () => {
			vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
			const sources = new SvelteMap([['src', '/first.png']]);
			const events: string[] = [];
			const target = show({
				get src() {
					return sources.get('src');
				},
				srcset: '/first.png 1x, /first-large.png 2x',
				sizes: '(min-width: 48rem) 20rem, 100vw',
				alt: 'Delivery photograph',
				onload: (event) => events.push(event.type),
				onerror: (event) => events.push(event.type)
			});
			const frame = element<HTMLElement>(target, '[data-image]');
			const first = element<HTMLImageElement>(frame, 'img');
			assert.equal(first.getAttribute('srcset'), '/first.png 1x, /first-large.png 2x');
			assert.equal(first.getAttribute('sizes'), '(min-width: 48rem) 20rem, 100vw');
			first.dispatchEvent(new Event('load'));
			flushSync();
			assert.equal(frame.dataset.state, 'loaded');
			assert.deepEqual(events, ['load']);
			sources.set('src', '/second.png');
			flushSync();
			const second = element<HTMLImageElement>(frame, 'img');
			assert.notEqual(second, first);
			assert.equal(frame.dataset.state, 'pending');
			first.dispatchEvent(new Event('error'));
			flushSync();
			assert.equal(frame.dataset.state, 'pending');
			second.dispatchEvent(new Event('error'));
			flushSync();
			assert.equal(frame.dataset.state, 'error');
			assert.equal(second.getAttribute('alt'), 'Delivery photograph');
			assert.equal(second.hidden, false);
			assert.equal(events.at(-1), 'error');
		})
);

it.live(
	'a cached image settles on mount without needing a repeated load event and accepts eager priority',
	() =>
		browser(async () => {
			vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
			vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(640);
			const target = show({
				src: '/cached.png',
				alt: 'Saved drawing',
				loading: 'eager',
				fetchpriority: 'high'
			});
			assert.equal(element<HTMLElement>(target, '[data-image]').dataset.state, 'loaded');
			const image = element<HTMLImageElement>(target, 'img');
			assert.equal(image.getAttribute('loading'), 'eager');
			assert.equal(image.getAttribute('fetchpriority'), 'high');
		})
);
