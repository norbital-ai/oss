import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { it, vi } from '@effect/vitest';
import { browser, required, textOf, viewFixture } from './view-fixture.ts';
import type { MatrixProps } from '../src/matrix/Matrix.svelte';
import type { KindsHost } from '../src/kinds/context.ts';
import './dom.ts';

const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const catalog = {
	loans: { label: ['name'], fields: { name: { kind: 'text' } } },
	repayments: { label: ['amount'], fields: { amount: { kind: 'int' } } }
} satisfies NonNullable<KindsHost['catalog']>;
const props = {
	rows: 'loans',
	rowLabel: 'name',
	of: 'repayments',
	row: 'loan',
	col: 'day',
	cols: ['2026-10-20'],
	select: ['amount'],
	colWidth: 200
} satisfies MatrixProps;
const settle = async (target: HTMLElement) => {
	await vi.waitFor(async () => {
		flushSync();
		await tick();
		assert.match(textOf(required(target.querySelector('tbody'))), /Principal loan.*100/s);
	});
};

for (const toolbar of [undefined, false] as const)
	it.live(`Matrix keeps its cells and footer when toolbar is ${String(toolbar)}`, () =>
		Effect.gen(function* () {
			const { bolt } = yield* browser(() =>
				viewFixture({
					read: (collection) => ({
						rows:
							collection === 'loans'
								? [{ id: 'loan-1', name: 'Principal loan' }]
								: [{ id: 'repayment-1', loan: 'loan-1', day: '2026-10-20', amount: 100 }],
						next: null
					})
				})
			);
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, {
				target,
				props: {
					bolt,
					catalog,
					part: 'matrix',
					props: { ...props, ...(toolbar === undefined ? {} : { toolbar }) }
				}
			});
			try {
				yield* browser(() => settle(target));
				assert.equal(target.querySelector('[data-view-toolbar]'), null);
				assert.match(textOf(required(target.querySelector('tbody'))), /Principal loan.*100/s);
				assert.ok(target.querySelector('[data-matrix-footer]'));
			} finally {
				yield* browser(() => unmount(app));
				target.remove();
			}
		})
	);

it.live('Matrix renders one native toolbar with its title and clickable trailing icon', () =>
	Effect.gen(function* () {
		let clicked = 0;
		const { bolt } = yield* browser(() =>
			viewFixture({
				read: (collection) => ({
					rows:
						collection === 'loans'
							? [{ id: 'loan-1', name: 'Principal loan' }]
							: [{ id: 'repayment-1', loan: 'loan-1', day: '2026-10-20', amount: 100 }],
					next: null
				})
			})
		);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: {
				bolt,
				catalog,
				part: 'matrix',
				props: {
					...props,
					toolbar: {
						title: 'Repayment schedule',
						search: false,
						filter: false,
						actions: false,
						export: false,
						new: false
					}
				},
				onTrailing: () => clicked++
			}
		});
		try {
			yield* browser(() => settle(target));
			assert.equal(target.querySelectorAll('[data-view-toolbar]').length, 1);
			const toolbar = required(target.querySelector('[data-view-toolbar]'));
			assert.match(textOf(toolbar), /Repayment schedule/);
			assert.equal(toolbar.querySelectorAll('button').length, 1);
			const action = required(
				toolbar.querySelector<HTMLButtonElement>('[data-view-trailing] button')
			);
			assert.equal(action.getAttribute('aria-label'), 'Schedule details');
			assert.ok(action.querySelector('svg'));
			action.click();
			assert.equal(clicked, 1);
			assert.match(textOf(required(target.querySelector('tbody'))), /Principal loan.*100/s);
		} finally {
			yield* browser(() => unmount(app));
			target.remove();
		}
	})
);

it.live('Matrix renders editable column headers without replacing its amount cells', () =>
	Effect.gen(function* () {
		const chosen: import('../src/client/contract.js').Json[] = [];
		const { bolt } = yield* browser(() =>
			viewFixture({
				read: (collection) => ({
					rows:
						collection === 'loans'
							? [{ id: 'loan-1', name: 'Principal loan' }]
							: [{ id: 'repayment-1', loan: 'loan-1', day: '2026-10-20', amount: 100 }],
					next: null
				})
			})
		);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: {
				bolt,
				catalog,
				part: 'matrix',
				props,
				onColumn: (col) => chosen.push(col)
			}
		});
		try {
			yield* browser(() => settle(target));
			const date = required(target.querySelector<HTMLButtonElement>('thead button'));
			assert.equal(textOf(date), '2026-10-20');
			date.click();
			assert.deepEqual(chosen, ['2026-10-20']);
			assert.match(textOf(required(target.querySelector('tbody'))), /Principal loan.*100/s);
			assert.ok(target.querySelector('[data-matrix-footer]'));
		} finally {
			yield* browser(() => unmount(app));
			target.remove();
		}
	})
);
