import { element } from './elements.ts';
import { browser } from './view-fixture.ts';
import { Effect } from 'effect';
import './dom.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./local-table-edit-harness.svelte');
const settle = async () => {
	flushSync();
	await tick();
	flushSync();
};

for (const [name, params, shown] of [
	['sorted', new URLSearchParams({ 'local-edit.order': 'name:asc' }), 'Alpha'],
	['filtered', new URLSearchParams({ 'local-edit.where': '{"name":{"eq":"Alpha"}}' }), 'Alpha']
] as const)
	for (const operation of ['edit', 'remove'] as const)
		it.live(
			`${name} local table ${operation} targets the displayed record in the original array`,
			() =>
				Effect.gen(function* () {
					history.replaceState(null, '', `/?${params}`);
					const initial = [
						{ id: 'b', name: 'Beta', amount: 2 },
						{ id: 'a', name: 'Alpha', amount: 1 }
					];
					const changes: (typeof initial)[] = [];
					const target = document.body.appendChild(document.createElement('div'));
					const app = mount(Harness, {
						target,
						props: { initial, changed: (next: typeof initial) => changes.push(next) }
					});
					try {
						yield* browser(() => settle());
						const row = element<HTMLElement>(target, 'tbody tr');
						assert.ok(row);
						const inputs = row.querySelectorAll<HTMLInputElement>('input');
						assert.equal(inputs[0]?.value, shown);
						if (operation === 'edit') {
							const amount = inputs[1];
							assert.ok(amount);
							amount.value = '7';
							amount.dispatchEvent(new Event('change', { bubbles: true }));
							yield* browser(() => settle());
							assert.deepEqual(changes.at(-1), [
								{ id: 'b', name: 'Beta', amount: 2 },
								{ id: 'a', name: 'Alpha', amount: 7 }
							]);
						} else {
							const remove = element<HTMLButtonElement>(row, '[data-row-actions] button');
							assert.ok(remove instanceof HTMLButtonElement);
							remove.click();
							yield* browser(() => settle());
							assert.deepEqual(changes.at(-1), [{ id: 'b', name: 'Beta', amount: 2 }]);
						}
						assert.equal(changes.length, 1);
					} finally {
						yield* browser(() => unmount(app));
						target.remove();
						localStorage.clear();
						history.replaceState(null, '', '/');
					}
				})
		);
