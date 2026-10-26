import './dom.ts';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { it as test } from '@effect/vitest';
import { element } from './elements.ts';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');

test('a failed picker read does not claim there are no options', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, {
		target,
		props: {
			query: () =>
				Effect.fail(
					Object.assign(new Error('connection lost'), {
						_tag: 'ReadFailed' as const,
						code: 'connectionLost'
					})
				),
			catalog: { companies: { label: ['name'], fields: { name: { kind: 'text' } } } },
			part: 'picker',
			props: { of: 'companies', value: null, onChange: () => {} }
		}
	});
	try {
		flushSync();
		element(target, '[role=combobox]').click();
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 10));
		flushSync();
		assert.match(element(document, '[role=listbox]').textContent ?? '', /Could not load options/);
	} finally {
		await unmount(app);
		target.remove();
	}
});
