import './dom.ts';
import assert from 'node:assert/strict';
import { afterEach, it } from '@effect/vitest';
import { Effect } from 'effect';
import { vi } from 'vitest';
import type { KindsHost } from '../src/kinds/context.ts';
import type { ToolbarItem } from '../src/model/ViewToolbar.svelte';
import { browser, required, textOf, viewFixture, type ViewScript } from './view-fixture.ts';
import { confirmDialog, element } from './elements.ts';

const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const { default: Table } = await import('../src/table/Table.svelte');
const { toasts } = await import('../src/toast/toast.svelte.ts');
const mounted: (() => Promise<void>)[] = [];
const settle = async () => {
	for (let i = 0; i < 3; i++) {
		flushSync();
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	flushSync();
};
afterEach(async () => {
	for (const close of mounted.splice(0).reverse()) await close();
	document.body.replaceChildren();
	localStorage.clear();
	toasts.splice(0);
});

const declared: NonNullable<KindsHost['catalog']> = {
	jobs: {
		label: ['name'],
		fields: { name: { kind: 'text' } },
		update: { columns: ['name'] },
		delete: true,
		syncs: { sheet: { kind: 'file', import: true, export: ['xlsx'] } }
	}
};
const bare: NonNullable<KindsHost['catalog']> = {
	jobs: { label: ['name'], fields: { name: { kind: 'text' } } }
};

async function show({
	catalog,
	act = () => ({ kind: 'committed', output: null, records: [] }),
	actions
}: {
	catalog: NonNullable<KindsHost['catalog']>;
	act?: ViewScript['act'];
	actions?: readonly ToolbarItem[];
}) {
	const acts: { callable: string; input: Parameters<ViewScript['act']>[1] }[] = [];
	const { bolt } = await viewFixture({
		read: () => ({
			rows: [
				{ id: 'job-a', name: 'A' },
				{ id: 'job-b', name: 'B' }
			],
			next: null
		}),
		aggregate: () => [{ count: 2 }],
		act: (callable, input, options) => {
			acts.push({ callable, input });
			return act(callable, input, options);
		}
	});
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(Harness, {
		target,
		props: {
			bolt,
			catalog,
			upload: (file: File) => Effect.succeed({ id: 'f1', name: file.name, mime: file.type }),
			part: 'table',
			view: Table,
			props: {
				of: 'jobs',
				columns: ['name'],
				toolbar: {
					title: false,
					search: false,
					filter: false,
					export: false,
					new: false,
					...(actions === undefined ? {} : { actions })
				}
			}
		}
	});
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	await vi.waitFor(() => {
		flushSync();
		element(target, '[data-table-wide] tbody tr:not([aria-hidden])');
	});
	return { target, acts };
}
const open = async (target: ParentNode) => {
	if (document.querySelector('[data-view-menu]') !== null) return;
	element<HTMLButtonElement>(target, '[data-view-actions]').click();
	await settle();
};
const keys = () =>
	[...document.querySelectorAll<HTMLElement>('[data-view-menu] [data-menu-item]')].map(
		(row) => row.dataset['menuItem']
	);
const row = (key: string) =>
	element<HTMLElement>(document, `[data-view-menu] [data-menu-item="${key}"]`);
const button = (key: string) => element<HTMLButtonElement>(row(key), 'button');
const selectAll = async (target: ParentNode) => {
	element<HTMLInputElement>(target, 'thead input[type=checkbox]').click();
	await settle();
};

it.live(
	'declared update, delete and file syncs appear; update and delete wait for a selection, import does not',
	() =>
		Effect.gen(function* () {
			const { target } = yield* browser(() => show({ catalog: declared }));
			yield* browser(() => open(target));
			assert.deepEqual(keys(), [
				'update',
				'delete',
				'import:sheet',
				'template:sheet',
				'export:sheet:xlsx'
			]);
			assert.ok(textOf(row('update')).includes('Update selected records'));
			assert.ok(textOf(row('delete')).includes('Delete selected records'));
			for (const key of ['update', 'delete']) {
				assert.equal(button(key).disabled, true);
				assert.ok(textOf(row(key)).includes('Select records first'));
			}
			for (const key of ['import:sheet', 'template:sheet', 'export:sheet:xlsx'])
				assert.equal(button(key).disabled, false);
			element<HTMLButtonElement>(target, '[data-view-actions]').click();
			yield* browser(() => selectAll(target));
			yield* browser(() => open(target));
			assert.equal(button('update').disabled, false);
			assert.equal(button('delete').disabled, false);
		})
);

it.live(
	'catalogue authority limits standard commands and page actions keep their selection rules',
	() =>
		Effect.gen(function* () {
			const ran: (readonly string[])[] = [];
			const { target } = yield* browser(() =>
				show({
					catalog: bare,
					actions: [
						{
							icon: 'lucide:play',
							name: 'Recalculate',
							run: (ids) => {
								ran.push(ids);
							}
						},
						{
							icon: 'lucide:check',
							name: 'Approve',
							requiresSelection: true,
							run: (ids) => {
								ran.push(ids);
							}
						}
					]
				})
			);
			yield* browser(() => open(target));
			assert.deepEqual(keys(), ['item:Recalculate', 'item:Approve']);
			assert.equal(button('item:Approve').disabled, true);
			assert.ok(textOf(row('item:Approve')).includes('Select records first'));
			button('item:Recalculate').click();
			yield* browser(settle);
			assert.deepEqual(ran, [[]]);
			yield* browser(() => selectAll(target));
			yield* browser(() => open(target));
			button('item:Approve').click();
			yield* browser(settle);
			assert.deepEqual(ran, [[], ['job-a', 'job-b']]);
		})
);

it.live('bulk delete confirms, deletes each record, and reports a partial refusal', () =>
	Effect.gen(function* () {
		const { target, acts } = yield* browser(() =>
			show({
				catalog: declared,
				act: (_callable, input) =>
					JSON.stringify(input) === JSON.stringify([{ target: 'job-b' }])
						? { kind: 'refused', code: 'forbidden', message: 'Job B is invoiced' }
						: { kind: 'committed', output: null, records: [] }
			})
		);
		yield* browser(() => selectAll(target));
		yield* browser(() => open(target));
		button('delete').click();
		yield* browser(settle);
		const asked = required(confirmDialog());
		assert.equal(asked.title, 'Delete 2 records?');
		assert.equal(asked.body, 'This cannot be undone.');
		asked.answer(true);
		yield* browser(settle);
		assert.deepEqual(acts, [
			{ callable: 'jobs.delete', input: [{ target: 'job-a' }] },
			{ callable: 'jobs.delete', input: [{ target: 'job-b' }] }
		]);
		assert.deepEqual(
			toasts.map((t) => [t.tone, t.text]),
			[['error', '1 deleted, 1 kept: Job B is invoiced']]
		);
	})
);
