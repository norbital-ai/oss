import { committed, single_act } from './act-envelope.ts';
import './dom.ts';
import assert from 'node:assert/strict';
import { afterEach, it, vi } from '@effect/vitest';
import { Deferred, Effect } from 'effect';
import type { Json } from '@norbital-ai/store/wire';
import type { Value } from '@norbital-ai/store/kind';
import { Decimal } from '@norbital-ai/store/decimal';
import type { KindsHost } from '../src/kinds/context.ts';
import type { Outcome } from '../../bolt/build/protocol/schema.js';
import type { Links } from '../src/model/BulkRelation.svelte';
import {
	editableFields,
	editableRelations,
	selectionEnabled,
	type Toolbar
} from '../src/model/ViewToolbar.svelte';
import { browser, required, viewFixture, type ViewScript } from './view-fixture.ts';
import { element } from './elements.ts';

const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const { default: Table } = await import('../src/table/Table.svelte');
const { default: BulkRelation } = await import('../src/model/BulkRelation.svelte');
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

const catalog: NonNullable<KindsHost['catalog']> = {
	jobs: {
		record_label: 'record.name',
		label: ['name'],
		fields: {
			name: { kind: 'text', default: 'Never replace untouched names' },
			enabled: { kind: 'bool', default: true },
			count: { kind: 'int', default: 8 },
			amount: { kind: 'decimal', scale: 3 },
			note: { kind: 'text', optional: true },
			locked: { kind: 'text' },
			secret: { kind: 'text', hidden: true },
			state: { kind: 'state', initial: 'open', states: { open: {} } }
		},
		update: {
			columns: ['name', 'enabled', 'count', 'amount', 'note', 'locked', 'secret', 'state']
		},
		readonly_fields: { locked: 'sync_owned' },
		delete: true
	}
};

async function show(
	act: ViewScript['act'],
	toolbar?: Toolbar,
	of = 'jobs',
	cat: NonNullable<KindsHost['catalog']> = catalog
) {
	// every field the read output promises; the host answers only those requested
	const values: Readonly<Record<string, Value>> = of === 'orders'
		? { status: 'draft', about: null }
		: { enabled: true, count: 8, amount: Decimal.of('1.000'), note: null, locked: 'L', secret: 'S', state: 'open' };
	const { bolt } = await viewFixture({
		catalog: cat,
		read: () => ({
			rows: ['job-a', 'job-b'].map((id, index) => ({ id, revision: index + 1, name: index === 0 ? 'A' : 'B', ...values })),
			next: null,
			total: 2
		}),
		act
	});
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(Harness, {
		target,
		props: {
			bolt,
			catalog: cat,
			part: 'table',
			view: Table,
			props: { of, columns: ['name'], toolbar: toolbar ?? { new: false } }
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
	return target;
}
async function openEditor(target: HTMLElement) {
	element<HTMLInputElement>(target, 'thead input[type=checkbox]').click();
	await settle();
	element<HTMLButtonElement>(target, '[data-view-actions]').click();
	await settle();
	element<HTMLButtonElement>(document, '[data-menu-item="update"] button').click();
	await settle();
}
async function choose(name: string) {
	element<HTMLButtonElement>(document, `[data-bulk-update-choose="${name}"]`).click();
	await settle();
}
async function type(name: string, value: string) {
	const input = element<HTMLInputElement>(
		document,
		`[data-bulk-update-field="${name}"] input:not([type=checkbox])`
	);
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
}

it.live(
	'bulk edit sends one native update with only explicitly chosen fields and exact values',
	() =>
		Effect.gen(function* () {
			const gate = yield* Deferred.make<Outcome>();
			const calls: { callable: string; input: Json }[] = [];
			const target = yield* browser(() =>
				show((body) => {
					assert.ok('acts' in body, 'model edits use the native action map');
					assert.deepEqual(Object.keys(body.acts), ['jobs.update']);
					const { callable, input } = single_act(body);
					calls.push({ callable, input });
					return Deferred.await(gate);
				})
			);
			yield* browser(() => openEditor(target));
			assert.deepEqual(
				[...document.querySelectorAll<HTMLElement>('[data-bulk-update-field]')].map(
					(field) => field.dataset['bulkUpdateField']
				),
				['name', 'enabled', 'count', 'amount', 'note']
			);
			assert.equal(
				element<HTMLButtonElement>(document, '[data-bulk-update-submit]').disabled,
				true
			);
			yield* browser(() => choose('enabled'));
			element<HTMLButtonElement>(
				document,
				'[data-bulk-update-field="enabled"] button[role=checkbox]:not([data-bulk-update-choose])'
			).click();
			yield* browser(() => choose('count'));
			yield* browser(() => type('count', '0'));
			yield* browser(() => choose('amount'));
			yield* browser(() => type('amount', '9007199254740993.125'));
			yield* browser(() => choose('note'));
			const submit = element<HTMLButtonElement>(document, '[data-bulk-update-submit]');
			submit.click();
			yield* browser(settle);
			assert.equal(submit.disabled, true);
			submit.click();
			assert.deepEqual(calls, [
				{
					callable: 'jobs.update',
					input: ['job-a', 'job-b'].map((id, index) => ({
						target: { id, revision: index + 1 },
						set: { enabled: false, count: 0, amount: { $dec: '9007199254740993.125' }, note: null }
					}))
				}
			]);
			yield* Deferred.succeed(gate, { kind: 'committed', output: { 'jobs.update': null }, records: [] });
			yield* browser(settle);
			assert.equal(target.querySelector('[data-selected-count]'), null);
			assert.equal(document.querySelector('[data-bulk-update]'), null);
		})
);

it.live(
	'invalid chosen values do not write; native refusals preserve selection and the draft',
	() =>
		Effect.gen(function* () {
			const calls: Json[] = [];
			const target = yield* browser(() =>
				show((body) => {
					const { input } = single_act(body);
					calls.push(input);
					return { kind: 'refused', code: 'locked', message: 'This record is locked.' };
				})
			);
			yield* browser(() => openEditor(target));
			yield* browser(() => choose('amount'));
			assert.equal(
				element<HTMLButtonElement>(document, '[data-bulk-update-submit]').disabled,
				true
			);
			yield* browser(() => type('amount', '1.250'));
			yield* browser(() => type('amount', 'invalid'));
			element<HTMLButtonElement>(document, '[data-bulk-update-submit]').click();
			yield* browser(settle);
			assert.equal(calls.length, 0);
			yield* browser(() => type('amount', '2.500'));
			element<HTMLButtonElement>(document, '[data-bulk-update-submit]').click();
			yield* browser(settle);
			assert.equal(calls.length, 1);
			assert.match(
				required(document.querySelector('[data-menu-item="update"] [data-menu-error]'))
					.textContent ?? '',
				/locked/
			);
			assert.match(
				required(target.querySelector('[data-selected-count]')).textContent ?? '',
				/2 selected/
			);
			assert.ok(
				document.querySelector('[data-bulk-update-field="amount"] input:not([type=checkbox])')
			);
			element<HTMLInputElement>(target, 'tbody input[type=checkbox]').click();
			yield* browser(settle);
			assert.equal(document.querySelector('[data-bulk-update]'), null);
		})
);

it.live(
	'explicit toolbar opt-outs disable selection and readonly-only catalogues do not offer bulk edits',
	() =>
		Effect.gen(function* () {
			for (const toolbar of [false, { actions: false }, { select: false }] satisfies Toolbar[]) {
				assert.equal(selectionEnabled(toolbar, catalog['jobs']), false);
				const target = yield* browser(() =>
					show(committed, toolbar)
				);
				assert.equal(target.querySelector('tbody input[type=checkbox]'), null);
			}
			assert.equal(
				selectionEnabled(
					{},
					{
						record_label: 'record.locked',
						label: ['locked'],
						fields: { locked: { kind: 'text' }, secret: { kind: 'text', hidden: true } },
						readonly_fields: { locked: 'sync_owned' },
						update: { columns: ['locked', 'secret'] }
					}
				),
				false
			);
		})
);

const orders: NonNullable<KindsHost['catalog']> = {
	orders: {
		record_label: 'record.name',
		label: ['name'],
		fields: {
			name: { kind: 'text' },
			status: {
				kind: 'state',
				initial: 'draft',
				states: { draft: { to: ['sent'] }, sent: { to: ['paid', 'void'] }, paid: {}, void: {} }
			}
		},
		relations: { about: { targets: ['jobs', 'people'], optional: true } },
		many: ['lines', 'notes'],
		update: {
			columns: ['name', 'status', 'about'],
			with: {
				lines: {
					model: 'lines',
					parent: 'order',
					create: { columns: ['sku'] },
					link: true,
					unlink: true
				},
				notes: { model: 'notes', parent: 'order' }
			}
		}
	},
	lines: {
		record_label: 'record.sku',
		label: ['sku'],
		fields: { sku: { kind: 'text' } },
		relations: { order: { targets: ['orders'], optional: true } }
	},
	jobs: { record_label: 'record.name', label: ['name'], fields: { name: { kind: 'text' } } },
	people: { record_label: 'record.name', label: ['name'], fields: { name: { kind: 'text' } } }
};

it('bulk edit offers a state by the states its edges reach, a polymorphic relation by every target, and many-relations by update.with', () => {
	const fields = editableFields(orders['orders']);
	assert.deepEqual(
		fields.map((field) => [field.name, field.kind]),
		[
			['name', { kind: 'text' }],
			['status', { kind: 'enum', values: ['sent', 'paid', 'void'] }],
			['about', { kind: 'ref', to: 'jobs', optional: true }]
		]
	);
	assert.deepEqual(fields.find((field) => field.name === 'about')?.relation?.targets, [
		'jobs',
		'people'
	]);
	// a relation with no command the caller holds is not offered
	assert.deepEqual(
		editableRelations(orders['orders']).map((relation) => relation.name),
		['lines']
	);
	assert.equal(
		selectionEnabled(
			{},
			{
				label: [],
				fields: {},
				update: { columns: [], with: orders['orders']?.update?.with }
			}
		),
		true
	);
	// a state no edge moves into is never offered
	assert.deepEqual(
		editableFields(catalog['jobs']).map((field) => field.name),
		['name', 'enabled', 'count', 'amount', 'note']
	);
});

it.live(
	'a many-relation create rides the one bulk update act; existing-child commands need one record',
	() =>
		Effect.gen(function* () {
			const calls: { callable: string; input: Json }[] = [];
			const target = yield* browser(() =>
				show(
					(body) => {
						const { callable, input } = single_act(body);
						calls.push({ callable, input });
						return committed(body);
					},
					undefined,
					'orders',
					orders
				)
			);
			yield* browser(() => openEditor(target));
			assert.deepEqual(
				[...document.querySelectorAll<HTMLElement>('[data-bulk-update-field]')].map(
					(field) => field.dataset['bulkUpdateField']
				),
				['name', 'status', 'about', 'lines']
			);
			yield* browser(() => choose('about'));
			// an arc picks its target, then a record there
			assert.equal(
				document.querySelectorAll('[data-bulk-update-field="about"] [data-arc] [role=combobox]')
					.length,
				2
			);
			yield* browser(() => choose('about'));
			yield* browser(() => choose('lines'));
			assert.equal(document.querySelector('[data-bulk-relation-op]'), null);
			element<HTMLButtonElement>(document, '[data-bulk-relation-add]').click();
			yield* browser(settle);
			const sku = element<HTMLInputElement>(document, '[data-bulk-relation-new="0"] input');
			sku.value = 'X-1';
			sku.dispatchEvent(new Event('input', { bubbles: true }));
			yield* browser(settle);
			element<HTMLButtonElement>(document, '[data-bulk-update-submit]').click();
			yield* browser(settle);
			assert.deepEqual(calls, [
				{
					callable: 'orders.update',
					input: ['job-a', 'job-b'].map((id, index) => ({
						target: { id, revision: index + 1 },
						set: { lines: { create: [{ sku: 'X-1' }] } }
					}))
				}
			]);
		})
);

it.live('an existing-child read failure keeps bulk commands unchanged and a retry retains the actual revision', () =>
	Effect.gen(function* () {
		let unavailable = true;
		const changes: Links[] = [];
		const { bolt } = yield* browser(() => viewFixture({
			catalog: orders,
			read: () => ({ rows: [{ id: 'free', revision: 11, sku: 'X-1' }], next: null, total: 1 }),
			get: () => unavailable
				? new Response(JSON.stringify({ error: { code: 'upstream', message: 'Child details unavailable' } }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				})
				: { id: 'free', revision: 11 }
		}));
		const target = yield* browser(async () => {
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, {
				target,
				props: {
					bolt,
					catalog: orders,
					part: 'bulk-relation',
					view: BulkRelation,
					props: {
						name: 'lines',
						child: { model: 'lines', parent: 'order', link: true },
						parent_id: 'order-1',
						value: { create: [], link: [], unlink: [], delete: [] },
						on_change: (next: Links) => changes.push(next),
						id: 'bulk-lines',
						errors: new Map<string, string>()
					}
				}
			});
			mounted.push(async () => { await unmount(app); target.remove(); });
			await settle();
			return target;
		});
		const chooseExisting = async () => {
			element<HTMLButtonElement>(target, '[data-bulk-relation-op="link"] [role=combobox]').click();
			await settle();
			await vi.waitFor(() => {
				flushSync();
				element(document, '[role=listbox] [data-value="free"] button');
			});
			element<HTMLButtonElement>(document, '[role=listbox] [data-value="free"] button').click();
			await settle();
		};
		yield* browser(chooseExisting);
		yield* browser(() => vi.waitFor(() => {
			flushSync();
			assert.equal(toasts.at(-1)?.tone, 'error');
			assert.equal(toasts.at(-1)?.text, 'Child details unavailable');
		}));
		assert.deepEqual(changes, []);
		unavailable = false;
		yield* browser(chooseExisting);
		assert.deepEqual(changes, [{ create: [], link: [{ id: 'free', revision: 11 }], unlink: [], delete: [] }]);
	})
);
