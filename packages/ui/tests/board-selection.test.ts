import './dom.ts';
import assert from 'node:assert/strict';
import { afterEach, it } from '@effect/vitest';
import { Effect } from 'effect';
import { vi } from 'vitest';
import type { Value } from '@norbital-ai/std/kind';
import type { KindsHost } from '../src/kinds/context.ts';
import type { BoardProps } from '../src/board/Board.svelte';
import type { Row } from '../src/model/types.ts';
import type { ViewBolt } from '../src/client/contract.ts';
import type { ToolbarItem } from '../src/model/ViewToolbar.svelte';
import { fromWhere, matches } from '../src/filter/filter.ts';
import { confirmDialog, element } from './elements.ts';

import {
	browser,
	everyRow,
	required,
	textOf,
	viewFixture,
	type ReadOptions,
	type ViewScript
} from './view-fixture.ts';

const { createRawSnippet, flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const { default: Board } = await import('../src/board/Board.svelte');
const { toasts } = await import('../src/toast/toast.svelte.ts');
const catalog = {
	jobs: {
		label: ['title'],
		fields: {
			title: { kind: 'text' },
			group: { kind: 'text' },
			status: { kind: 'enum', values: ['todo', 'done'] }
		},
		delete: true
	}
} satisfies NonNullable<KindsHost['catalog']>;
const rows = [
	{ id: 'a', title: 'In scope A', group: 'mine', status: 'todo' },
	{ id: 'b', title: 'In scope B', group: 'mine', status: 'todo' },
	{ id: 'c', title: 'In scope C', group: 'mine', status: 'done' }
];
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
	history.replaceState(null, '', '/');
	toasts.splice(0);
	vi.restoreAllMocks();
});

function filtered(input: readonly Row[], options: ReadOptions) {
	const nodes = fromWhere(catalog, 'jobs', options.where ?? {});
	assert.ok(nodes, 'the scripted read receives a valid model scope');
	return input.filter((row) => nodes.every((node) => matches(row, node)));
}
function page(input: readonly Row[], options: ReadOptions) {
	const matching = filtered(input, options);
	if (everyRow(options)) return { rows: matching.map((row) => ({ id: row.id })), next: null };
	const limit = options.limit ?? 25;
	return { rows: matching.slice(0, limit), next: matching.length > limit ? 'next' : null };
}
async function show({
	input = rows,
	script = {},
	toolbar,
	actions,
	card = ['title'],
	lanes,
	where,
	initialFilter,
	exposure = catalog
}: {
	input?: readonly Row[];
	script?: Partial<ViewScript>;
	toolbar?: BoardProps['toolbar'];
	actions?: (bolt: ViewBolt) => readonly ToolbarItem[];
	card?: BoardProps['card'];
	lanes?: BoardProps['lanes'];
	where?: BoardProps['where'];
	initialFilter?: BoardProps['initialFilter'];
	exposure?: NonNullable<KindsHost['catalog']>;
} = {}) {
	const reads: ReadOptions[] = [];
	const acts: { callable: string; input: Parameters<ViewScript['act']>[1] }[] = [];
	const fixture = await viewFixture({
		...script,
		read: (model, options) => {
			assert.equal(model, 'jobs');
			reads.push(options);
			return script.read?.(model, options) ?? page(input, options);
		},
		aggregate: (model, options) => {
			if (script.aggregate !== undefined) return script.aggregate(model, options);
			const matching = filtered(input, options);
			return ['todo', 'done'].map((status) => ({
				key: { status },
				count: matching.filter((row) => row.status === status).length
			}));
		},
		act: (callable, input, options) => {
			acts.push({ callable, input });
			return (
				script.act?.(callable, input, options) ?? {
					kind: 'committed',
					output: null,
					records: []
				}
			);
		}
	});
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(Harness, {
		target,
		props: {
			bolt: fixture.bolt,
			catalog: exposure,
			part: 'board',
			view: Board,
			props: {
				of: 'jobs',
				by: 'status',
				card,
				...(lanes === undefined ? {} : { lanes }),
				pageSize: 1,
				...(where === undefined ? {} : { where }),
				...(initialFilter === undefined ? {} : { initialFilter }),
				toolbar:
					toolbar === false
						? false
						: {
								title: false,
								search: false,
								filter: false,
								export: false,
								new: false,
								...toolbar,
								...(actions === undefined ? {} : { actions: actions(fixture.bolt) })
							}
			}
		}
	});
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	await vi.waitFor(async () => {
		flushSync();
		await tick();
		const rendered = [...target.querySelectorAll<HTMLElement>('[data-lane]')];
		assert.ok(rendered.length > 0, 'the board has loaded its lanes');
		for (const lane of rendered)
			assert.ok(
				lane.querySelector('[data-board-card], [data-lane-empty]'),
				`lane ${lane.dataset['lane']} has loaded its first page`
			);
		const selectPage = target.querySelector<HTMLButtonElement>('[data-select-page]');
		if (selectPage !== null) assert.equal(selectPage.disabled, false);
	});
	return { target, app, reads, acts };
}
const select = (target: ParentNode, id: string) =>
	element<HTMLButtonElement>(target, `[data-select-row="${id}"]`);
const card = (target: ParentNode, id: string) =>
	element<HTMLElement>(target, `[data-board-card="${id}"]`);
const menuRow = (key: string) =>
	element<HTMLElement>(document, `[data-view-menu] [data-menu-item="${key}"]`);
async function openMenu(target: ParentNode) {
	if (document.querySelector('[data-view-menu]') === null) {
		element<HTMLButtonElement>(target, '[data-view-actions]').click();
		await settle();
	}
}
async function press(key: string) {
	element<HTMLButtonElement>(menuRow(key), 'button').click();
	await settle();
}

it.live(
	'cards selected across lanes and later pages reach the actual bulk update as stable IDs',
	() =>
		Effect.gen(function* () {
			const { target, acts } = yield* browser(() =>
				show({
					actions: (bolt) => [
						{
							icon: 'lucide:check',
							name: 'Mark reviewed',
							requiresSelection: true,
							run: (ids) =>
								bolt.act(
									'jobs.update',
									ids.map((target) => ({ target, set: { reviewed: true } }))
								)
						}
					]
				})
			);
			select(target, 'a').click();
			select(target, 'c').click();
			element<HTMLButtonElement>(target, '[data-lane=\'"todo"\'] [data-lane-more]').click();
			yield* browser(settle);
			assert.equal(select(target, 'a').getAttribute('aria-checked'), 'true');
			select(target, 'b').click();
			yield* browser(settle);
			assert.equal(textOf(element(target, '[data-selected-count]')), '3 selected');
			yield* browser(() => openMenu(target));
			yield* browser(() => press('item:Mark reviewed'));
			assert.deepEqual(acts, [
				{
					callable: 'jobs.update',
					input: ['a', 'c', 'b'].map((target) => ({ target, set: { reviewed: true } }))
				}
			]);
			assert.equal(target.querySelector('[data-selected-count]'), null);
			assert.equal(select(target, 'a').getAttribute('aria-checked'), 'false');
		})
);

it.live(
	'delete cancellation and refusal retain cards; a committed delete clears the selection',
	() =>
		Effect.gen(function* () {
			let refuse = true;
			const confirmations: string[] = [];
			// the in-app confirmation (never `window.confirm`, which WebViews suppress): its title, then the answer
			const answer = async (accept: boolean) => {
				await vi.waitFor(() => assert.ok(confirmDialog()));
				const asked = confirmDialog()!;
				confirmations.push(asked.title);
				asked.answer(accept);
				await settle();
			};
			const { target, acts } = yield* browser(() =>
				show({
					toolbar: { delete: true },
					script: {
						act: () =>
							refuse
								? { kind: 'refused', code: 'forbidden', message: 'Deletion is locked' }
								: { kind: 'committed', output: null, records: [] }
					}
				})
			);
			yield* browser(() => openMenu(target));
			assert.equal(element<HTMLButtonElement>(menuRow('delete'), 'button').disabled, true);
			element<HTMLButtonElement>(target, '[data-view-actions]').click();
			select(target, 'c').click();
			yield* browser(settle);
			yield* browser(() => openMenu(target));
			yield* browser(() => press('delete'));
			yield* browser(() => answer(false));
			assert.deepEqual(acts, []);
			assert.equal(select(target, 'c').getAttribute('aria-checked'), 'true');
			yield* browser(() => openMenu(target));
			yield* browser(() => press('delete'));
			yield* browser(() => answer(true));
			yield* browser(() => openMenu(target));
			assert.equal(menuRow('delete').dataset.status, 'failed');
			assert.equal(
				textOf(element(menuRow('delete'), '[data-menu-error]')),
				'0 deleted, 1 kept: Deletion is locked'
			);
			assert.equal(select(target, 'c').getAttribute('aria-checked'), 'true');
			refuse = false;
			yield* browser(() => press('delete'));
			yield* browser(() => answer(true));
			assert.deepEqual(acts, [
				{ callable: 'jobs.delete', input: [{ target: 'c' }] },
				{ callable: 'jobs.delete', input: [{ target: 'c' }] }
			]);
			assert.deepEqual(confirmations, [
				'Delete 1 records?',
				'Delete 1 records?',
				'Delete 1 records?'
			]);
			assert.equal(target.querySelector('[data-selected-count]'), null);
			assert.equal(select(target, 'c').getAttribute('aria-checked'), 'false');
		})
);

it.live('select loaded and all matching preserve author and viewer scope across lanes', () =>
	Effect.gen(function* () {
		const picked: string[][] = [];
		const { target, app, reads } = yield* browser(() =>
			show({
				input: [
					...rows,
					{ id: 'hidden', title: 'Other title', group: 'mine', status: 'done' },
					{ id: 'outside', title: 'In scope outside', group: 'theirs', status: 'todo' }
				],
				where: { group: { eq: 'mine' } },
				initialFilter: { title: { like: '%In%scope%' } },
				actions: () => [
					{
						icon: 'lucide:download',
						name: 'Use selection',
						requiresSelection: true,
						run: (ids) => void picked.push(ids)
					}
				]
			})
		);
		element<HTMLButtonElement>(target, '[data-select-page]').click();
		yield* browser(settle);
		assert.equal(textOf(element(target, '[data-selected-count]')), '2 selected');
		assert.equal(select(target, 'a').getAttribute('aria-checked'), 'true');
		assert.equal(select(target, 'c').getAttribute('aria-checked'), 'true');
		const matching = element<HTMLButtonElement>(target, '[data-select-matching]');
		assert.match(textOf(matching), /Select all 3 matching/);
		matching.click();
		yield* browser(settle);
		const all = required(reads.findLast(everyRow));
		assert.deepEqual(all.fields, []);
		assert.deepEqual(all.where, {
			and: [{ group: { eq: 'mine' } }, { title: { like: '%In%scope%' } }]
		});
		assert.equal(all.search, undefined);
		assert.equal(textOf(element(target, '[data-selected-count]')), '3 selected');
		yield* browser(() => openMenu(target));
		yield* browser(() => press('item:Use selection'));
		assert.deepEqual(required(picked[0]).toSorted(), ['a', 'b', 'c']);
		app.setBoardScope({ group: { eq: 'theirs' } });
		yield* browser(settle);
		assert.equal(target.querySelector('[data-selected-count]'), null);
		assert.equal(select(target, 'outside').getAttribute('aria-checked'), 'false');
	})
);

it.live('all matching stays within the authored lanes instead of selecting hidden cards', () =>
	Effect.gen(function* () {
		const { target, reads } = yield* browser(() =>
			show({ toolbar: { select: true }, lanes: ['todo'] })
		);
		assert.equal(target.querySelector('[data-board-card=c]'), null);
		element<HTMLButtonElement>(target, '[data-select-page]').click();
		yield* browser(settle);
		element<HTMLButtonElement>(target, '[data-select-matching]').click();
		yield* browser(settle);
		assert.deepEqual(required(reads.findLast(everyRow)).where, {
			or: [{ status: { eq: 'todo' } }]
		});
		assert.equal(textOf(element(target, '[data-selected-count]')), '2 selected');
	})
);

it.live('a late select-all answer cannot undo a scope change', () =>
	Effect.gen(function* () {
		const requested = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<Value>();
		const { target, app } = yield* browser(() =>
			show({
				input: rows,
				where: { group: { eq: 'mine' } },
				toolbar: { select: true },
				script: {
					read: (_model, options) => {
						if (everyRow(options)) {
							requested.resolve();
							return answer.promise;
						}
						return page(rows, options);
					}
				}
			})
		);
		element<HTMLButtonElement>(target, '[data-select-page]').click();
		yield* browser(settle);
		element<HTMLButtonElement>(target, '[data-select-matching]').click();
		yield* browser(() => requested.promise);
		app.setBoardScope({ group: { eq: 'theirs' } });
		yield* browser(settle);
		answer.resolve({ rows: [{ id: 'b' }], next: null });
		yield* browser(settle);
		assert.equal(target.querySelector('[data-selected-count]'), null);
		assert.deepEqual([...target.querySelectorAll('[data-select-row][aria-checked=true]')], []);
	})
);

it.live('selection and custom-card controls keep their own click, keyboard and drag events', () =>
	Effect.gen(function* () {
		const custom = createRawSnippet<[{ row: Row }]>((value) => ({
			render: () => `<button type="button" data-custom-card>Inspect ${value().row.id}</button>`
		}));
		const { target, acts } = yield* browser(() =>
			show({ toolbar: { select: true }, card: custom })
		);
		const checkbox = select(target, 'a');
		assert.equal(checkbox.getAttribute('role'), 'checkbox');
		assert.ok(checkbox.getAttribute('aria-label'));
		element<HTMLButtonElement>(card(target, 'a'), '[data-custom-card]').click();
		checkbox.click();
		yield* browser(settle);
		assert.equal(location.search, '');
		assert.equal(checkbox.getAttribute('aria-checked'), 'true');
		checkbox.dispatchEvent(
			new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
		);
		yield* browser(settle);
		assert.equal(checkbox.getAttribute('aria-checked'), 'false');
		checkbox.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
		);
		checkbox.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }));
		element<HTMLElement>(target, '[data-lane=\'"done"\']').dispatchEvent(
			new Event('dragover', { bubbles: true, cancelable: true })
		);
		yield* browser(settle);
		assert.equal(target.querySelector('[data-drop-placeholder]'), null);
		assert.equal(location.search, '');
		assert.deepEqual(acts, []);
		card(target, 'a').dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
		);
		assert.equal(new URLSearchParams(location.search).get('record'), 'jobs/a');
	})
);

it.live('a read-only catalogue cannot offer deletion even when the view requests it', () =>
	Effect.gen(function* () {
		const { delete: _delete, ...readonlyJobs } = catalog.jobs;
		const { target, acts } = yield* browser(() =>
			show({ toolbar: { delete: true }, exposure: { jobs: readonlyJobs } })
		);
		assert.equal(target.querySelector('[data-view-actions]'), null);
		assert.equal(target.querySelector('[data-selection]'), null);
		assert.equal(target.querySelector('[data-select-row]'), null);
		assert.equal(document.querySelector('[data-menu-item=delete]'), null);
		assert.deepEqual(acts, []);
	})
);
