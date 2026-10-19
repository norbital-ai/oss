import './dom.ts';
import assert from 'node:assert/strict';
import { it as test } from '@effect/vitest';
import { Decimal } from '@norbital-ai/std/decimal';
import type { Value } from '../src/kinds/kind.ts';

const { mount, unmount, flushSync } = await import('svelte');
const { default: Harness } = await import('./json-schema-harness.svelte');

test('replacing a focused amount retains select-all when the stored value has trailing zeros', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const changes: Value[] = [];
	const app = mount(Harness, {
		target,
		props: {
			kind: { kind: 'money', currency: 'SGD', scale: 4 },
			host: { locale: 'en-SG', currency: 'SGD' },
			initial: Decimal.of('2.0000'),
			changed: (value: Value) => changes.push(value)
		}
	});
	try {
		flushSync();
		const input = target.querySelector('input');
		assert.ok(input);
		input.focus();
		input.select();
		flushSync();
		input.setRangeText('20', input.selectionStart ?? 0, input.selectionEnd ?? 0, 'end');
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		assert.equal(input.value, '20');
		assert.equal(String(changes[0]), '20');
	} finally {
		await unmount(app);
		target.remove();
	}
});
