import { committed, single_act } from './act-envelope.ts';
import './dom.ts';
import assert from 'node:assert/strict';
import { afterEach, it } from '@effect/vitest';
import { Effect } from 'effect';
import { vi } from 'vitest';
import type { KindsHost } from '../src/kinds/context.ts';
import type { ToolbarItem } from '../src/model/ViewToolbar.svelte';
import { browser, required, textOf, viewFixture, type ViewScript } from './view-fixture.ts';
import { confirmDialog, element } from './elements.ts';
import type { ReadReply } from './scripted-bolt.ts';

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
		record_label: 'record.name',
		label: ['name'],
		fields: { name: { kind: 'text' } },
		update: { columns: ['name'] },
		delete: true,
		syncs: { sheet: { kind: 'file', import: true, export: ['xlsx'] } }
	}
};
const bare: NonNullable<KindsHost['catalog']> = {
	jobs: { record_label: 'record.name', label: ['name'], fields: { name: { kind: 'text' } } }
};

async function show({
	catalog,
	act = committed,
	actions,
	extra = {},
	readonly
}: {
	catalog: NonNullable<KindsHost['catalog']>;
	act?: ViewScript['act'];
	actions?: readonly ToolbarItem[];
	extra?: Partial<ViewScript>;
	readonly?: boolean;
}) {
	const acts: ReturnType<typeof single_act>[] = [];
	const { bolt } = await viewFixture({
		catalog,
		get: (_model, id) =>
			id === 'job-a'
				? { id, revision: 1, name: 'A' }
				: id === 'job-b'
					? { id, revision: 2, name: 'B' }
					: null,
		read: (_model, options) => ({
			rows: ['job-a', 'job-b'].map((id, index) => ({
				id,
				revision: index + 1,
				...(options.fields?.length === 0 ? {} : { name: index === 0 ? 'A' : 'B' })
			})),
			next: null
		}),
		aggregate: () => ({ count: 2 }),
		act: (body, key) => {
			const { callable, input } = single_act(body);
			acts.push({ callable, input });
			return act(body, key);
		},
		...extra
	});
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(Harness, {
		target,
		props: {
			bolt,
			catalog,
			...(readonly === undefined ? {} : { readonly }),
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
							requires_selection: true,
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
				act: (body) =>
					JSON.stringify(single_act(body).input) ===
					JSON.stringify([{ target: { id: 'job-b', revision: 2 } }])
						? { kind: 'refused', code: 'forbidden', message: 'Job B is invoiced' }
						: committed(body)
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
			{ callable: 'jobs.delete', input: [{ target: { id: 'job-a', revision: 1 } }] },
			{ callable: 'jobs.delete', input: [{ target: { id: 'job-b', revision: 2 } }] }
		]);
		assert.deepEqual(
			toasts.map((t) => [t.tone, t.text]),
			[['error', '1 deleted, 1 kept: Job B is invoiced']]
		);
	})
);

it.live(
	'one record reads "Delete 1 record?"; a delete held for approval says so instead of "cannot be undone"',
	() =>
		Effect.gen(function* () {
			const asks: (readonly string[])[] = [];
			const { target } = yield* browser(() =>
				show({
					catalog: declared,
					extra: {
						delete_verdict: (_model, ids) => {
							asks.push(ids);
							return 'approve';
						}
					}
				})
			);
			element<HTMLInputElement>(target, '[data-table-wide] tbody input[type=checkbox]').click();
			yield* browser(settle);
			yield* browser(() => open(target));
			button('delete').click();
			yield* browser(settle);
			const asked = yield* browser(() => vi.waitFor(() => required(confirmDialog())));
			assert.equal(asked.title, 'Delete 1 record?');
			assert.equal(
				asked.body,
				'This will ask for approval; the record stays until it is approved.'
			);
			assert.deepEqual(asks, [['job-a']], 'one read for the whole selection');
			asked.answer(false);
			yield* browser(settle);
		})
);

it.live('a row its held delete keeps is listed in place, marked pending deletion', () =>
	Effect.gen(function* () {
		const $approval = {
			request_id: 'r1',
			state: 'Pending',
			step: 0,
			steps: [{ name: 'Review', teams: ['reviewers'], users: [] }],
			requested_by: 'Ada',
			pending_delete: true
		};
		const { target } = yield* browser(() =>
			show({
				catalog: declared,
				extra: {
					read: (): ReadReply => ({
						rows: [
							{ id: 'job-a', revision: 1, name: 'A' },
							{ id: 'job-b', revision: 2, name: 'B', $approval }
						],
						next: null
					})
				}
			})
		);
		const held = element<HTMLElement>(target, '[data-table-wide] tbody tr[data-pending-delete]');
		assert.match(textOf(held), /B/);
		assert.match(held.title, /^Pending deletion · Requested by Ada/);
		// visible on the row itself, not only in its tooltip
		assert.equal(textOf(element<HTMLElement>(held, '[data-pending-delete-badge]')).trim(), 'Pending deletion');
		assert.equal(
			target.querySelectorAll('[data-table-wide] tbody tr[data-pending-delete]').length,
			1
		);
	})
);

it.live('the page size stays a control inside a readonly record view', () =>
	Effect.gen(function* () {
		const { target } = yield* browser(() => show({ catalog: declared, readonly: true }));
		const pager = element<HTMLElement>(target, '[data-pager]');
		assert.ok(pager.querySelector('[role=combobox]'), 'a trigger, not copyable text');
		assert.match(textOf(pager), /25 \/ page/);
	})
);
