import './dom.ts';
import { required, textOf, browser } from './view-fixture.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { and, compact } from '../src/filter/scope.ts';
import { flat } from '../src/read/aggregate.ts';
import { label, msg } from '../src/text/messages.ts';
import { like } from '../src/cell/value.ts';
import { progressOf, runFiles } from '../src/runs/facts.ts';
import { rangeText, searchRows, readTableState, writeTableState } from '../src/table/model.ts';
import { readState, failed } from '../src/read/state.ts';
import { rowsOps } from '../src/relations/operations.ts';
import { series } from '../src/chart/series.ts';
import { withOutputs } from '../src/client/context.ts';
import type { HistoryEntry, Query, QueryAnswer } from '../src/client/contract.ts';
import { reactive } from './kit-state.svelte.js';
import { listRequest, unref, refOf, label_read } from '../src/relations/select.ts';
import { recordText } from '../src/kinds/kind.ts';
import { Effect } from 'effect';
import { format_value as show } from '../src/kinds/kind.ts';
import { jsonRecord, viewFixture } from './view-fixture.ts';
import type { KindsHost } from '../src/kinds/context.ts';
import type { Json } from '@norbital-ai/store';

const bolt = { t: (k: string) => k };

it('reads own nested CEL label dependencies and uses each target’s own label for references', () => {
	const cat: NonNullable<KindsHost['catalog']> = {
		orders: {
			label: ['code', 'details'],
			record_label: "record.code + ' · ' + record.details.name",
			label_paths: ['code', 'details.name'],
			fields: { code: { kind: 'text' }, details: { kind: 'json' } },
			relations: { customer: { targets: ['customers'] } },
			layers: ['customer']
		},
		customers: {
			label: ['code', 'name'],
			record_label: "record.code + ' — ' + record.name",
			fields: { code: { kind: 'text' }, name: { kind: 'text' } }
		}
	};
	assert.deepEqual(label_read(cat, 'orders', { limit: 1 }), {
		orders: { limit: 1, fields: ['code', 'details'] }
	});
	const row = {
		id: 'o1',
		code: 'Q7',
		details: { name: 'Acme' },
		customer: { id: 'c1', code: 'C1', name: 'Acme' }
	};
	assert.equal(recordText(cat.orders, row), 'Q7 · Acme');
	assert.equal(recordText({}, row), 'o1');
	assert.equal(
		refOf(required(unref(cat, 'orders', ['customer'], [row])[0]), 'customer')?.text,
		'C1 — Acme'
	);
});

it.effect('no grant is a state of its own, never an empty page', () =>
	Effect.sync(() => {
		assert.deepEqual(readState(undefined, Object.assign(new Error('x'), { code: 'forbidden' })), {
			kind: 'noAccess'
		});
		assert.deepEqual(readState({ rows: [], next: null }, undefined), {
			kind: 'ready',
			value: { rows: [], next: null }
		});
		assert.deepEqual(readState(undefined, undefined), { kind: 'loading' });
		assert.deepEqual(readState(undefined, undefined, false), { kind: 'empty' });
		assert.deepEqual(readState(null, undefined, false), { kind: 'ready', value: null });
		assert.equal(
			readState(undefined, Object.assign(new Error('big'), { code: 'too_large' })).kind,
			'error'
		);
		assert.deepEqual(failed(Object.assign(new Error('no'), { code: 'forbidden' })), {
			kind: 'noAccess'
		});
	})
);

it.effect('table cursor and search round-trip through the URL', () =>
	Effect.sync(() => {
		const p = writeTableState(new URLSearchParams('other=1'), 'quotes', { after: 'c1', q: 'acme' });
		assert.equal(p.get('other'), '1');
		assert.deepEqual(readTableState(p, 'quotes'), { after: 'c1', q: 'acme' });
		assert.equal(writeTableState(p, 'quotes', { after: null, q: '' }).toString(), 'other=1');
		assert.equal(and(undefined, {}, null), undefined);
		assert.deepEqual(and({ a: { eq: 1 } }, { b: { eq: 2 } }), {
			and: [{ a: { eq: 1 } }, { b: { eq: 2 } }]
		});
		assert.deepEqual(compact({ a: 1, b: undefined }), { a: 1 });
		assert.equal(like(3, '7'), 7);
		assert.deepEqual(
			searchRows(
				[
					{ id: 'a', name: 'Acme' },
					{ id: 'b', name: 'Beta' }
				],
				'ac',
				['name']
			).map((r) => r.id),
			['a']
		);
	})
);

it.live('a later page stays live through Query state; a restored cursor reads once', () =>
	Effect.gen(function* () {
		const lived: Json[] = [];
		const { bolt } = yield* browser(() =>
			viewFixture({
				catalog: { c: { label: [], fields: {}, audit: false } },
				read: (_model, options) =>
					options.after === undefined
						? {
								rows: Array.from({ length: options.limit ?? 0 }, (_, i) => ({ id: String(i) })),
								next: 'n'
							}
						: { rows: [{ id: 'once' }], next: null },
				changes: (read) => {
					lived.push(jsonRecord(read.a[0]).c ?? null);
					return () => {};
				}
			})
		);
		const { flushSync, mount, tick, unmount } = yield* browser(() => import('svelte'));
		const { default: Harness } = yield* browser(() => import('./paging-harness.svelte'));
		const settle = async () => {
			for (let i = 0; i < 5; i++) {
				flushSync();
				await tick();
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		};
		const state = reactive<{
			of: string;
			read(limit: number, after?: string): Query<QueryAnswer>;
			index: number | null;
			after: string | null;
		}>({
			of: 'c',
			read: (limit: number, after?: string) =>
				bolt.query({ c: after === undefined ? { limit } : { limit, after } }),
			index: 0,
			after: null
		});
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, { target, props: state });
		const shown = () => textOf(target.querySelector('output'));
		try {
			yield* browser(settle);
			assert.equal(shown(), Array.from({ length: 25 }, (_, i) => String(i)).join(','));
			state.index = 2;
			state.after = 'c2';
			yield* browser(settle);
			assert.deepEqual(lived.at(-1), { limit: 75 });
			assert.equal(shown(), Array.from({ length: 25 }, (_, i) => String(50 + i)).join(','));
			state.index = null;
			state.after = 'c9';
			yield* browser(settle);
			assert.equal(lived.length, 2);
			assert.equal(shown(), 'once');
		} finally {
			yield* browser(() => unmount(app));
			target.remove();
		}
	})
);

it.effect('range and count', () =>
	Effect.sync(() => {
		assert.equal(rangeText(bolt, 25, 25, 312), 'rows 26–50 of 312');
		assert.equal(rangeText(bolt, 0, 0, null), 'No rows');
		assert.equal(rangeText(bolt, 0, 1, 0), 'rows 1–1'); // a live row ahead of the 30 s count
		assert.equal(
			msg({ t: (k) => (k === 'ui.table.next' ? 'Suivant' : k) }, 'table.next'),
			'Suivant'
		);
		assert.equal(label(bolt, 'leave_entries', 'start_part'), 'Start part');
	})
);

it.effect("a view's read names each root's view output unless it names one", () =>
	Effect.sync(() => {
		const catalog = {
			people: {
				record_label: 'record.name',
				label: ['name'],
				fields: { name: { kind: 'text' } },
				output: 'directory'
			},
			jobs: { record_label: 'record.title', label: ['title'], fields: { title: { kind: 'text' } } }
		} satisfies NonNullable<KindsHost['catalog']>;
		assert.deepEqual(
			withOutputs(
				{ people: { limit: 5 }, 'people.jobs': {}, jobs: {}, sys_user: { output: 'default' } },
				{ ...catalog, sys_user: { ...catalog.people } }
			),
			{
				people: { limit: 5, output: 'directory' },
				'people.jobs': {},
				jobs: {},
				sys_user: { output: 'default' }
			}
		);
		assert.deepEqual(withOutputs({ people: {} }, undefined), { people: {} });
	})
);

it.effect('values display by shape', () =>
	Effect.sync(() => {
		assert.equal(show(1234.5, 'en'), '1,234.5');
		assert.equal(show({ from: '2026-01-01', to: null }), '2026-01-01 – …');
		assert.equal(show({ id: 'f', name: 'a.pdf', mime: 'application/pdf' }), 'a.pdf');
		// a value without its kind is shown as it is: decimal text verbatim, an instant in the locale
		assert.equal(show('1234.5', 'en'), '1234.5');
		assert.equal(
			show('2026-01-02T03:04:05.000Z', 'en'),
			new Date('2026-01-02T03:04:05.000Z').toLocaleString('en', {
				dateStyle: 'medium',
				timeStyle: 'short'
			})
		);
	})
);

it.effect('Rows sends explicit ops; a delete is only what the viewer removed', () =>
	Effect.sync(() => {
		const loaded = [
			{ id: '1', qty: 1 },
			{ id: '2', qty: 2 },
			{ id: '3', qty: 3 }
		];
		const current: Parameters<typeof rowsOps>[1] = [
			{ id: '1', qty: 5 },
			{ id: '3', qty: 3 },
			{ qty: 9 }
		];
		assert.deepEqual(rowsOps(loaded, current, ['2']), {
			create: [{ qty: 9 }],
			update: [{ target: '1', set: { qty: 5 } }],
			delete: ['2']
		});
		assert.deepEqual(rowsOps(loaded, current, []), {
			create: [{ qty: 9 }],
			update: [{ target: '1', set: { qty: 5 } }]
		});
	})
);

it.effect('Rows ignores reordered object keys while preserving decimal and array edits', () =>
	Effect.sync(() => {
		const loaded = [{ id: '1', details: { amount: '1.20', tags: ['a', 'b'] } }];
		const current = [{ id: '1', details: { tags: ['a', 'b'], amount: '1.20' } }];
		assert.deepEqual(rowsOps(loaded, current, []), {});
		required(current[0]).details.amount = '2.00';
		assert.deepEqual(rowsOps(loaded, current, []), {
			update: [{ target: '1', set: { details: required(current[0]).details } }]
		});
		required(current[0]).details.amount = '1.20';
		assert.deepEqual(rowsOps(loaded, current, []), {});
		required(current[0]).details.tags.reverse();
		assert.deepEqual(rowsOps(loaded, current, []), {
			update: [{ target: '1', set: { details: required(current[0]).details } }]
		});
	})
);

it.effect('a list read names its light fields and FKs, plus any heavy column', () =>
	Effect.sync(() => {
		const ex: NonNullable<KindsHost['catalog']>[string] = {
			record_label: 'record.name',
			label: ['name'],
			fields: {
				name: { kind: 'text' },
				fingerprint: { kind: 'text', hidden: true },
				doc: { kind: 'file', accept: ['*/*'], max: '20MiB' },
				raw: { kind: 'json' },
				'a.b': { kind: 'int' }
			},
			relations: { owner: { targets: ['people'] } }
		};
		assert.deepEqual(listRequest({ docs: ex }, 'docs', {}, ['name']), {
			docs: { fields: ['name', 'owner'] }
		});
		assert.deepEqual(listRequest(undefined, 'docs', {}, ['doc']), { docs: {} });
		assert.deepEqual(listRequest({ docs: ex }, 'docs', {}, ['created_at', 'doc']), {
			docs: { fields: ['name', 'owner', 'created_at', 'doc'] }
		});
		assert.deepEqual(listRequest({ docs: ex }, 'docs', {}, ['name', 'fingerprint']), {
			docs: { fields: ['name', 'owner', 'fingerprint'] }
		});
	})
);

it.effect('a FK column reads its target label in the page read and shows it beside the id', () =>
	Effect.sync(() => {
		const cat: NonNullable<KindsHost['catalog']> = {
			orders: {
				record_label: 'record.no',
				label: ['no'],
				fields: { no: { kind: 'text' }, customer: { kind: 'text' }, spec: { kind: 'json' } },
				relations: { customer: { targets: ['customers'] }, arc: { targets: ['a', 'b'] } },
				layers: ['customer']
			},
			customers: {
				record_label:
					"[record.name != null ? string(record.name) : '', record.code != null ? string(record.code) : '', record.secret != null ? string(record.secret) : ''].filter(part, part != '').join(' · ')",
				label: ['name', 'code', 'secret'],
				fields: { name: { kind: 'text' }, code: { kind: 'text' } }
			}
		};
		const fields = ['no', 'customer', 'arc'];
		// an arc keeps the plain read
		assert.deepEqual(listRequest(cat, 'orders', {}, ['no', 'arc']), { orders: { fields } });
		assert.deepEqual(listRequest(cat, 'orders', {}, ['no', 'customer']), {
			orders: { fields },
			'orders.customer': { fields: ['name', 'code'] }
		});
		// an authored cell keeps the id
		assert.deepEqual(listRequest(cat, 'orders', {}, ['customer'], []), { orders: { fields } });
		// a relation its root does not declare as a layer keeps the id
		const undeclared = { ...cat, orders: { ...required(cat.orders), layers: [] } };
		assert.deepEqual(listRequest(undeclared, 'orders', {}, ['customer']), { orders: { fields } });
		assert.equal(
			required(unref(undeclared, 'orders', ['customer'], [{ id: 'o3', customer: 'c3' }])[0])
				.customer,
			'c3'
		);
		const projected = unref(
			cat,
			'orders',
			['customer'],
			[
				{ id: 'o1', customer: { id: 'c1', name: 'Acme', code: 'A1' } },
				{ id: 'o2', customer: null }
			]
		);
		const a = required(projected[0]),
			b = required(projected[1]);
		assert.equal(a.customer, 'c1');
		assert.deepEqual(refOf(a, 'customer'), { of: 'customers', text: 'c1' });
		assert.equal(b.customer, null);
		assert.equal(refOf(b, 'customer'), undefined);
	})
);

it.effect('Chart reads aggregate rows', () =>
	Effect.sync(() => {
		const agg = [
			{ key: { region: 'N', stage: 'won' }, sum: { amount: '10' } },
			{ key: { region: 'N', stage: 'lost' }, sum: { amount: '5' } },
			{ key: { region: 'S', stage: 'won' }, sum: { amount: '2.5' } }
		];
		const flattened = flat(required(agg[0])),
			amount = flattened['sum.amount'];
		assert.ok(typeof amount === 'string');
		assert.deepEqual(
			{ ...flattened, 'sum.amount': Number(String(amount)) },
			{ region: 'N', stage: 'won', 'sum.amount': 10 }
		);
		assert.deepEqual(
			series({ rows: [{ key: { month: '2026-01-01' }, count: 4 }], next: null }, 'month', [
				'count'
			]),
			[{ month: '2026-01-01', count: 4 }]
		);
	})
);

it.effect('run progress and returned files', () =>
	Effect.sync(() => {
		assert.equal(progressOf({ progress: { done: 1, total: 4 } }), 0.25);
		assert.equal(progressOf({ progress: 50 }), 0.5);
		assert.equal(progressOf({}), null);
		const f = { id: 'f1', name: 'bank.csv', mime: 'text/csv' };
		assert.deepEqual(runFiles({ result: { files: [f], count: 1 } }), [f]);
		assert.deepEqual(runFiles({ result: f }), [f]);
	})
);

it.live(
	'the record timeline reads history as checkpoints and marks revisions that no longer fit the schema',
	() =>
		Effect.gen(function* () {
			const { checkpoints } = yield* browser(() => import('../src/record/history.ts'));
			const history: readonly HistoryEntry[] = [
				{
					revision: 2,
					schema_version: 'prior-schema',
					at: '2026-09-02T00:00:00.000Z',
					actor: { kind: 'system', id: 'run1' },
					cause: 'restored',
					restored_from: 1,
					approval: { request: 'r1', state: 'Rejected' },
					changed: { status: 'done', updated_at: 'x', revision: 2 },
					incompatible: ['price'],
					valid: false
				},
				{
					revision: 1,
					schema_version: 'prior-schema',
					at: '2026-09-01T00:00:00.000Z',
					actor: { kind: 'member', id: 'u1' },
					restored_from: null,
					approval: null,
					changed: { title: 'Paint', id: 'j1' },
					cause: 'direct',
					incompatible: [],
					valid: true
				},
				{
					revision: 3,
					schema_version: 'current-schema',
					at: null,
					actor: null,
					restored_from: null,
					approval: null,
					changed: {},
					cause: 'direct',
					incompatible: [],
					valid: true
				}
			];
			assert.deepEqual(checkpoints(history), [
				{
					revision: 1,
					at: '2026-09-01T00:00:00.000Z',
					actor: { kind: 'member', id: 'u1' },
					fields: ['title'],
					restored_from: null,
					approval: null,
					valid: true
				},
				{
					revision: 2,
					at: '2026-09-02T00:00:00.000Z',
					actor: { kind: 'system', id: 'run1' },
					fields: ['status'],
					cause: 'restored',
					restored_from: 1,
					approval: { request: 'r1', state: 'Rejected' },
					valid: false
				},
				{
					revision: 3,
					at: null,
					actor: null,
					fields: [],
					restored_from: null,
					approval: null,
					valid: true
				}
			]);
			assert.deepEqual(checkpoints([]), []);
		})
);
