// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import './dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const { flushSync, mount, unmount } = await import('svelte');
const { default: Input } = await import('../src/primitives/input/input.svelte');

test('a file input mounts without binding value and reports its files', () => {
	const target = document.createElement('div');
	document.body.append(target);
	let seen;
	const app = mount(Input, { target, props: { type: 'file', onFiles: (files) => (seen = files) } });
	flushSync();
	const input = target.querySelector('input[type=file]');
	assert.ok(input);
	input.dispatchEvent(new Event('change', { bubbles: true }));
	flushSync();
	assert.equal(seen, input.files);
	unmount(app); target.remove();
});
