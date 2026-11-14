import './dom.ts';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { it as test } from '@effect/vitest';
import { vi } from 'vitest';
import { element } from './elements.ts';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const { default: Picker } = await import('../src/kinds/picker.svelte');

test('a selected record uses the model CEL label', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(Harness, {
		target,
		props: {
			query: () =>
				Effect.succeed({
					companies: { rows: [{ id: 'c1', code: 'C7', name: 'Acme' }], next: null }
				}),
			catalog: {
				companies: {
					label: ['code', 'name'],
					record_label: "record.code + ' · ' + record.name",
					fields: { code: { kind: 'text' }, name: { kind: 'text' } }
				}
			},
			part: 'picker',
			view: Picker,
			props: { of: 'companies', value: 'c1', readonly: true, on_change: () => {} }
		}
	});
	try {
		await vi.waitFor(() => {
			flushSync();
			assert.match(target.textContent ?? '', /C7 · Acme/);
		});
	} finally {
		await unmount(app);
		target.remove();
	}
});

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
						code: 'connection_lost'
					})
				),
			catalog: {
				companies: {
					record_label: 'record.name',
					label: ['name'],
					fields: { name: { kind: 'text' } }
				}
			},
			part: 'picker',
			view: Picker,
			props: { of: 'companies', value: null, on_change: () => {} }
		}
	});
	try {
		flushSync();
		element(target, '[role=combobox]').click();
		await tick();
		await vi.waitFor(() => {
			flushSync();
			assert.match(element(document, '[role=listbox]').textContent ?? '', /Could not load options/);
		});
	} finally {
		await unmount(app);
		target.remove();
	}
});

test('a failed read of the selected record is not shown as not found', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(Harness, {
		target,
		props: {
			query: () =>
				Effect.fail(
					Object.assign(new Error('out of memory'), {
						_tag: 'ReadFailed' as const,
						code: 'internal'
					})
				),
			catalog: {
				companies: {
					record_label: 'record.name',
					label: ['name'],
					fields: { name: { kind: 'text' } }
				}
			},
			part: 'picker',
			view: Picker,
			props: { of: 'companies', value: 'c1', readonly: true, on_change: () => {} }
		}
	});
	try {
		await vi.waitFor(() => {
			flushSync();
			assert.match(target.textContent ?? '', /Could not load/);
		});
		assert.doesNotMatch(target.textContent ?? '', /Not found/);
	} finally {
		await unmount(app);
		target.remove();
	}
});
