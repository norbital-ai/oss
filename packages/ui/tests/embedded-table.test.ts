import './dom.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { browser } from './view-fixture.ts';
import { mount, flushSync, tick, unmount } from 'svelte';
import Harness from './embedded-table-harness.svelte';

it.live('embedded controlled rows reuse the collection grid without a shell or runtime', () =>
	browser(async () => {
		const target = document.body.appendChild(document.createElement('div'));
		const changes: { id: string; name: string; paid: boolean }[][] = [];
		const app = mount(Harness, { target, props: { changed: (next) => changes.push(next) } });
		try {
			flushSync();
			await tick();
			assert.ok(target.querySelector('[data-view="table"][data-embedded="true"]'));
			assert.equal(target.querySelectorAll('thead th').length, 2);
			assert.equal(target.querySelectorAll('[data-column-resize]').length, 2);
			assert.equal(target.querySelectorAll('th[draggable="true"]').length, 2);
			assert.equal(target.querySelectorAll('[data-table-footer],[data-row-actions]').length, 0);
			assert.equal(target.querySelectorAll('tbody tr.paid-row').length, 1);
			const name = target.querySelector<HTMLElement>('th[data-column="name"]');
			const paid = target.querySelector<HTMLElement>('th[data-column="paid"]');
			assert.ok(name && paid);
			name.dispatchEvent(new Event('dragstart', { bubbles: true }));
			paid.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
			flushSync();
			await tick();
			assert.deepEqual(
				[...target.querySelectorAll<HTMLElement>('thead th')].map(
					(column) => column.dataset.column
				),
				['paid', 'name']
			);
			const row = target.querySelector('tbody tr');
			assert.equal(
				row?.lastElementChild?.querySelector('[data-row-trailing] button')?.textContent,
				'Remove Annual leave'
			);

			const action = target.querySelector<HTMLButtonElement>('[data-row-trailing] button');
			assert.ok(action);
			action.click();
			flushSync();
			await tick();
			assert.deepEqual(changes, [[{ id: 'b', name: 'Care leave', paid: false }]]);
			assert.equal(target.querySelectorAll('tbody tr').length, 1);
		} finally {
			await unmount(app);
			target.remove();
			localStorage.clear();
		}
	})
);
