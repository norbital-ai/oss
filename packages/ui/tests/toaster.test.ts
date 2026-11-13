// The toaster: a description keeps its line breaks (an importer's problem list) and scrolls inside its toast.
import './dom.ts';
import assert from 'node:assert/strict';
import { it } from 'vitest';
import { element } from './elements.ts';

const { flushSync, mount, unmount } = await import('svelte');
const { default: Toaster } = await import('../src/toast/toaster.svelte');
const { toast, toasts } = await import('../src/toast/toast.svelte.ts');

it('a multi-line description renders as separate lines inside its own scroll', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(Toaster, { target });
	try {
		toast.error('Nothing was imported', { description: 'Row 2: name is required\nRow 5: amount is not a number' });
		flushSync();
		const description = element<HTMLElement>(target, '[data-toast-description]');
		assert.deepEqual((description.textContent ?? '').split('\n'), [
			'Row 2: name is required',
			'Row 5: amount is not a number'
		]);
		for (const kept of ['whitespace-pre-line', 'max-h-48', 'overflow-y-auto'])
			assert.ok(description.classList.contains(kept), kept);
	} finally {
		toasts.splice(0);
		await unmount(app);
		target.remove();
	}
});
