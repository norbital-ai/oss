import { required, textOf } from './view-fixture.ts';
import { element } from './elements.ts';
import { Effect } from 'effect';
import './dom.ts';
import assert from 'node:assert/strict';
import { it, afterEach } from '@effect/vitest';
import { vi } from 'vitest';
import { viewFixture, browser, type ReadOptions } from './view-fixture.ts';
import type { TableProps, TableSource } from '../src/table/Table.svelte';
import type { Value } from '@norbital-ai/std/kind';
const { createRawSnippet, flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const { default: Table } = await import('../src/table/Table.svelte');
const mounted: (() => Promise<void>)[] = [];
const settle = async () => {
	for (let i = 0; i < 3; i++) {
		flushSync();
		await tick();
		await new Promise((r) => setTimeout(r, 0));
	}
	flushSync();
};
afterEach(async () => {
	for (const close of mounted.splice(0).reverse()) await close();
	document.body.replaceChildren();
	localStorage.clear();
});
async function show(
	rows: TableSource,
	columns: TableProps['columns'] = ['name'],
	onOpen?: TableProps['onOpen']
) {
	const calls: Value[] = [];
	const { bolt } = await viewFixture();
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, {
		target,
		props: {
			bolt,
			catalog: {},
			part: 'table',
			view: Table,
			props: {
				of: rows,
				columns,
				...(onOpen === undefined ? {} : { onOpen }),
				toolbar: {
					title: false,
					search: false,
					filter: false,
					export: false,
					new: false,
					actions: [
						{
							icon: 'lucide:download',
							name: 'Export selected',
							requiresSelection: true,
							run: (ids) => void calls.push(ids)
						}
					]
				}
			}
		}
	});
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	await settle();
	return { target, calls };
}
const button = (text: string) =>
	[...document.querySelectorAll<HTMLButtonElement>('button')].find(
		(b) => textOf(b).includes(text) || b.getAttribute('aria-label') === text
	);
async function menu() {
	element<HTMLButtonElement>(document, '[data-view-actions]').click();
	await settle();
}

it.live(
	'local record projections select stable IDs and pass only the selection to a callback',
	() =>
		Effect.gen(function* () {
			const { target, calls } = yield* browser(() =>
				show([
					{ id: 'run-a', name: 'January' },
					{ id: 'run-b', name: 'February' }
				])
			);
			assert.equal(
				target.querySelectorAll<HTMLInputElement>('tbody input[type=checkbox]').length,
				2
			);
			yield* browser(() => menu());
			assert.equal(required(button('Export selected')).disabled, true);
			element<HTMLButtonElement>(document, '[data-view-actions]').click();
			yield* browser(() => settle());
			const box = required(
				target.querySelectorAll<HTMLInputElement>('tbody input[type=checkbox]')[1]
			);
			box.click();
			yield* browser(() => settle());
			yield* browser(() => menu());
			assert.equal(required(button('Export selected')).disabled, false);
			required(button('Export selected')).click();
			yield* browser(() => settle());
			assert.deepEqual(calls, [['run-b']]);
		})
);

it.live('select all uses record IDs rather than local row positions', () =>
	Effect.gen(function* () {
		const { target, calls } = yield* browser(() =>
			show([
				{ id: 'run-a', name: 'January' },
				{ id: 'run-b', name: 'February' }
			])
		);
		element<HTMLInputElement>(target, 'thead input[type=checkbox]').click();
		yield* browser(() => settle());
		yield* browser(() => menu());
		required(button('Export selected')).click();
		yield* browser(() => settle());
		assert.deepEqual(calls, [['run-a', 'run-b']]);
	})
);

it.live(
	'controlled server pages retain supplied rows and order while default local views use URL filters',
	() =>
		Effect.gen(function* () {
			const rows = [
				{ id: 'b', name: 'Beta' },
				{ id: 'a', name: 'Alpha' }
			];
			const { bolt } = yield* browser(() => viewFixture());
			const footer = createRawSnippet(() => ({
				render: () => '<span data-provided-footer>Previous page</span>'
			}));
			for (const [key, value, expected] of [
				['q', 'Alpha', ['Alpha']],
				['q', 'no matching event', []],
				['where', '{"name":{"eq":"Alpha"}}', ['Alpha']],
				['order', 'name:asc', ['Alpha', 'Beta']]
			] as const) {
				for (const controlled of [false, true]) {
					const params = new URLSearchParams({
						[`server-page.${key}`]: value,
						'elsewhere.q': 'keep'
					});
					history.replaceState(null, '', `/?${params}`);
					const target = document.body.appendChild(document.createElement('div'));
					const app = mount(Harness, {
						target,
						props: {
							bolt,
							catalog: {},
							part: 'table',
							view: Table,
							props: {
								of: rows,
								columns: ['name'],
								key: 'server-page',
								toolbar: false,
								controlled,
								footer
							}
						}
					});
					try {
						yield* browser(() => settle());
						assert.deepEqual(
							[...target.querySelectorAll('tbody tr')].map((row) => textOf(row).trim()),
							controlled ? ['Beta', 'Alpha'] : expected
						);
						if (controlled) assert.equal(location.search, `?${params}`);
						assert.ok(target.querySelector('[data-table-footer] [data-provided-footer]'));
					} finally {
						yield* browser(() => unmount(app));
						target.remove();
					}
				}
			}
			history.replaceState(null, '', '/');
		})
);

for (const [label, rows] of [
	['missing IDs', [{ name: 'January' }]],
	['blank IDs', [{ id: ' ', name: 'January' }]]
] as const)
	it.live(`local rows with ${label} cannot manufacture an action selection`, () =>
		Effect.gen(function* () {
			const { target, calls } = yield* browser(() => show(rows));
			assert.equal(
				target.querySelectorAll<HTMLInputElement>('tbody input[type=checkbox]').length,
				0
			);
			yield* browser(() => menu());
			assert.equal(required(button('Export selected')).disabled, true);
			assert.deepEqual(calls, []);
		})
	);

it.live('a read request source shows its root and reads exactly the request it was given', () =>
	Effect.gen(function* () {
		const calls: { model: string; options: ReadOptions }[] = [];
		const { bolt } = yield* browser(() =>
			viewFixture({
				read: (model, options) => {
					calls.push({ model, options });
					return { rows: [{ id: 's1', name: 'Resin A' }], next: null };
				}
			})
		);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: {
				bolt,
				catalog: { stock: { label: ['name'], fields: { name: { kind: 'text' } } } },
				part: 'table',
				view: Table,
				props: {
					of: bolt.query({ stock: { where: { warehouse: { eq: 'main' } } } }),
					columns: ['name'],
					toolbar: { new: false }
				}
			}
		});
		mounted.push(async () => {
			await unmount(app);
			target.remove();
		});
		yield* browser(() =>
			vi.waitFor(async () => {
				flushSync();
				await tick();
				assert.equal(textOf(target).includes('Resin A'), true);
			})
		);
		// no page options are added to an authored read
		assert.deepEqual(required(calls[0]), {
			model: 'stock',
			options: { where: { warehouse: { eq: 'main' } } }
		});
	})
);

it.live('phone cards reveal extra report values without opening the row', () =>
	Effect.gen(function* () {
		const opened: Value[] = [];
		const { target } = yield* browser(() =>
			show(
				[
					{
						name: 'Sales',
						reference: 'INV-1',
						date: '2026-10-11',
						partner: 'Customer',
						sku: 'Resin A',
						net: '6.80',
						tax: '0.72'
					}
				],
				['name', 'reference', 'date', 'partner', 'sku', 'net', 'tax'],
				(row) => opened.push(row)
			)
		);
		const extra = element<HTMLDetailsElement>(target, '[data-table-list] [data-row-extra-fields]');
		assert.ok(extra);
		assert.equal(extra.open, false);
		element<HTMLElement>(extra, 'summary').click();
		yield* browser(() => settle());
		assert.equal(extra.open, true);
		assert.ok(textOf(extra).includes('6.80'));
		assert.ok(textOf(extra).includes('0.72'));
		assert.deepEqual(opened, []);
		element<HTMLElement>(extra, 'summary').click();
		yield* browser(() => settle());
		assert.equal(extra.open, false);
	})
);
