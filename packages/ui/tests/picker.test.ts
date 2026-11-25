import './dom.ts';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { it as test } from '@effect/vitest';
import { vi } from 'vitest';
import { element } from './elements.ts';
import { scriptedBolt } from './scripted-bolt.ts';
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
		assert.ok(target.querySelector('[data-ref="one"]'));
		assert.ok(target.querySelector('[data-icon="link"]'));
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
		assert.equal(target.querySelector('[data-ref="one"]'), null);
	} finally {
		await unmount(app);
		target.remove();
	}
});

test('readonly picker renders a relationship icon and opens the target record when clicked', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const before = location.href;
	const { bolt, runtime } = await scriptedBolt({ answer: () => ({}) });
	const app = mount(Harness, {
		target,
		props: {
			bolt,
			catalog: {
				sys_user: { label: ['name'], record_label: 'record.name', fields: { name: { kind: 'text' } } },
				companies: { label: ['name'], record_label: 'record.name', fields: { name: { kind: 'text' } } }
			},
			query: () =>
				Effect.succeed({
					sys_user: { rows: [{ id: 'u1', name: 'Ada Tan' }], next: null }
				}),
			part: 'picker',
			view: Picker,
			props: { of: 'sys_user', value: 'u1', readonly: true, on_change: () => {} }
		}
	});
	try {
		await vi.waitFor(() => {
			flushSync();
			assert.ok(target.querySelector('[data-ref="one"]'));
			assert.ok(target.querySelector('[data-icon="user"]'));
			assert.match(target.textContent ?? '', /Ada Tan/);
		});
		element<HTMLButtonElement>(target, '[data-ref-open="u1"]').click();
		assert.equal(new URL(location.href).searchParams.get('record'), 'sys_user/u1');
	} finally {
		history.replaceState(null, '', before);
		await unmount(app);
		await runtime.dispose();
		target.remove();
	}
});
