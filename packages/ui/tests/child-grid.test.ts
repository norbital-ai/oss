import { required, textOf } from './view-fixture.ts';
import { element } from './elements.ts';
import {
	viewFixture,
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
const settle = async () => {
	flushSync();
	for (let i = 0; i < 5; i++) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};
const input = {
	collection: 'lines',
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
	const capabilities = (collection: string, id: string): RecordCapabilities => ({
		collection,
		id,
		revision: collection === 'jobs' ? 3 : id === 'l1' ? 7 : 8,
		fields:
			collection === 'jobs'
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
								field === 'id' || options.select === undefined || options.select[field] === true
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
					{ collection: 'jobs', id: 'j1', revision: 4 },
					{ collection: 'lines', id: 'l1', revision: 9 },
					{ collection: 'lines', id: 'l2', revision: 9 }
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
				props: { bolt, catalog, part: 'record', props: { of: 'jobs', id: 'j1' } }
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
				required(button(element<HTMLElement>(target, 'header'), 'Save')).click();
				yield* browser(() => settle());
				assert.deepEqual(required(acts[0]).input, {
					target: 'j1',
					set: {
						lines: {
							update: [
								{ target: 'l1', set: { amount: 2 } },
								{ target: 'l2', set: { amount: 4 } }
							]
						}
					}
				});
				assert.deepEqual(required(acts[0]).options.observed, { l1: 7, l2: 8, j1: 3 });
				assert.ok(reads.some(({ options }) => options.after === 'page2'));
			} finally {
				yield* browser(() => unmount(app));
				target.remove();
			}
		})
);
it.live(
	'independent related rows submit their own native update, leaving the parent untouched',
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
				const amount = element<HTMLInputElement>(target, '[data-field=amount] input');
				amount.value = '6';
				amount.dispatchEvent(new Event('input', { bubbles: true }));
				yield* browser(() => settle());
				required(button(target, 'Save')).click();
				yield* browser(() => settle());
				assert.equal(required(acts[0]).callable, 'lines.update');
				assert.deepEqual(required(acts[0]).input, { target: 'l1', set: { amount: 6 } });
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
			script.capabilities = (collection, id, parent) => {
				const result = original(collection, id);
				if (collection !== 'lines') return result;
				contexts.push(parent);
				return parent?.collection === 'jobs' &&
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
				props: { bolt, catalog: nested, part: 'record', props: { of: 'jobs', id: 'j1' } }
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
				required(button(element<HTMLElement>(target, 'header'), 'Save')).click();
				yield* browser(() => settle());
				assert.ok(contexts.some((parent) => parent?.revision === 3 && parent.relation === 'lines'));
				assert.ok(contexts.some((parent) => parent?.revision === 4 && parent.relation === 'lines'));
				assert.deepEqual(
					jsonRecord(jsonRecord(jsonRecord(required(acts[0]).input).set).lines).update,
					[{ target: 'l1', set: { amount: 3 } }]
				);
				assert.deepEqual(required(acts[0]).options.observed, { l1: 7, j1: 3 });
			} finally {
				yield* browser(() => unmount(app));
				target.remove();
			}
		})
);

it.live('create and delete remain explicit, and unloaded children never become deletions', () =>
	Effect.gen(function* () {
		const { bolt, script, capabilities, acts } = yield* browser(fixture);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: { bolt, catalog, part: 'record', props: { of: 'jobs', id: 'j1' } }
		});
		try {
			yield* browser(() => settle());
			required(button(target, 'Edit')).click();
			yield* browser(() => settle());
			required(button(target, 'Delete row')).click();
			yield* browser(() => settle());
			required(button(target, 'Add row')).click();
			yield* browser(() => settle());
			const amount = element<HTMLInputElement>(
				target,
				'[data-child-grid] [data-field=amount] input'
			);
			amount.value = '9';
			amount.dispatchEvent(new Event('input', { bubbles: true }));
			yield* browser(() => settle());
			required(button(element<HTMLElement>(target, 'header'), 'Save')).click();
			yield* browser(() => settle());
			assert.deepEqual(required(acts[0]).input, {
				target: 'j1',
				set: { lines: { delete: ['l1'], create: [{ amount: 9 }] } }
			});
			assert.deepEqual(required(acts[0]).options.observed, { l1: 7, j1: 3 });
		} finally {
			yield* browser(() => unmount(app));
			target.remove();
		}
	})
);
it.live('parent Cancel resets child drafts and explicit operations together', () =>
	Effect.gen(function* () {
		const { bolt, script, capabilities, acts } = yield* browser(fixture);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: { bolt, catalog, part: 'record', props: { of: 'jobs', id: 'j1' } }
		});
		const previous = globalThis.confirm;
		globalThis.confirm = () => true;
		try {
			yield* browser(() => settle());
			required(button(target, 'Edit')).click();
			yield* browser(() => settle());
			required(button(target, 'Delete row')).click();
			yield* browser(() => settle());
			required(button(target, 'Add row')).click();
			yield* browser(() => settle());
			required(button(element<HTMLElement>(target, 'header'), 'Cancel')).click();
			yield* browser(() => settle());
			assert.equal(target.querySelector('[data-child-grid] input'), null);
			assert.equal(
				target.querySelectorAll<HTMLElement>('[data-child-grid] [data-field=amount]').length,
				1
			);
			assert.match(
				textOf(element<HTMLElement>(target, '[data-child-grid] [data-field=amount]')),
				/1/
			);
			assert.equal(acts.length, 0);
		} finally {
			globalThis.confirm = previous;
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
		script.read = (collection, options) =>
			options.select?.job === true
				? originalRead(collection, options)
				: { rows: [{ id: 'free', revision: 11, amount: 5, job: null }], next: null };
		script.get = (collection, id) =>
			collection === 'jobs'
				? originalGet(collection, id)
				: { id, revision: 11, amount: 5, job: null };
		script.capabilities = (collection, id) => {
			const capability = originalCapabilities(collection, id);
			return collection === 'jobs'
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
			props: { bolt, catalog: shown, part: 'record', props: { of: 'jobs', id: 'j1' } }
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
			required(button(element<HTMLElement>(target, 'header'), 'Save')).click();
			yield* browser(() => settle());
			assert.deepEqual(required(acts[0]).input, {
				target: 'j1',
				set: { lines: { link: ['free'], unlink: ['l1'] } }
			});
			assert.deepEqual(required(acts[0]).options.observed, { free: 11, l1: 7, j1: 3 });
		} finally {
			yield* browser(() => unmount(app));
			target.remove();
		}
	})
);

it.live(
	'a custom body retains a child draft and original revision through history and a conflict',
	() =>
		Effect.gen(function* () {
			const { bolt, script, capabilities, acts } = yield* browser(fixture);
			let childRevision = 7;
			const originalGet = script.get,
				originalCapabilities = capabilities;
			script.get = (collection, id, select, options) =>
				options?.revision === undefined
					? originalGet(collection, id)
					: { id, revision: options.revision, title: 'Past job' };
			script.history = () => [
				{
					revision: 2,
					at: '2026-10-01T00:00:00Z',
					actor: { kind: 'member', id: 'u1' },
					changed: { title: 'Past job' }
				},
				{
					revision: 3,
					at: '2026-10-02T00:00:00Z',
					actor: { kind: 'member', id: 'u1' },
					changed: { title: 'Job' }
				}
			];
			script.read = () => ({
				rows: [
					{ id: 'l1', revision: childRevision, amount: childRevision === 7 ? 1 : 10, job: 'j1' }
				],
				next: null
			});
			script.capabilities = (collection, id) => {
				const value = originalCapabilities(collection, id);
				return collection === 'jobs' ? value : { ...value, revision: childRevision };
			};
			script.act = (callable, input, options) => {
				acts.push({ callable, input, options });
				return {
					kind: 'conflict',
					records: [{ collection: 'lines', id: 'l1', fields: ['amount'] }]
				};
			};
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, { target, props: { bolt, catalog, part: 'childCustom' } });
			try {
				yield* browser(() => settle());
				required(button(target, 'Edit')).click();
				yield* browser(() => settle());
				const amount = element<HTMLInputElement>(
					target,
					'[data-child-grid] [data-field=amount] input'
				);
				amount.value = '2';
				amount.dispatchEvent(new Event('input', { bubbles: true }));
				yield* browser(() => settle());
				childRevision = 8;
				element<HTMLElement>(target, '[data-timeline-trigger]').click();
				yield* browser(() => settle());
				const slider = element<HTMLElement>(document, '[data-record-timeline] [role=slider]');
				slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
				yield* browser(() => settle());
				assert.equal(target.querySelector('[data-child-grid] input'), null);
				slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
				yield* browser(() => settle());
				assert.equal(
					element<HTMLInputElement>(target, '[data-child-grid] [data-field=amount] input').value,
					'2'
				);
				required(button(element<HTMLElement>(target, 'header'), 'Save')).click();
				yield* browser(() => settle());
				assert.deepEqual(
					required(acts.find((a) => a.callable !== 'history.preview')).options.observed,
					{ l1: 7, j1: 3 }
				);
				assert.equal(
					element<HTMLInputElement>(target, '[data-child-grid] [data-field=amount] input').value,
					'2'
				);
				assert.match(textOf(target), /changed/);
			} finally {
				yield* browser(() => unmount(app));
				target.remove();
			}
		})
);

it.live(
	'owned-parent restrictions keep row values visible while independent editing cannot bypass them',
	() =>
		Effect.gen(function* () {
			const { bolt, script, capabilities, acts } = yield* browser(fixture);
			const originalCapabilities = capabilities;
			script.capabilities = (collection, id) => ({
				...originalCapabilities(collection, id),
				fields: { amount: { writable: false, proposal: false, reasons: ['ownedParentLocked'] } },
				update: { allowed: false, proposal: false, reasons: ['ownedParentLocked'] }
			});
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, {
				target,
				props: {
					bolt,
					catalog,
					part: 'child',
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
				assert.equal(target.querySelector('[data-field=amount] input'), null);
				assert.match(textOf(element<HTMLElement>(target, '[data-field=amount]')), /1/);
				assert.ok(element<HTMLElement>(target, '[data-field-restriction=ownedParentLocked]'));
				assert.equal(button(target, 'Save'), undefined);
				assert.equal(acts.length, 0);
			} finally {
				yield* browser(() => unmount(app));
				target.remove();
			}
		})
);
it.live('a full child representation opens with its collection and ID', () =>
	Effect.gen(function* () {
		const { bolt, script, capabilities } = yield* browser(fixture);
		const target = document.body.appendChild(document.createElement('div'));
		const previous = location.href;
		const app = mount(Harness, {
			target,
			props: {
				bolt,
				catalog,
				part: 'child',
				props: { of: 'jobs', relation: 'lines', id: 'j1', save: 'independent', columns: ['amount'] }
			}
		});
		try {
			yield* browser(() => settle());
			required(button(target, 'Open')).click();
			assert.ok(new URL(location.href).searchParams.getAll('record').includes('lines/l1'));
		} finally {
			history.replaceState(history.state, '', previous);
			yield* browser(() => unmount(app));
			target.remove();
		}
	})
);

it.live('independent row drafts guard unloading and Cancel clears the guard', () =>
	Effect.gen(function* () {
		const { bolt, script, capabilities } = yield* browser(fixture);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, {
			target,
			props: {
				bolt,
				catalog,
				part: 'child',
				props: { of: 'jobs', relation: 'lines', id: 'j1', save: 'independent', columns: ['amount'] }
			}
		});
		const previous = globalThis.confirm;
		globalThis.confirm = () => true;
		try {
			yield* browser(() => settle());
			required(button(target, 'Edit')).click();
			yield* browser(() => settle());
			const amount = element<HTMLInputElement>(target, '[data-field=amount] input');
			amount.value = '2';
			amount.dispatchEvent(new Event('input', { bubbles: true }));
			yield* browser(() => settle());
			const dirty = new Event('beforeunload', { cancelable: true });
			window.dispatchEvent(dirty);
			assert.equal(dirty.defaultPrevented, true);
			required(button(target, 'Cancel')).click();
			yield* browser(() => settle());
			const clean = new Event('beforeunload', { cancelable: true });
			window.dispatchEvent(clean);
			assert.equal(clean.defaultPrevented, false);
		} finally {
			globalThis.confirm = previous;
			yield* browser(() => unmount(app));
			target.remove();
		}
	})
);

it.live(
	'a parent delete-only child contract cannot borrow the child collection update permission',
	() =>
		Effect.gen(function* () {
			const { bolt, script, capabilities } = yield* browser(fixture);
			const deletion: ChildInput = {
				collection: 'lines',
				parent: 'job',
				owned: true,
				delete: true
			};
			const shown: NonNullable<KindsHost['catalog']> = {
				...catalog,
				jobs: { ...catalog.jobs, update: { columns: ['title'], with: { lines: deletion } } }
			};
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, {
				target,
				props: { bolt, catalog: shown, part: 'record', props: { of: 'jobs', id: 'j1' } }
			});
			try {
				yield* browser(() => settle());
				required(button(target, 'Edit')).click();
				yield* browser(() => settle());
				assert.equal(target.querySelector('[data-child-grid] [data-field=amount] input'), null);
				assert.ok(button(target, 'Delete row'));
			} finally {
				yield* browser(() => unmount(app));
				target.remove();
			}
		})
);

it.live(
	'an upsert-only parent relation stays readonly for undeclared create and update operations',
	() =>
		Effect.gen(function* () {
			const { bolt, script, capabilities } = yield* browser(fixture);
			const readonly: ChildInput = { collection: 'lines', parent: 'job', owned: true };
			const shown: NonNullable<KindsHost['catalog']> = {
				...catalog,
				jobs: { ...catalog.jobs, update: { columns: ['title'], with: { lines: readonly } } }
			};
			const target = document.body.appendChild(document.createElement('div'));
			const app = mount(Harness, {
				target,
				props: { bolt, catalog: shown, part: 'record', props: { of: 'jobs', id: 'j1' } }
			});
			try {
				yield* browser(() => settle());
				required(button(target, 'Edit')).click();
				yield* browser(() => settle());
				assert.equal(target.querySelector('[data-child-grid] input'), null);
				assert.equal(button(target, 'Add row'), undefined);
				assert.ok(button(target, 'Open'));
				assert.match(textOf(target), /available actions/);
			} finally {
				yield* browser(() => unmount(app));
				target.remove();
			}
		})
);
