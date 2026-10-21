// Kit gaps found migrating the 0.0.1 templates: Form's read-only mode, a toolbar item's per-selection disabled reason,
// the record row in a custom field's view, and representations loaded on first use.
import './dom.ts';
import assert from 'node:assert/strict';
import { it, afterEach } from '@effect/vitest';
import { Effect } from 'effect';
import { browser, required, textOf, viewFixture } from './view-fixture.ts';
import { element } from './elements.ts';
import type { KindsHost } from '../src/kinds/context.ts';
import type { PackagingPart, PackagingHarnessProps } from './packaging-harness.svelte';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./packaging-harness.svelte');
const { default: Renderer } = await import('./packaging-renderer.svelte');
const { default: Representation } = await import('./packaging-representation.svelte');

const catalog: NonNullable<KindsHost['catalog']> = {
	jobs: {
		label: ['title'],
		fields: {
			title: { kind: 'text' },
			crew: { kind: 'text', optional: true },
			sign: { kind: 'custom', of: 'sign', optional: true }
		},
		update: { columns: ['title', 'crew'] }
	}
};
const JOB = { id: 'j1', revision: 1, title: 'Paint', crew: 'B' };
const mounted: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const done of mounted.splice(0).reverse()) await done();
});
async function show(
	props: PackagingPart &
		Partial<Pick<PackagingHarnessProps, 'catalog' | 'customFields' | 'representations'>>
) {
	const { bolt } = await viewFixture({
		read: () => ({ rows: [JOB], next: null }),
		get: (_c, id) => (id === 'j1' ? JOB : null),
		aggregate: () => [{ count: 1 }],
		history: () => []
	});
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { bolt, catalog, ...props } });
	flushSync();
	for (let i = 0; i < 5; i++) {
		await tick();
		await new Promise((r) => setTimeout(r, 0));
	}
	let closed = false;
	const done = async () => {
		if (!closed) {
			closed = true;
			await unmount(app);
			target.remove();
		}
	};
	mounted.push(done);
	return { target, done };
}

it.live('a read-only Form shows every value as copyable text, no field chrome, no submit', () =>
	browser(async () => {
		const editable = await show({ part: 'form', props: { of: 'jobs', id: 'j1', record: JOB } });
		assert.equal(editable.target.querySelectorAll('button[type=submit]').length, 1);
		await editable.done();
		const view = await show({
			part: 'form',
			props: { of: 'jobs', id: 'j1', record: JOB, readonly: true }
		});
		assert.equal(view.target.querySelectorAll('button[type=submit]').length, 0); // counts, not nodes: a failing assert would inspect the DOM
		assert.equal(
			view.target.querySelectorAll('input, textarea, [role=combobox], [data-form-footer]').length,
			0
		);
		assert.equal(
			view.target
				.querySelector('[data-field=title][data-readonly]')
				?.textContent?.includes('Paint'),
			true
		);
		assert.equal(
			view.target.querySelector('[data-field=title] button')?.getAttribute('aria-label'),
			'Copy'
		);
		await view.done();
	})
);

const ROW = {
	id: 'r1',
	revision: 1,
	title: 'Paint',
	paid: true,
	grade: 'senior_staff',
	note: null,
	owner: 'j1'
};
const readable: NonNullable<KindsHost['catalog']> = {
	jobs: catalog.jobs,
	rows: {
		label: ['title'],
		fields: {
			title: { kind: 'text' },
			paid: { kind: 'bool' },
			grade: { kind: 'enum', values: ['senior_staff', 'junior'] },
			note: { kind: 'text', optional: true }
		},
		relations: { owner: { targets: ['jobs'] } }
	}
};

it.live(
	'an update the viewer cannot make is readonly by itself: enums by label, booleans Yes/No, refs by label, empty as a dash',
	() =>
		browser(async () => {
			const v = await show({
				part: 'form',
				catalog: readable,
				props: { of: 'rows', id: 'r1', record: ROW }
			});
			const text = (f: string) =>
				v.target.querySelector(`[data-field=${f}][data-readonly]`)?.textContent ?? '';
			assert.equal(v.target.querySelectorAll('input, button[type=submit]').length, 0);
			assert.ok(text('grade').includes('Senior staff'));
			assert.ok(text('paid').includes('Yes'));
			assert.ok(text('note').includes('—'));
			assert.ok(text('owner').includes('Paint') && !text('owner').includes('j1'));
			// no prop lifts the engine's readonly
			const lifted = await show({
				part: 'form',
				catalog: readable,
				props: { of: 'rows', id: 'r1', record: ROW, readonly: false }
			});
			assert.equal(lifted.target.querySelectorAll('input').length, 0);
			await v.done();
			await lifted.done();
		})
);

it.live('a disabled Form keeps its editors, muted and inert, with the submit disabled', () =>
	browser(async () => {
		const v = await show({
			part: 'form',
			props: { of: 'jobs', id: 'j1', record: JOB, disabled: true }
		});
		const inputs = [...v.target.querySelectorAll('input')];
		assert.ok(inputs.length > 0 && inputs.every((i) => i.disabled));
		assert.equal(element<HTMLButtonElement>(v.target, 'button[type=submit]').disabled, true);
		assert.equal(
			v.target.querySelectorAll(
				'[data-field=title][data-readonly], [data-field=crew][data-readonly]'
			).length,
			0
		);
		assert.ok(v.target.querySelector('[data-field=sign][data-readonly]')); // excluded from the update grant
		await v.done();
	})
);

it.live(
	"the form mode reaches every Field by context; a Field's readonly={false} never lifts it; a Fieldset reaches a bare input",
	() =>
		browser(async () => {
			const v = await show({
				part: 'controls',
				props: { record: JOB, readonly: true, override: false, group: 'readonly' }
			});
			assert.ok(v.target.querySelector('[data-field=title][data-readonly]'));
			assert.ok(v.target.querySelector('[data-field=crew][data-readonly]'));
			assert.equal(v.target.querySelectorAll('[data-field=crew] input').length, 0);
			assert.equal(v.target.querySelectorAll('[data-bare] input').length, 0);
			assert.ok(
				v.target.querySelector('[data-bare] [data-readonly]')?.textContent?.includes('bare')
			);
			await v.done();
			const off = await show({
				part: 'controls',
				props: { record: JOB, disabled: true, group: 'disabled' }
			});
			assert.equal(
				off.target.querySelector<HTMLInputElement>('[data-field=title] input')?.disabled,
				true
			);
			assert.equal(off.target.querySelector<HTMLInputElement>('[data-bare] input')?.disabled, true);
			await off.done();
		})
);

it.live('a toolbar item says why it cannot run over the current selection', () =>
	browser(async () => {
		const why = (ids: readonly string[]) => (ids.length === 0 ? 'Pick a job first' : null);
		const v = await show({
			part: 'table',
			props: {
				of: 'jobs',
				columns: ['title'],
				toolbar: {
					actions: [{ icon: 'lucide:x', name: 'Close', run: () => Effect.void, disabled: why }]
				}
			}
		});
		// the item lives in the toolbar's actions menu (portalled to the body)
		element<HTMLElement>(v.target, '[data-view-actions]').click();
		for (let i = 0; i < 3; i++) {
			flushSync();
			await tick();
		}
		const item = () =>
			element<HTMLButtonElement>(document, '[data-view-menu] button[aria-label="Close"]');
		assert.equal(item().disabled, true);
		assert.equal(item().getAttribute('title'), 'Pick a job first');
		const box = element<HTMLInputElement>(v.target, 'tbody input[type=checkbox]');
		box.checked = true;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		const button = item();
		assert.equal(button.disabled, false);
		assert.equal(button.getAttribute('title'), null);
		await v.done();
	})
);

it.live('a custom field renderer receives the record row beside its value', () =>
	browser(async () => {
		const v = await show({
			part: 'show',
			customFields: { sign: { shape: { kind: 'text' }, renderer: Renderer } },
			props: { kind: { kind: 'custom', of: 'sign' }, value: 'ok', name: 'sign', row: JOB }
		});
		assert.deepEqual(
			JSON.parse(required(element(v.target, '[data-renderer=show]').getAttribute('data-row'))),
			JOB
		);
		await v.done();
	})
);

it.live('a representation loads on first use, for a page-level RecordShell too', () =>
	browser(async () => {
		let loads = 0;
		const representations = { jobs: () => (loads++, Promise.resolve({ default: Representation })) };
		const v = await show({ part: 'record', representations, props: { of: 'jobs', id: 'j1' } });
		assert.equal(v.target.querySelector('[data-representation=view]')?.textContent, 'Paint');
		assert.equal(loads, 1);
		await v.done();
	})
);

it.live("a local array's boolean column is a check or a cross icon, not a glyph in text", () =>
	browser(async () => {
		const { addIcon } = await import('@iconify/svelte'); // offline: the icons the cell draws, so it renders synchronously
		for (const name of ['lucide:check', 'lucide:x']) addIcon(name, { body: '<path d="M0 0"/>' });
		const v = await show({
			part: 'table',
			props: {
				of: [
					{ id: 'a', name: 'Ada', admin: true },
					{ id: 'b', name: 'Bo', admin: false }
				],
				columns: ['name', 'admin']
			}
		});
		assert.deepEqual(
			[...v.target.querySelectorAll('tbody svg[aria-label]')].map((x) =>
				x.getAttribute('aria-label')
			),
			['Yes', 'No']
		);
		assert.equal(/[✓✗]/.test(textOf(v.target.querySelector('tbody'))), false);
	})
);

it.live(
	'two or more row actions fold into one menu in the grid; a single action stays a button',
	() =>
		browser(async () => {
			const rows = [{ id: 'a', name: 'Ada' }];
			const two = await show({
				part: 'table',
				props: {
					of: rows,
					columns: ['name'],
					actions: [
						{ action: 'x.reassign', label: 'Reassign' },
						{ action: 'x.cancel', label: 'Cancel' }
					]
				}
			});
			const cell = element(two.target, 'tbody [data-row-actions]');
			assert.ok(cell.querySelector('[data-row-menu]'), 'one menu trigger');
			assert.equal(
				/Reassign|Cancel/.test(textOf(cell)),
				false,
				'the labels live in the menu, not the cell'
			);
			await two.done();
			const one = await show({
				part: 'table',
				props: { of: rows, columns: ['name'], actions: [{ action: 'x.cancel', label: 'Cancel' }] }
			});
			assert.equal(one.target.querySelector('tbody [data-row-actions] [data-row-menu]'), null);
			assert.match(textOf(one.target.querySelector('tbody [data-row-actions]')), /Cancel/);
			await one.done();
		})
);

it.live(
	'the toolbar row: title, ⓘ and every widget flush left in that order; only New is pushed right',
	() =>
		browser(async () => {
			const v = await show({
				part: 'table',
				props: {
					of: 'jobs',
					columns: ['title'],
					toolbar: {
						title: 'Jobs',
						description: 'All jobs',
						new: () => {},
						actions: [{ icon: 'lucide:hash', name: 'Recount', run: () => Effect.void }]
					}
				}
			});
			const row = required(element(v.target, '[data-view-title]').parentElement);
			const marks = [...row.children].map(
				(el) =>
					[
						'data-view-title',
						'data-view-about',
						'data-search-toggle',
						'data-view-trigger',
						'data-view-actions',
						'data-view-new'
					].find((a) => el.hasAttribute(a) || el.querySelector(`[${a}]`) !== null) ?? el.tagName
			);
			assert.deepEqual(marks, [
				'data-view-title',
				'data-view-about',
				'data-search-toggle',
				'data-view-trigger',
				'data-view-actions',
				'data-view-new'
			]);
			// nothing stretches between the widgets: the create slot alone takes the free space, so a wrap keeps it at the row's end
			const pushers = [...row.children].filter((el) =>
				/(^|\s)(ml-auto|flex-1|grow)(\s|$)/.test(el.getAttribute('class') ?? '')
			);
			assert.deepEqual(
				pushers.map((el) => el.hasAttribute('data-view-new')),
				[true]
			);
			assert.equal(element(row, '[data-view-new]').getAttribute('aria-label'), 'New');
			await v.done();
		})
);
