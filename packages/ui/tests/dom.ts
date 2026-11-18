import { icons as lucide } from '@iconify-json/lucide/index.js';
import { addCollection } from '@iconify/svelte/dist/functions';
import { Predicate } from 'effect';
import { afterEach, onTestFinished } from 'vitest';

// Populate Iconify's native cache so DOM fixtures do not leave CDN requests at teardown.
addCollection(lucide);

afterEach(() => {
	document.body.replaceChildren();
});

/** Lays the test out at a phone's width (happy-dom's viewport), back to its default 1024 px when the test ends. */
export function phoneWidth() {
	const api: unknown = Reflect.get(window, 'happyDOM');
	if (!Predicate.hasProperty(api, 'setViewport') || !Predicate.isFunction(api.setViewport))
		throw new Error('A phone width needs happy-dom.');
	const set = api.setViewport.bind(api);
	set({ width: 375 });
	onTestFinished(() => set({ width: 1024 }));
}
