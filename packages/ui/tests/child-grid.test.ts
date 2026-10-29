import { required, textOf } from './view-fixture.ts';
import { confirmDialog, element } from './elements.ts';
import {
	viewFixture,
	jsonArray,
	jsonRecord,
	type ActOptions,
	type ReadOptions,
	browser
} from './view-fixture.ts';
import { Effect } from 'effect';
import './dom.ts';
import assert from 'node:assert/strict';
import type { Json } from '@norbital-ai/std/wire';
import type { RecordCapabilities, RecordParentContext } from '../src/record/types.ts';
import type { KindsHost, ChildInput } from '../src/kinds/context.ts';
import { it } from '@effect/vitest';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const { default: ChildGrid } = await import('../src/relations/ChildGrid.svelte');
const { default: RecordShell } = await import('../src/record/RecordShell.svelte');
const settle = async () => {
	flushSync();
	for (let i = 0; i < 5; i++) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};
/** Discarding a dirty grid asks in-app; the test agrees through the real dialog. */
const agree = async () => {
	await settle();
	confirmDialog()?.answer(true);
	await settle();
};
const input = {
	model: 'lines',
	parent: 'job',
	owned: true,
	create: { columns: ['amount'] },
	update: { columns: ['amount'] },
	delete: true
} as const;
const catalog = {
	jobs: {
		label: ['title'],
		fields: { title: { kind: 'text' } },
		update: { columns: ['title'], with: { lines: input } },
		children: { lines: input }
	},
	lines: {
		label: ['amount'],
		fields: { amount: { kind: 'int' } },
		relations: { job: { targets: ['jobs'] } },
		create: { columns: ['amount', 'job'] },
		update: { columns: ['amount'] },
		delete: true
	}
} satisfies NonNullable<KindsHost['catalog']>;
async function fixture() {
	const acts: { callable: string; input: Json; options: ActOptions }[] = [],
		reads: { c: string; options: ReadOptions }[] = [];
	const capabilities = (model: string, id: string): RecordCapabilities => ({
		model,
		id,
		revision: model === 'jobs' ? 3 : id === 'l1' ? 7 : 8,
		fields:
			model === 'jobs'
				? { title: { writable: true, proposal: false, reasons: [] } }
				: {
						amount: { writable: true, proposal: false, reasons: [] },
						job: { writable: false, proposal: false, reasons: ['ownedParent'] }
					},
		update: { allowed: true, proposal: false, reasons: [] },
		delete: { allowed: true, proposal: false, reasons: [] },
		moves: {},
		proposalMoves: {}
	});
	const { bolt, script } = await viewFixture({
		get: (_c, id) => ({ id, revision: 3, title: 'Job' }),
		history: () => [],
		read: (c, options) => {
			reads.push({ c, options });
			const row = {
				id: options.after ? 'l2' : 'l1',
				revision: options.after ? 8 : 7,
				amount: 1,
				job: 'j1'
			};
			return {
				rows: [
					Object.fromEntries(
						Object.entries(row).filter(
							([field]) =>
								field === 'id' || options.fields === undefined || options.fields.includes(field)
						)
					)
				],
				next: options.after ? null : 'page2'
			};
		},
		capabilities,
		act: (callable, input, options) => {
			acts.push({ callable, input, options });
			return {
				kind: 'committed',
				output: null,
				records: [
					{ model: 'jobs', id: 'j1', revision: 4 },
					{ model: 'lines', id: 'l1', revision: 9 },
					{ model: 'lines', id: 'l2', revision: 9 }
				]
			};
		}
	});
	return { bolt, script, capabilities, acts, reads };
}
const button = (target: ParentNode, text: string) =>
	[...target.querySelectorAll<HTMLButtonElement>('button')].find(
		(node) => textOf(node).trim() === text
	);
it.live(
	'nested rows save explicit changed operations with original revisions across pagination',
	() =>
		Effect.gen(function* () {
			const { bolt, script, capabilities, acts, reads } = yield* browser(fixture);
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, {
				target,
				props: { bolt, catalog, part: 'record', view: RecordShell, props: { of: 'jobs', id: 'j1' } }
			});
			try {
				yield* browser(() => settle());
				required(button(target, 'Edit')).click();
				yield* browser(() => settle());
				const first = element<HTMLInputElement>(
					target,
					'[data-child-grid] [data-field=amount] input'
				);
				assert.ok(first);
				first.value = '2';
				first.dispatchEvent(new Event('input', { bubbles: true }));
				yield* browser(() => settle());
				required(button(target, 'Next page')).click();
				yield* browser(() => settle());
				const second = element<HTMLInputElement>(
					target,
					'[data-child-grid] [data-field=amount] input'
				);
				second.value = '4';
				second.dispatchEvent(new Event('input', { bubbles: true }));
				yield* browser(() => settle());
				required(button(element<HTMLElement>(target, '[data-record-foot]'), 'Save')).click();
				yield* browser(() => settle());
				assert.deepEqual(required(acts[0]).input, [
					{
						target: 'j1',
						set: {
							lines: {
								update: [
									{ target: 'l1', set: { amount: 2 } },
									{ target: 'l2', set: { amount: 4 } }
								]
							}
						}
					}
				]);
				assert.deepEqual(required(acts[0]).options.observed, { l1: 7, l2: 8, j1: 3 });
				assert.ok(reads.some(({ options }) => options.after === 'page2'));
			} finally {
				yield* browser(() => unmount(app));
				target.remove();
			}
		})
);
it.live(
	'independent row drafts guard unloading until Cancel, and save their own native update, leaving the parent untouched',
	() =>
		Effect.gen(function* () {
			const { bolt, script, capabilities, acts } = yield* browser(fixture);
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, {
				target,
				props: {
					bolt,
					catalog,
					part: 'child',
					view: ChildGrid,
					props: {
						of: 'jobs',
						relation: 'lines',
						id: 'j1',
						save: 'independent',
						columns: ['amount']
					}
				}
			});
			try {
				yield* browser(() => settle());
				required(button(target, 'Edit')).click();
				yield* browser(() => settle());
				const draft = element<HTMLInputElement>(target, '[data-field=amount] input');
				draft.value = '2';
				draft.dispatchEvent(new Event('input', { bubbles: true }));
				yield* browser(() => settle());
				const dirty = new Event('beforeunload', { cancelable: true });
				window.dispatchEvent(dirty);
				assert.equal(dirty.defaultPrevented, true);
				required(button(target, 'Cancel')).click();
				yield* browser(agree);
				const clean = new Event('beforeunload', { cancelable: true });
				window.dispatchEvent(clean);
				assert.equal(clean.defaultPrevented, false);
				required(button(target, 'Edit')).click();
				yield* browser(() => settle());
				const amount = element<HTMLInputElement>(target, '[data-field=amount] input');
				amount.value = '6';
				amount.dispatchEvent(new Event('input', { bubbles: true }));
				yield* browser(() => settle());
				required(button(target, 'Save')).click();
				yield* browser(() => settle());
				assert.equal(required(acts[0]).callable, 'lines.update');
				assert.deepEqual(required(acts[0]).input, [{ target: 'l1', set: { amount: 6 } }]);
				assert.deepEqual(required(acts[0]).options.observed, { l1: 7 });
			} finally {
				yield* browser(() => unmount(app));
				target.remove();
			}
		})
);

it.live(
	'parent-only row editing requests native capabilities through its original parent revision',
	() =>
		Effect.gen(function* () {
			const { bolt, script, capabilities, acts } = yield* browser(fixture);
			const contexts: (RecordParentContext | undefined)[] = [];
			let parentRevision = 3;
			const act = script.act;
			script.act = (callable, input, options) => {
				parentRevision = 4;
				return act(callable, input, options);
			};
			const original = capabilities;
			script.capabilities = (model, id, parent) => {
				const result = original(model, id);
				if (model !== 'lines') return result;
				contexts.push(parent);
				return parent?.model === 'jobs' &&
					parent.id === 'j1' &&
					parent.relation === 'lines' &&
					parent.revision === parentRevision
					? result
					: {
							...result,
							fields: { amount: { writable: false, proposal: false, reasons: ['noGrant'] } },
							update: { allowed: false, proposal: false, reasons: ['noGrant'] }
						};
			};
			const nested: NonNullable<KindsHost['catalog']> = {
				...catalog,
				lines: {
					label: catalog.lines.label,
					fields: catalog.lines.fields,
					relations: catalog.lines.relations
				}
			};
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, {
				target,
				props: {
					bolt,
					catalog: nested,
					part: 'record',
					view: RecordShell,
					props: { of: 'jobs', id: 'j1' }
				}
			});
			try {
				yield* browser(() => settle());
				required(button(target, 'Edit')).click();
				yield* browser(() => settle());
				const amount = element<HTMLInputElement>(
					target,
					'[data-child-grid] [data-field=amount] input'
				);
				assert.ok(amount);
				assert.equal(amount.disabled, false);
				amount.value = '3';
				amount.dispatchEvent(new Event('input', { bubbles: true }));
				yield* browser(() => settle());
				required(button(element<HTMLElement>(target, '[data-record-foot]'), 'Save')).click();
				yield* browser(() => settle());
				assert.ok(contexts.some((parent) => parent?.revision === 3 && parent.relation === 'lines'));
				assert.ok(contexts.some((parent) => parent?.revision === 4 && parent.relation === 'lines'));
				assert.deepEqual(
					jsonRecord(
						jsonRecord(jsonRecord(required(jsonArray(required(acts[0]).input)[0])).set).lines
					).update,
					[{ target: 'l1', set: { amount: 3 } }]
				);
				assert.deepEqual(required(acts[0]).options.observed, { l1: 7, j1: 3 });
			} finally {
				yield* browser(() => unmount(app));
				target.remove();
			}
		})
);

it.live(
	'parent Cancel resets child drafts and operations; create and delete stay explicit, and unloaded children never become deletions',
	() =>
		Effect.gen(function* () {
			const { bolt, acts } = yield* browser(fixture);
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, {
				target,
				props: { bolt, catalog, part: 'record', view: RecordShell, props: { of: 'jobs', id: 'j1' } }
			});
			const deleteAndAdd = Effect.gen(function* () {
				required(button(target, 'Edit')).click();
				yield* browser(() => settle());
				required(button(target, 'Delete row')).click();
				yield* browser(() => settle());
				required(button(target, 'Add row')).click();
				yield* browser(() => settle());
			});
			try {
				yield* browser(() => settle());
				yield* deleteAndAdd;
				required(button(element<HTMLElement>(target, '[data-record-foot]'), 'Cancel')).click();
				yield* browser(agree);
				assert.equal(target.querySelector('[data-child-grid] input'), null);
				assert.equal(
					target.querySelectorAll<HTMLElement>('[data-child-grid] [data-field=amount]').length,
					1
				);
				assert.equal(acts.length, 0);
				yield* deleteAndAdd;
				const amount = element<HTMLInputElement>(
					target,
					'[data-child-grid] [data-field=amount] input'
				);
				amount.value = '9';
				amount.dispatchEvent(new Event('input', { bubbles: true }));
				yield* browser(() => settle());
				required(button(element<HTMLElement>(target, '[data-record-foot]'), 'Save')).click();
				yield* browser(() => settle());
				assert.deepEqual(required(acts[0]).input, [
					{ target: 'j1', set: { lines: { delete: ['l1'], create: [{ amount: 9 }] } } }
				]);
				assert.deepEqual(required(acts[0]).options.observed, { l1: 7, j1: 3 });
			} finally {
				yield* browser(() => unmount(app));
				target.remove();
			}
		})
);

it.live('link and unlink send explicit IDs and both original snapshots', () =>
	Effect.gen(function* () {
		const { bolt, script, capabilities, acts } = yield* browser(fixture);
		const { owned, ...related } = input;
		const child: ChildInput = { ...related, link: true, unlink: true };
		const shown: NonNullable<KindsHost['catalog']> = {
			jobs: {
				...catalog.jobs,
				update: { columns: ['title'], with: { lines: child } },
				children: { lines: child }
			},
			lines: {
				...catalog.lines,
				relations: { job: { targets: ['jobs'], optional: true } },
				update: { columns: ['amount', 'job'] }
			}
		};
		const originalRead = script.read,
			originalGet = script.get,
			originalCapabilities = capabilities;
		script.read = (model, options) =>
			options.fields?.includes('job') === true
				? originalRead(model, options)
				: { rows: [{ id: 'free', revision: 11, amount: 5, job: null }], next: null };
		script.get = (model, id) =>
			model === 'jobs' ? originalGet(model, id) : { id, revision: 11, amount: 5, job: null };
		script.capabilities = (model, id) => {
			const capability = originalCapabilities(model, id);
			return model === 'jobs'
				? capability
				: {
						...capability,
						revision: id === 'free' ? 11 : capability.revision,
						fields: { ...capability.fields, job: { writable: true, proposal: false, reasons: [] } }
					};
		};
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: {
				bolt,
				catalog: shown,
				part: 'record',
				view: RecordShell,
				props: { of: 'jobs', id: 'j1' }
			}
		});
		try {
			yield* browser(() => settle());
			required(button(target, 'Edit')).click();
			yield* browser(() => settle());
			required(button(target, 'Unlink')).click();
			yield* browser(() => settle());
			element<HTMLElement>(target, '[data-child-grid] [role=combobox]').click();
			yield* browser(() => settle());
			const option = element<HTMLElement>(document, '[role=option][data-value=free]');
			assert.ok(option);
			element<HTMLButtonElement>(option, 'button').click();
			yield* browser(() => settle());
			required(button(target, 'Link existing')).click();
			yield* browser(() => settle());
			required(button(element<HTMLElement>(target, '[data-record-foot]'), 'Save')).click();
			yield* browser(() => settle());
			assert.deepEqual(required(acts[0]).input, [
				{ target: 'j1', set: { lines: { link: ['free'], unlink: ['l1'] } } }
			]);
			assert.deepEqual(required(acts[0]).options.observed, { free: 11, l1: 7, j1: 3 });
		} finally {
			yield* browser(() => unmount(app));
			target.remove();
		}
	})
);
