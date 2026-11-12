import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { it, vi } from '@effect/vitest';
import { browser, required, textOf, viewFixture } from './view-fixture.ts';
import type { MatrixProps } from '../src/matrix/Matrix.svelte';
import type { KindsHost } from '../src/kinds/context.ts';
import { committed, single_act, type SentAct } from './act-envelope.ts';
import './dom.ts';

const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const { default: Matrix } = await import('../src/matrix/Matrix.svelte');
const { coarsePointer } = await import('../src/primitives/utils.ts');
const catalog = {
	loans: { record_label: 'record.name', label: ['name'], fields: { name: { kind: 'text' } } },
	repayments: {
		record_label: 'record.amount',
		label: ['amount'],
		fields: { amount: { kind: 'int' }, day: { kind: 'date' } },
		relations: { loan: { targets: ['loans'] } }
	}
} satisfies NonNullable<KindsHost['catalog']>;
const props = {
	rows: 'loans',
	row_label: 'name',
	of: 'repayments',
	row: 'loan',
	col: 'day',
	cols: ['2026-10-20'],
	select: ['amount'],
	col_width: 200
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
					catalog,
					read: (model) => ({
						rows:
							model === 'loans'
								? [{ id: 'loan-1', name: 'Principal loan' }]
								: [{ id: 'repayment-1', loan: 'loan-1', day: '2026-10-20', amount: 100, revision: 1 }],
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
					view: Matrix,
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
				catalog,
				read: (model) => ({
					rows:
						model === 'loans'
							? [{ id: 'loan-1', name: 'Principal loan' }]
							: [{ id: 'repayment-1', loan: 'loan-1', day: '2026-10-20', amount: 100, revision: 1 }],
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
				view: Matrix,
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

it.live('Matrix picks a cell on a plain tap under a coarse pointer', () =>
	Effect.gen(function* () {
		vi.spyOn(coarsePointer, 'current', 'get').mockReturnValue(true);
		const { bolt } = yield* browser(() =>
			viewFixture({
				catalog,
				read: (model) => ({
					rows:
						model === 'loans'
							? [{ id: 'loan-1', name: 'Principal loan' }]
							: [{ id: 'repayment-1', loan: 'loan-1', day: '2026-10-20', amount: 100, revision: 1 }],
					next: null
				})
			})
		);
		const target = document.body.appendChild(document.createElement('div'));
		const run = vi.fn();
		const app = mount(Harness, {
			target,
			props: {
				bolt,
				catalog,
				part: 'matrix',
				view: Matrix,
				props: { ...props, selection: [{ label: 'Approve', run }] }
			}
		});
		try {
			yield* browser(() => settle(target));
			const action = required(target.querySelector<HTMLButtonElement>('section > div button'));
			assert.equal(action.disabled, true);
			required(target.querySelector<HTMLElement>('tbody td')).click();
			flushSync();
			assert.equal(action.disabled, false);
			action.click();
			assert.deepEqual(run.mock.calls[0]?.[0], [{ row: 'loan-1', col: '2026-10-20' }]);
		} finally {
			yield* browser(() => unmount(app));
			target.remove();
		}
	})
);

it.live('Matrix moves an audited item at the revision it read', () =>
	Effect.gen(function* () {
		const sent: SentAct[] = [];
		const { bolt } = yield* browser(() =>
			viewFixture({
				catalog,
				read: (model) => ({
					rows:
						model === 'loans'
							? [{ id: 'loan-1', name: 'Principal loan' }]
							: [{ id: 'repayment-1', loan: 'loan-1', day: '2026-10-20', amount: 100, revision: 4 }],
					next: null
				}),
				act: (body, key) => {
					sent.push({ ...single_act(body), key });
					return committed(body);
				}
			})
		);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: { bolt, catalog, part: 'matrix', view: Matrix, props: { ...props, cols: ['2026-10-20', '2026-10-21'], move: true } }
		});
		try {
			yield* browser(() => settle(target));
			const drop = new Event('drop', { bubbles: true, cancelable: true });
			Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => 'repayment-1' } });
			required(target.querySelectorAll('tbody td')[1]).dispatchEvent(drop);
			yield* browser(() => vi.waitFor(() => assert.equal(sent.length, 1)));
			assert.deepEqual(sent[0]?.input, [
				{ target: { id: 'repayment-1', revision: 4 }, set: { loan: 'loan-1', day: '2026-10-21' } }
			]);
		} finally {
			yield* browser(() => unmount(app));
			target.remove();
		}
	})
);
