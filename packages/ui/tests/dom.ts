import { icons as lucide } from '@iconify-json/lucide/index.js';
import { addCollection } from '@iconify/svelte/dist/functions';
import { afterEach } from 'vitest';

// Populate Iconify's native cache so DOM fixtures do not leave CDN requests at teardown.
addCollection(lucide);

afterEach(() => {
	document.body.replaceChildren();
});
