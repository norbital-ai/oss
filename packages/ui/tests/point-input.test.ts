import './dom.ts';
import assert from 'node:assert/strict';
import { it as test } from '@effect/vitest';
import { element } from './elements.ts';
const { flushSync, mount, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');

test('a point shows a compact field and mounts search only when opened', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, {
		target,
		props: { catalog: {}, part: 'point', props: { value: null, onChange: () => {}, map: false } }
	});
	try {
		flushSync();
		assert.ok(target.querySelector('[data-point-picker]'));
		assert.equal(document.querySelector('[data-point-options]'), null);
		element(target, '[data-point-picker]').click();
		flushSync();
		assert.ok(document.querySelector('[data-point-options] input[role=combobox]'));
	} finally {
		await unmount(app);
		target.remove();
	}
});
