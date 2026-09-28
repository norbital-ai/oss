// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import './dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const { flushSync, mount, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');

test('a point shows a compact field and mounts search only when opened', () => {
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { bolt: {}, catalog: {}, part: 'point', props: { value: null, onChange: () => {}, map: false } } });
	flushSync();
	assert.ok(target.querySelector('[data-point-picker]'));
	assert.equal(document.querySelector('[data-point-options]'), null);
	target.querySelector('[data-point-picker]').click();
	flushSync();
	assert.ok(document.querySelector('[data-point-options] input[role=combobox]'));
	unmount(app); target.remove();
});
