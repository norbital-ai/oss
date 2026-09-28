// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import './dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');

test('a failed picker read does not claim there are no options', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: {
		bolt: { read: () => Promise.reject(new Error('connection lost')) },
		catalog: { companies: { label: ['name'], fields: { name: { kind: 'text' } } } },
		part: 'picker', props: { of: 'companies', value: null, onChange: () => {} }
	} });
	flushSync();
	target.querySelector('[role=combobox]').click();
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 10));
	flushSync();
	assert.match(document.querySelector('[role=listbox]').textContent, /Could not load options/);
	unmount(app); target.remove();
});
