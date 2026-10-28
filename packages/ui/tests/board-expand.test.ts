import './dom.ts';
import assert from 'node:assert/strict';
import { afterEach, it } from '@effect/vitest';
import { Effect } from 'effect';
import { vi } from 'vitest';
import type { KindsHost } from '../src/kinds/context.ts';
import type { Row } from '../src/model/types.ts';
import { fromWhere, matches } from '../src/filter/filter.ts';
import { element } from './elements.ts';
import { browser, required, viewFixture, type ReadOptions } from './view-fixture.ts';

const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const { default: Board } = await import('../src/board/Board.svelte');

// An expanded lane: the lane's cards in a modal grid, searched within that lane only, closing back to its button.
const catalog = {
	jobs: {
		label: ['title'],
		search: ['title'],
		fields: {
			title: { kind: 'text' },
			group: { kind: 'text' },
			status: { kind: 'enum', values: ['todo', 'done'] }
		}
	}
} satisfies NonNullable<KindsHost['catalog']>;
const rows: readonly Row[] = [
	{ id: 't1', title: 'Pump alpha', group: 'mine', status: 'todo' },
	{ id: 'd1', title: 'Valve alpha', group: 'mine', status: 'done' },
	{ id: 'd2', title: 'Valve beta', group: 'mine', status: 'done' },
	{ id: 'd3', title: 'Meter alpha', group: 'mine', status: 'done' },
	{ id: 'x1', title: 'Hidden alpha', group: 'theirs', status: 'done' }
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
	history.replaceState(null, '', '/');
});

function filtered(options: ReadOptions) {
	const nodes = fromWhere(catalog, 'jobs', options.where ?? {});
	assert.ok(nodes, 'the scripted read receives a valid model scope');
	const text = typeof options.search === 'string' ? options.search.toLowerCase() : '';
	return rows.filter(
		(row) =>
			nodes.every((node) => matches(row, node)) && String(row['title']).toLowerCase().includes(text)
	);
}
async function show() {
	const reads: ReadOptions[] = [];
	const fixture = await viewFixture({
		read: (_model, options) => {
			reads.push(options);
			return { rows: filtered(options), next: null };
		},
		aggregate: (_model, options) =>
			['todo', 'done'].map((status) => ({
				key: { status },
				count: filtered(options).filter((row) => row['status'] === status).length
			}))
	});
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(Harness, {
		target,
		props: {
			bolt: fixture.bolt,
			catalog,
			part: 'board',
			view: Board,
			props: {
				of: 'jobs',
				by: 'status',
				card: ['title'],
				where: { group: { eq: 'mine' } },
				toolbar: { title: false, search: false, filter: false, export: false, new: false }
			}
		}
	});
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	await vi.waitFor(async () => {
		await settle();
		assert.ok(target.querySelector('[data-lane=\'"done"\'] [data-board-card]'));
	});
	return { target, reads };
}
const cardsIn = (root: ParentNode) =>
	[...root.querySelectorAll<HTMLElement>('[data-board-card]')].map((c) => c.dataset['boardCard']);
const dialog = () => document.querySelector<HTMLElement>('[data-lane-dialog]');

it.live('expand opens the lane in a modal, search narrows within it, closing returns focus', () =>
	Effect.gen(function* () {
		const { target, reads } = yield* browser(show);
		const expand = element<HTMLButtonElement>(target, '[data-lane-expand=\'"done"\']');
		assert.match(expand.getAttribute('aria-label') ?? '', /done/i);
		expand.focus();
		expand.click();
		yield* browser(() =>
			vi.waitFor(async () => {
				await settle();
				const open = dialog();
				assert.ok(open, 'the lane dialog is open');
				assert.equal(open.getAttribute('role'), 'dialog');
				assert.deepEqual(cardsIn(open), ['d1', 'd2', 'd3'], "that lane's cards, in scope");
				assert.ok(open.contains(document.activeElement), 'focus is inside the dialog');
			})
		);

		element<HTMLButtonElement>(required(dialog()), '[data-search-toggle]').click();
		yield* browser(settle);
		const box = element<HTMLInputElement>(document, '[data-search]');
		box.value = 'alpha';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		yield* browser(() =>
			vi.waitFor(async () => {
				await settle();
				assert.deepEqual(cardsIn(required(dialog())), ['d1', 'd3']);
			})
		);
		const searched = required(reads.findLast((options) => options.search === 'alpha'));
		assert.deepEqual(searched.where, {
			and: [{ group: { eq: 'mine' } }, { status: { eq: 'done' } }]
		});
		assert.deepEqual(
			cardsIn(element(target, '[data-lane=\'"done"\']')),
			['d1', 'd2', 'd3'],
			'the board lane keeps its own cards'
		);
		assert.deepEqual(cardsIn(element(target, '[data-lane=\'"todo"\']')), ['t1']);

		const escape = () =>
			required(document.activeElement).dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
			);
		// one Escape per layer: the search popover first, then the lane dialog
		escape();
		yield* browser(() =>
			vi.waitFor(async () => {
				await settle();
				assert.equal(document.querySelector('[data-search]'), null);
				assert.ok(dialog(), 'the dialog outlives its popover');
			})
		);
		escape();
		yield* browser(() =>
			vi.waitFor(async () => {
				await settle();
				assert.equal(dialog(), null, 'Escape closes the dialog');
				assert.equal(document.activeElement, expand, 'focus returns to the expand button');
			})
		);
		assert.equal(new URL(location.href).searchParams.get('jobs.lane.where'), null);
	})
);
