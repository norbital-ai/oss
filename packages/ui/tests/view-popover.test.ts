import { required, textOf } from './view-fixture.ts';
import { element } from './elements.ts';
import {
	viewFixture,
	fixtureEffect,
	jsonRecord,
	type ReadOptions,
	type ViewScript,
	browser
} from './view-fixture.ts';
import { Effect, Schema } from 'effect';
import { reactive } from './kit-state.svelte.js';
// The view popover (rule 16b, P34): typed rows that lower to a decodable `Where`, strict URL state, one combined
// filter-and-sort popover on Table and Board.
import './dom.ts';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import type { ViewBolt, Json } from '../src/client/contract.ts';
import type { Row } from '../src/model/types.ts';
import type { Value } from '@norbital-ai/std/kind';
import type { KindsHost } from '../src/kinds/context.ts';
import type { Offer, RawArg, Node, Op, Resolved, SortKey } from '../src/filter/filter.ts';
import { resolve, taggedArg, varError, variableOf, variablesFor } from '../src/filter/filter.ts';
import type { ViewHarnessProps } from './view-harness.svelte';
import { it, vi } from '@effect/vitest';
import {
	fromWhere,
	matches,
	nodeText,
	orderKeys,
	orderOf,
	orderText,
	parseOrder,
	sortable,
	sortRows,
	sortText,
	toWhere
} from '../src/filter/filter.ts';
import { likePattern } from '../src/kinds/kind.ts';
import { listRequest, MANY_SHOWN, unref } from '../src/relations/select.ts';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const { default: Board } = await import('../src/board/Board.svelte');
const { default: Table } = await import('../src/table/Table.svelte');

const catalog = {
	jobs: {
		label: ['title'],
		fields: {
			title: { kind: 'text' },
			hours: { kind: 'number', optional: true },
			scheduled_on: { kind: 'date', optional: true },
			due_on: { kind: 'date', optional: true },
			status: {
				kind: 'state',
				initial: 'scheduled',
				states: { scheduled: { to: ['done'] }, done: {} }
			},
			tags: { kind: 'text', many: true },
			meta: { kind: 'json', optional: true },
			window: { kind: 'period', of: 'date', optional: true },
			salary: { kind: 'money' }
		},
		relations: {
			assignee: { targets: ['sys_user'], optional: true },
			account: { targets: ['accounts'] },
			subject: { targets: ['accounts', 'sys_user'] }
		},
		many: ['lines'],
		masked: ['salary']
	},
	accounts: {
		label: ['name'],
		search: ['name'],
		semantic: true,
		fields: { name: { kind: 'text' }, spot: { kind: 'point', optional: true } },
		relations: { owner: { targets: ['sys_user'] } },
		many: ['invoices']
	},
	invoices: {
		label: [],
		fields: { status: { kind: 'enum', values: ['paid', 'unpaid'] } },
		relations: { account: { targets: ['accounts'], inverse: 'invoices' } }
	},
	sys_user: { label: ['name'], fields: { name: { kind: 'text' } } },
	job_lines: {
		label: [],
		fields: { qty: { kind: 'int' }, amount: { kind: 'money' } },
		relations: { job: { targets: ['jobs'], inverse: 'lines' } }
	}
} satisfies NonNullable<KindsHost['catalog']>;
const nodesOf = (...args: Parameters<typeof fromWhere>): Node[] => {
	const nodes = fromWhere(...args);
	assert.ok(nodes);
	return nodes;
};
type DescribedFilter = Effect.Success<ReturnType<NonNullable<ViewBolt['describe']>>>;
const cond = (path: string, op: Op, arg: RawArg | null = null): Extract<Node, { t: 'cond' }> => ({
	t: 'cond',
	path,
	op,
	arg: arg === null ? null : taggedArg(arg)
});

it.effect(
	'a related record\'s own related records are a row: "jobs whose account has an unpaid invoice", and its count',
	() =>
		Effect.sync(() => {
			const some = { account: { is: { invoices: { some: { status: { eq: 'unpaid' } } } } } };
			const rows = nodesOf(catalog, 'jobs', some);
			assert.deepEqual(rows, [
				{
					t: 'many',
					rel: 'account.invoices',
					q: 'some',
					of: [cond('status', 'eq', { lit: 'unpaid' })]
				}
			]);
			assert.deepEqual(toWhere(catalog, 'jobs', required(rows[0])), some);
			const count = { account: { is: { invoices: { count: { gte: 1 } } } } };
			const n = nodesOf(catalog, 'jobs', count);
			assert.deepEqual(toWhere(catalog, 'jobs', required(n[0])), count);
			assert.match(
				nodeText(catalog, 'jobs', required(rows[0]), (x) => x),
				/^account › invoices/i
			);
			assert.equal(
				fromWhere(catalog, 'jobs', { account: { is: { owner: { is: { name: { eq: 'x' } } } } } })
					?.length,
				1,
				'two one-relation hops still read'
			);
		})
);

it.effect(
	'the search index and meaning are rows: through a relation, back to the same Where, refused where undeclared',
	() =>
		Effect.sync(() => {
			const filters: readonly Json[] = [
				{ account: { is: { $search: 'pine grove' } } },
				{ account: { is: { $similar: 'water leak' } } }
			];
			for (const w of filters) {
				const rows = nodesOf(catalog, 'jobs', w);
				assert.equal(rows.length, 1, JSON.stringify(w));
				assert.deepEqual(toWhere(catalog, 'jobs', required(rows[0])), w);
			}
			assert.deepEqual(fromWhere(catalog, 'jobs', { account: { is: { $search: 'pine' } } }), [
				cond('account.$search', 'search', { lit: 'pine' })
			]);
			assert.match(
				nodeText(
					catalog,
					'jobs',
					cond('account.$similar', 'similar', { lit: 'water leak' }),
					(x) => x,
					undefined,
					() => 'is about'
				),
				/^account › Topic is about water leak$/i
			);
			assert.equal(
				fromWhere(catalog, 'jobs', { $search: 'pine' }),
				null,
				'jobs declares no search'
			);
			assert.equal(
				fromWhere(catalog, 'jobs', { account: { is: { $search: '' } } }),
				null,
				'empty text'
			);
		})
);

it.effect(
	'contains is loose: the words in order with anything between, both ways; a described near and a nearest sort round-trip',
	() =>
		Effect.sync(() => {
			// "1f pine grove" matches "1F Pine Grove #17-30" and "1F-Pine  Grove": the engine's `%1f%pine%grove%`
			assert.equal(likePattern('1f pine  grove'), '%1f%pine%grove%');
			const w = { account: { is: { name: { like: '%1f%pine%grove%' } } } };
			const rows = nodesOf(catalog, 'jobs', w);
			assert.deepEqual(rows, [cond('account.name', 'like', { lit: '1f pine grove' })]);
			assert.deepEqual(toWhere(catalog, 'jobs', required(rows[0])), w);
			assert.equal(
				matches({ name: '1F-Pine  Grove #17-30' }, cond('name', 'like', { lit: '1f pine grove' })),
				true
			);
			assert.equal(
				matches({ name: 'Grove Pine 1F' }, cond('name', 'like', { lit: '1f pine grove' })),
				false
			);
			// within metres of a point: a row with its words, lowered back unchanged
			const near = { account: { is: { spot: { near: [{ lat: 1.3291, lng: 103.769 }, 1500] } } } };
			const n = nodesOf(catalog, 'jobs', near);
			const nearest = required(n[0]);
			assert.ok(nearest.t === 'cond');
			assert.equal(nearest.op, 'near');
			assert.deepEqual(toWhere(catalog, 'jobs', required(n[0])), near);
			assert.match(
				nodeText(catalog, 'jobs', required(n[0]), (x) => x),
				/within 1\.5 km of 1\.3291, 103\.7690/
			);
			assert.equal(
				fromWhere(catalog, 'jobs', { title: { near: [{ lat: 1, lng: 1 }, 5] } }),
				null,
				'near needs a point'
			);
			// nearest first: through the URL text and back to the OrderBy
			const order = { account: { spot: { near: { lat: 1.3291, lng: 103.769 } } } };
			const keys = orderKeys(order);
			assert.deepEqual(keys, [
				{ field: 'account.spot', dir: 'asc', near: { lat: 1.3291, lng: 103.769 } }
			]);
			assert.deepEqual(parseOrder(orderText(keys), sortable(catalog.jobs, true, catalog)), {
				keys,
				dropped: 0
			});
			assert.deepEqual(orderOf(keys), [order]);
			assert.match(
				sortText(catalog, 'jobs', required(keys[0]), (x) => x),
				/nearest to 1\.3291, 103\.7690/
			);
		})
);

it.effect(
	'every grammar element is a row that lowers to a Where and parses back to the same row',
	() =>
		Effect.sync(() => {
			const rows: Node[] = [
				cond('title', 'like', { lit: 'a_b%' }),
				cond('status', 'in', { list: ['scheduled', 'done'] }),
				cond('assignee', 'eq', { lit: 'u1' }),
				cond('assignee', 'eq', { var: 'requestor.id' }),
				cond('assignee', 'isNull'),
				cond('account.owner.name', 'like', { lit: 'bo' }),
				cond('subject:accounts', 'in', { list: ['a1', 'a2'] }),
				cond('scheduled_on', 'during', {
					range: [{ var: 'startOfWeek(today)' }, { var: 'startOfWeek(today) + weeks(1)' }]
				}),
				cond('scheduled_on', 'during', {
					range: [{ var: 'today - days(7)' }, { var: 'today + days(1)' }]
				}),
				cond('scheduled_on', 'gte', { var: 'startOfMonth(today) - months(1)' }),
				cond('scheduled_on', 'lt', { var: 'today - days(7)' }),
				cond('scheduled_on', 'lt', { field: 'due_on' }),
				cond('tags', 'hasAll', { list: ['a', 'b'] }),
				cond('meta', 'contains', { lit: { a: 1 } }),
				cond('window', 'contains', { var: 'today' }),
				{ t: 'many', rel: 'lines', q: 'some', of: [cond('qty', 'gt', { lit: 2 })] },
				{ t: 'many', rel: 'lines', q: 'none', of: [] },
				{ t: 'many', rel: 'lines', q: 'count', of: [], op: 'gte', n: 3 },
				{ t: 'many', rel: 'lines', q: 'sum', of: [], op: 'gt', n: 100, field: 'amount' },
				{
					t: 'group',
					join: 'or',
					of: [cond('hours', 'gt', { lit: 3 }), cond('status', 'eq', { lit: 'done' })]
				},
				{ t: 'group', join: 'and', not: true, of: [cond('title', 'like', { lit: 'x' })] }
			];
			for (const n of rows) {
				const w = toWhere(catalog, 'jobs', n);
				assert.ok(w !== null, JSON.stringify(n));
				assert.deepEqual(
					fromWhere(
						catalog,
						'jobs',
						Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(JSON.stringify(w))
					),
					[n],
					JSON.stringify(w)
				);
			}
			// the shapes decode expects: escaped like, a record in the `is` form, a variable on the FK, calendar bounds, two hops
			assert.equal(likePattern('a_b%\\'), '%a\\_b\\%\\\\%');
			assert.deepEqual(toWhere(catalog, 'jobs', required(rows[2])), {
				assignee: { is: { id: { eq: 'u1' } } }
			});
			assert.deepEqual(toWhere(catalog, 'jobs', required(rows[3])), {
				assignee: { eq: { var: 'requestor.id' } }
			});
			assert.deepEqual(toWhere(catalog, 'jobs', required(rows[6])), {
				subject: { accounts: { is: { id: { in: ['a1', 'a2'] } } } }
			});
			assert.deepEqual(toWhere(catalog, 'jobs', required(rows[7])), {
				scheduled_on: {
					gte: { var: 'startOfWeek(today)' },
					lt: { var: 'startOfWeek(today) + weeks(1)' }
				}
			});
			assert.deepEqual(toWhere(catalog, 'jobs', required(rows[5])), {
				account: { is: { owner: { is: { name: { like: '%bo%' } } } } }
			});
			// a variable's one spelling: the URL keeps it, a read sends its literal at the page's clock
			assert.deepEqual(toWhere(catalog, 'jobs', required(rows[10])), {
				scheduled_on: { lt: { var: 'today - days(7)' } }
			});
			const clock = { today: '2026-01-02', now: '2026-01-02T03:04:05.000Z', zone: 'UTC' };
			assert.deepEqual(toWhere(catalog, 'jobs', required(rows[10]), clock), {
				scheduled_on: { lt: '2025-12-26' }
			});
			assert.deepEqual(toWhere(catalog, 'jobs', required(rows[11])), {
				scheduled_on: { lt: { field: 'due_on' } }
			});
			assert.deepEqual(toWhere(catalog, 'jobs', required(rows[14])), {
				window: { contains: { var: 'today' } }
			});
			const formerOrWrong: readonly Json[] = [
				{ today: '' },
				{ clock: 'today' },
				{ startOf: 'week' },
				{ var: 'requestor.email' }
			];
			for (const old of formerOrWrong)
				assert.equal(fromWhere(catalog, 'jobs', { scheduled_on: { lt: old } }), null);
			assert.deepEqual(toWhere(catalog, 'jobs', required(rows[18])), {
				lines: { sum: { of: 'amount', gt: 100 } }
			});
			// an incomplete row is shown but not sent; a masked field, an unknown one and a wrong-kind literal never parse
			assert.equal(toWhere(catalog, 'jobs', cond('title', 'eq')), null);
			const invalid: readonly Json[] = [
				{ salary: { gt: 1 } },
				{ bogus: { eq: 1 } },
				{ hours: { eq: 'abc' } },
				{ status: { eq: 'nope' } },
				{ status: {} },
				{ not: {} },
				{ hours: { isNull: 'yes' } }
			];
			for (const bad of invalid)
				assert.equal(fromWhere(catalog, 'jobs', bad), null, JSON.stringify(bad));
		})
);

it.effect('sort: nulls last ascending and first descending', () =>
	Effect.sync(() => {
		const rows = [
			{ id: 'a', n: 2 },
			{ id: 'b', n: null },
			{ id: 'c', n: 1 }
		];
		assert.deepEqual(
			sortRows(rows, [{ field: 'n', dir: 'asc' }]).map((r) => r.id),
			['c', 'a', 'b']
		);
		assert.deepEqual(
			sortRows(rows, [{ field: 'n', dir: 'desc' }]).map((r) => r.id),
			['b', 'a', 'c']
		);
	})
);

it.effect(
	'sort: related keys — one hop through unmasked one-relations into read models; keys nest, and round-trip through the URL',
	() =>
		Effect.sync(() => {
			const s = sortable(catalog.jobs, true, catalog);
			assert.ok(s.includes('account.name') && s.includes('assignee.name'), s.join());
			assert.ok(!s.includes('account.owner'), 'a target FK is no sort key'); // it would order by an id
			assert.ok(!s.some((f) => f.startsWith('subject')), 'an arc is no hop');
			assert.ok(
				!sortable({ ...catalog.jobs, masked: ['account'] }, true, catalog).includes('account.name'),
				'a masked FK is no hop'
			);
			assert.ok(
				!sortable(catalog.jobs, true).some((f) => f.includes('.')),
				'no catalog, no related keys'
			);
			const keys: SortKey[] = [
				{ field: 'account.name', dir: 'desc' },
				{ field: 'title', dir: 'asc' }
			];
			assert.deepEqual(orderOf(keys), [{ account: { name: 'desc' } }, { title: 'asc' }]);
			assert.deepEqual(orderKeys(orderOf(keys)), keys);
			assert.equal(orderText(keys), 'account.name:desc,title:asc');
			assert.deepEqual(parseOrder(orderText(keys), s), { keys, dropped: 0 });
			assert.deepEqual(parseOrder('account.secret:asc', s), { keys: [], dropped: 1 });
			const rows = [
				{ id: 'a', account: { name: 'b' } },
				{ id: 'b', account: { name: 'a' } },
				{ id: 'c', account: null }
			];
			assert.deepEqual(
				sortRows(rows, [{ field: 'account.name', dir: 'asc' }]).map((r) => r.id),
				['b', 'a', 'c']
			);
		})
);

// ── mounted views over a scripted bolt ──
/** The condition catalogue the scripted host serves (`filter.options`), for the fixture catalog above. */
const offers = (c: string): readonly Offer[] =>
	c !== 'jobs'
		? []
		: [
				{
					label: 'Title',
					path: [{ k: 'field', name: 'title' }],
					op: 'like',
					opLabel: 'contains',
					kind: 'text'
				},
				{
					label: 'Title',
					path: [{ k: 'field', name: 'title' }],
					op: 'eq',
					opLabel: 'is',
					kind: 'text'
				},
				{
					label: 'Hours',
					path: [{ k: 'field', name: 'hours' }],
					op: 'eq',
					opLabel: 'is',
					kind: 'number'
				},
				{
					label: 'Hours',
					path: [{ k: 'field', name: 'hours' }],
					op: 'gt',
					opLabel: 'more than',
					kind: 'number'
				},
				{
					label: 'Scheduled on',
					path: [{ k: 'field', name: 'scheduled_on' }],
					op: 'during',
					opLabel: 'is within',
					kind: 'date',
					values: [
						{
							label: 'this week',
							arg: {
								range: [{ var: 'startOfWeek(today)' }, { var: 'startOfWeek(today) + weeks(1)' }]
							}
						}
					]
				},
				{
					label: 'Status',
					path: [{ k: 'field', name: 'status' }],
					op: 'eq',
					opLabel: 'is',
					kind: 'state'
				},
				{
					label: 'Status',
					path: [{ k: 'field', name: 'status' }],
					op: 'in',
					opLabel: 'is any of',
					kind: 'state'
				},
				{
					label: 'Tags',
					path: [{ k: 'field', name: 'tags' }],
					op: 'hasAll',
					opLabel: 'has all of',
					kind: 'text'
				},
				{
					label: 'Tags',
					path: [{ k: 'field', name: 'tags' }],
					op: 'isEmpty',
					opLabel: 'is empty',
					kind: 'text'
				},
				{
					label: 'Assignee',
					path: [{ k: 'field', name: 'assignee' }],
					op: 'eq',
					opLabel: 'is',
					kind: 'record'
				},
				{
					label: 'Assignee › Name',
					path: [
						{ k: 'is', rel: 'assignee' },
						{ k: 'field', name: 'name' }
					],
					op: 'like',
					opLabel: 'contains',
					kind: 'text'
				},
				{
					label: 'Lines (any) › Qty',
					path: [
						{ k: 'some', rel: 'lines' },
						{ k: 'field', name: 'qty' }
					],
					op: 'eq',
					opLabel: 'is',
					kind: 'int'
				},
				{
					label: 'Lines (any) › Qty',
					path: [
						{ k: 'some', rel: 'lines' },
						{ k: 'field', name: 'qty' }
					],
					op: 'gt',
					opLabel: 'more than',
					kind: 'int'
				},
				{
					label: 'Lines (all) › Qty',
					path: [
						{ k: 'every', rel: 'lines' },
						{ k: 'field', name: 'qty' }
					],
					op: 'gt',
					opLabel: 'more than',
					kind: 'int'
				},
				{
					label: 'Lines (none) › Qty',
					path: [
						{ k: 'none', rel: 'lines' },
						{ k: 'field', name: 'qty' }
					],
					op: 'gt',
					opLabel: 'more than',
					kind: 'int'
				},
				{
					label: 'Lines › count',
					path: [{ k: 'count', rel: 'lines' }],
					op: 'eq',
					opLabel: 'is',
					kind: 'count'
				},
				{
					label: 'Lines › count',
					path: [{ k: 'count', rel: 'lines' }],
					op: 'gte',
					opLabel: 'at least',
					kind: 'count'
				},
				{
					label: 'Lines › total amount',
					path: [{ k: 'agg', rel: 'lines', fn: 'sum', of: 'amount' }],
					op: 'gt',
					opLabel: 'more than',
					kind: 'money'
				}
			];
async function scripted(extra: Partial<ViewScript> = {}) {
	const reads: { c: string; o: ReadOptions }[] = [];
	const rows = [{ id: 'j1', title: 'One', hours: 2, status: 'done' }];
	const fixture = await viewFixture({
		read: (c, o) => {
			reads.push({ c, o });
			return { rows, next: null };
		},
		get: (_c, id) => ({ id, title: 'One', status: 'done' }),
		aggregate: (_c, o) =>
			o.by
				? {
						rows: [
							{ key: { status: 'scheduled' }, count: 0 },
							{ key: { status: 'done' }, count: 1 }
						],
						next: null
					}
				: [{ count: 1 }],
		history: () => ({ rows: [], next: null }),
		options: (c) => Effect.succeed({ fields: offers(c) }),
		...extra
	});
	return {
		...fixture,
		reads,
		last: () => {
			const last = reads.filter((r) => r.c === 'jobs').at(-1);
			assert.ok(last);
			return last.o;
		}
	};
}
async function show(fixture: ViewHarnessProps, url = '/') {
	history.replaceState(null, '', url);
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: fixture });
	await vi.waitFor(() => {
		flushSync();
		if (fixture.part === 'table') element(target, '[data-table-wide] tbody tr:not([aria-hidden])');
		if (fixture.part === 'board') {
			const lanes = [...target.querySelectorAll<HTMLElement>('[data-lane]')];
			assert.ok(lanes.length > 0, 'the board has loaded its lanes');
			for (const lane of lanes)
				assert.ok(
					lane.querySelector('[data-board-card], [data-lane-empty]'),
					`lane ${lane.dataset['lane']} has loaded its first page`
				);
		}
	});
	return {
		target,
		app,
		done: async () => {
			await unmount(app);
			target.remove();
		}
	};
}
const settle = async () => {
	for (let i = 0; i < 3; i++) {
		await tick();
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
};

it.live('filter metadata loads on opening, retries a failure on reopening, then is reused', () =>
	Effect.gen(function* () {
		let calls = 0;
		const s = yield* browser(() =>
			scripted({
				options: (model) =>
					fixtureEffect(() => {
						if (++calls === 1) throw new Error('Temporary metadata failure');
						return { fields: offers(model) };
					})
			})
		);
		const v = yield* browser(() =>
			show(
				{
					part: 'table',
					view: Table,
					props: { of: 'jobs', columns: ['title'] },
					bolt: s.bolt,
					catalog: catalog
				},
				'/'
			)
		);
		const toggle = () => {
			element<HTMLElement>(document, '[data-view-trigger]').click();
			return browser(() => settle());
		};
		assert.equal(calls, 0, 'nothing loads before the popover opens');
		yield* toggle();
		assert.equal(calls, 1);
		yield* toggle();
		yield* toggle();
		assert.equal(calls, 2, 'reopening retries the failed request');
		yield* toggle();
		yield* toggle();
		assert.equal(calls, 2, 'a loaded catalogue is reused');
		yield* browser(v.done);
	})
);

it.live('Table: initialFilter seeds clearable rows, and a cleared choice survives a reload', () =>
	Effect.gen(function* () {
		const s = yield* browser(() => scripted());
		const props: import('../src/table/Table.svelte').TableProps = {
			of: 'jobs',
			columns: ['title'],
			initialFilter: { status: { eq: 'scheduled' } }
		};
		let v = yield* browser(() =>
			show({ part: 'table', view: Table, props: props, bolt: s.bolt, catalog: catalog }, '/')
		);
		assert.deepEqual(s.last().where, { status: { eq: 'scheduled' } });
		element<HTMLElement>(document, '[data-view-trigger]').click();
		yield* browser(() => settle());
		element<HTMLElement>(document, '[data-clear]').click();
		yield* browser(() =>
			vi.waitFor(() => {
				flushSync();
				assert.equal(s.last().where, undefined);
			})
		);
		const url = location.pathname + location.search;
		assert.match(url, /jobs\.where=%7B%7D/);
		yield* browser(v.done);
		v = yield* browser(() =>
			show({ part: 'table', view: Table, props: props, bolt: s.bolt, catalog: catalog }, url)
		);
		assert.equal(s.last().where, undefined);
		yield* browser(v.done);
	})
);

it.live(
	'Table: a link drops bad clauses and keys with one notice and applies the rest; a relative date sends literal bounds and follows the page day clock',
	() =>
		Effect.gen(function* () {
			const units: ('day' | 'hour' | 'minute' | undefined)[] = [];
			const day = reactive({ today: '2026-01-02', now: '2026-01-02T03:04:05.000Z' });
			const s = yield* browser(() => scripted());
			s.bolt.clock = (unit) => {
				units.push(unit);
				return day;
			};
			const w = encodeURIComponent(
				JSON.stringify({
					and: [
						{ status: { eq: 'done' } },
						{ bogus: { eq: 1 } },
						{ hours: { eq: 'abc' } },
						{ scheduled_on: { gte: { var: 'today - days(6)' }, lt: { var: 'today + days(1)' } } }
					]
				})
			);
			const v = yield* browser(() =>
				show(
					{
						part: 'table',
						view: Table,
						props: { of: 'jobs', columns: ['title', 'hours'] },
						bolt: s.bolt,
						catalog
					},
					`/?jobs.where=${w}&jobs.order=hours:desc,meta:asc`
				)
			);
			assert.ok(units.includes('day'));
			const bounds = JSON.stringify(s.last().where);
			assert.match(bounds, /"status":\{"eq":"done"\}/);
			assert.doesNotMatch(bounds, /bogus|abc/);
			assert.deepEqual(s.last().orderBy, [{ hours: 'desc' }]);
			assert.equal(document.querySelectorAll<HTMLElement>('[data-view-notice]').length, 1);
			assert.equal(document.querySelector('[data-read=error]'), null);
			assert.match(bounds, /2025-12-27/);
			assert.match(bounds, /2026-01-03/);
			assert.doesNotMatch(bounds, /"var"/);
			day.today = '2026-01-03';
			yield* browser(settle);
			const next = JSON.stringify(s.last().where);
			assert.match(next, /2025-12-28/);
			assert.match(next, /2026-01-04/);
			yield* browser(v.done);
		})
);

it.effect(
	'variables: a value position offers the requestor, today and now by its kind; the rows keep them',
	() =>
		Effect.sync(() => {
			const rel = required(resolve(catalog, 'jobs', 'assignee'));
			const day = required(resolve(catalog, 'jobs', 'scheduled_on'));
			const names = (r: Resolved, op: Op) => variablesFor(r, op).map((v) => v.name);
			assert.deepEqual(names(rel, 'eq'), ['requestor', 'requestor.party']);
			assert.deepEqual(names(rel, 'in'), []);
			assert.deepEqual(names(day, 'lt'), [
				'today',
				'today - days(7)',
				'startOfWeek(today)',
				'startOfMonth(today)'
			]);
			assert.deepEqual(names(required(resolve(catalog, 'jobs', 'hours')), 'eq'), []);
			const email: Resolved = {
				leaf: 'field',
				kind: { kind: 'text', format: 'email' },
				nullable: false,
				label: 'Email'
			};
			assert.deepEqual(variablesFor(email, 'eq'), [
				{ name: 'requestor.email', arg: { _tag: 'var', var: 'requestor.email' } }
			]);
			assert.equal(variableOf(taggedArg({ var: 'today - days(7)' })), 'today - days(7)');
			assert.equal(variableOf(taggedArg({ var: 'requestor.id' })), 'requestor');
			assert.equal(variableOf(taggedArg({ lit: 'x' })), undefined);
			// an expression is typed against its position: an email is no date
			assert.equal(varError(day, 'lt', 'today - days(1)'), undefined);
			assert.match(varError(day, 'lt', 'requestor.email') ?? '', /not a date/);
			const rows = nodesOf(catalog, 'jobs', { assignee: { eq: { var: 'requestor.id' } } });
			assert.deepEqual(rows, [cond('assignee', 'eq', { var: 'requestor.id' })]);
		})
);

// ── lists: relation labels in the same read, the default and a custom cell, lanes that load as they scroll ──
const relCatalog: NonNullable<KindsHost['catalog']> = {
	jobs: {
		label: ['title'],
		fields: { title: { kind: 'text' }, done: { kind: 'bool' } },
		relations: { account: { targets: ['accounts'] } },
		many: ['lines'],
		layers: ['account', 'lines']
	},
	accounts: { label: ['name'], fields: { name: { kind: 'text' } } },
	job_lines: {
		label: ['name'],
		fields: { name: { kind: 'text' } },
		relations: { job: { targets: ['jobs'], inverse: 'lines' } }
	}
};
const relRows = [
	{
		id: 'j1',
		title: 'One',
		done: true,
		account: { id: 'a1', name: 'Acme' },
		lines: [
			{ id: 'l1', name: 'Pipe' },
			{ id: 'l2', name: 'Valve' },
			{ id: 'l3', name: 'Seal' }
		]
	}
];

it.effect(
	'listRequest/unref: a one- and a many-relation read their labels in the one statement; the row keeps ids and $refs',
	() =>
		Effect.sync(() => {
			assert.deepEqual(listRequest(relCatalog, 'jobs', {}, ['title', 'account', 'lines']), {
				jobs: { fields: ['title', 'done', 'account'] },
				'jobs.account': { fields: ['name'] },
				'jobs.lines': { fields: ['name'], limit: MANY_SHOWN + 1 }
			});
			const r = required(unref(relCatalog, 'jobs', ['account', 'lines'], relRows)[0]);
			const refs = jsonRecord(r.$refs),
				lines = jsonRecord(refs.lines);
			assert.equal(r.account, 'a1');
			assert.deepEqual(r.lines, ['l1', 'l2', 'l3']);
			assert.deepEqual(refs.account, { of: 'accounts', text: 'Acme' });
			assert.deepEqual(
				Schema.decodeUnknownSync(Schema.Array(Schema.Json))(lines.items).map(
					(i) => jsonRecord(i).text
				),
				['Pipe', 'Valve', 'Seal']
			);
			assert.equal(lines.of, 'job_lines');
			const many = required(
				unref(
					relCatalog,
					'jobs',
					['lines'],
					[
						{
							id: 'j2',
							lines: Array.from({ length: MANY_SHOWN + 1 }, (_, i) => ({
								id: `l${i}`,
								name: `L${i}`
							}))
						}
					]
				)[0]
			);
			const manyRefs = jsonRecord(jsonRecord(many.$refs).lines);
			assert.equal(
				Schema.decodeUnknownSync(Schema.Array(Schema.Json))(manyRefs.items).length,
				MANY_SHOWN
			);
			assert.equal(manyRefs.more, true);
		})
);

it.live(
	'Board: each lane reads its first page by its condition; nearing the lane end reads the next by its cursor',
	() =>
		Effect.gen(function* () {
			const previousObserver = globalThis.IntersectionObserver;
			const seen: FixtureObserver[] = [];
			class FixtureObserver implements IntersectionObserver {
				readonly root = null;
				readonly rootMargin = '0px';
				readonly scrollMargin = '0px';
				readonly thresholds = [0];
				readonly delay = 0;
				readonly trackVisibility = false;
				el: Element | null = null;
				readonly callback: IntersectionObserverCallback;
				constructor(callback: IntersectionObserverCallback) {
					this.callback = callback;
					seen.push(this);
				}
				observe(el: Element) {
					this.el = el;
				}
				unobserve(el: Element) {
					if (this.el === el) this.el = null;
				}
				disconnect() {
					this.el = null;
				}
				takeRecords(): IntersectionObserverEntry[] {
					return [];
				}
				trigger() {
					const target = required(this.el),
						rectangle = target.getBoundingClientRect();
					this.callback(
						[
							{
								isIntersecting: true,
								intersectionRatio: 1,
								target,
								time: 0,
								rootBounds: null,
								boundingClientRect: rectangle,
								intersectionRect: rectangle
							}
						],
						this
					);
				}
			}
			globalThis.IntersectionObserver = FixtureObserver;
			// page 1 answers a cursor; page 2 is read live as every row up to it (pageRead), and is the lane's last
			const s = yield* browser(() =>
				scripted({
					read: (c, o) => {
						s.reads.push({ c, o });
						const rows = Array.from({ length: o.limit ?? 1 }, (_, i) => ({
							id: `${JSON.stringify(o.where)}-${i}`,
							title: 'x'
						}));
						return { rows, next: (o.limit ?? 1) >= 2 ? null : 'c1' };
					}
				})
			);
			const v = yield* browser(() =>
				show(
					{
						part: 'board',
						view: Board,
						props: { of: 'jobs', by: 'status', card: ['title'], pageSize: 1 },
						bolt: s.bolt,
						catalog: catalog
					},
					'/'
				)
			);
			const lane = element<HTMLElement>(document, '[data-lane=\'"done"\']');
			assert.ok(
				s.reads.some(
					(r) =>
						JSON.stringify(r.o.where) === JSON.stringify({ status: { eq: 'done' } }) &&
						r.o.limit === 1
				),
				'a lane reads by its lane condition, one page'
			);
			const io = yield* browser(() =>
				vi.waitFor(() => {
					flushSync();
					element(lane, '[data-lane-more]');
					return required(seen.find((x) => x.el !== null && lane.contains(x.el)));
				})
			);
			io.trigger();
			yield* browser(() =>
				vi.waitFor(() => {
					flushSync();
					assert.ok(
						s.reads.some(
							(r) =>
								JSON.stringify(r.o.where) === JSON.stringify({ status: { eq: 'done' } }) &&
								r.o.limit === 2
						),
						'the next page, kept live'
					);
					assert.equal(lane.querySelectorAll<HTMLElement>('[role=listitem]').length, 2);
					assert.equal(lane.querySelector('[data-lane-more]'), null, 'the lane ends');
				})
			);
			if (previousObserver === undefined)
				Reflect.deleteProperty(globalThis, 'IntersectionObserver');
			else globalThis.IntersectionObserver = previousObserver;
			yield* browser(v.done);
		})
);

it.live(
	'Table: `/` lists search indexes; semantic text and typed index inputs use the query search argument',
	() =>
		Effect.gen(function* () {
			const s = yield* browser(() => scripted());
			const cat: NonNullable<KindsHost['catalog']> = {
				...catalog,
				jobs: {
					...catalog.jobs,
					search: ['title'],
					semantic: true,
					indexes: {
						near: { description: 'Jobs near these hours', input: { hours: { kind: 'number' } } },
						pdq: { description: 'Raw', input: { vector: { kind: 'list', of: { kind: 'number' } } } }
					}
				}
			};
			const v = yield* browser(() =>
				show(
					{
						part: 'table',
						view: Table,
						props: { of: 'jobs', columns: ['title', 'hours'] },
						bolt: s.bolt,
						catalog: cat
					},
					'/'
				)
			);
			// the search is an icon: its popover opens focused on the box, naming the fields searched and the `/` commands
			assert.equal(
				document.querySelector('[data-search]'),
				null,
				'no box until the icon is clicked'
			);
			element<HTMLElement>(document, '[data-search-toggle]').click();
			flushSync();
			yield* browser(() => tick());
			assert.equal(
				document.activeElement,
				element<HTMLInputElement>(document, '[data-search]'),
				'the box is focused'
			);
			assert.match(textOf(element<HTMLElement>(document, '[data-search-fields]')), /Title/);
			assert.deepEqual(
				[...document.querySelectorAll<HTMLElement>('[data-search-command]')].map(
					(b) => b.dataset.searchCommand
				),
				['semantic', 'near', 'pdq']
			);
			const type = (text: string) => {
				const i = element<HTMLInputElement>(document, '[data-search]');
				i.value = text;
				i.dispatchEvent(new Event('input', { bubbles: true }));
				flushSync();
			};
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			type('/');
			assert.deepEqual(
				[...document.querySelectorAll<HTMLButtonElement>('[data-search-option]')].map((b) => [
					b.dataset.searchOption,
					b.disabled
				]),
				[
					['semantic', false],
					['near', false],
					['pdq', true]
				]
			);
			type('/zz');
			assert.ok(
				element<HTMLElement>(document, '[data-search-none]'),
				'a `/` matching no index says so'
			);
			yield* browser(() => vi.advanceTimersByTimeAsync(350));
			vi.useRealTimers();
			yield* browser(() => settle());
			assert.equal(s.last().search, undefined, 'a `/…` picking an index is never a search term');
			type('/semantic ');
			assert.ok(element<HTMLElement>(document, '[data-search-index=semantic]'));
			type('lamp');
			element<HTMLInputElement>(document, '[data-search]').dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
			);
			yield* browser(() => settle());
			assert.deepEqual(s.last().search, { semantic: 'lamp' });
			assert.equal(
				document.querySelector('[data-search]'),
				null,
				'Enter applies the search and closes its popover'
			);
			element<HTMLElement>(document, '[data-search-toggle]').click();
			flushSync();
			yield* browser(() => tick());
			type('');
			element<HTMLInputElement>(document, '[data-search]').dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })
			);
			flushSync();
			assert.equal(
				document.querySelector('[data-search-index]'),
				null,
				'Backspace on an empty box is back to plain search'
			);
			type('/');
			element<HTMLElement>(document, '[data-search-option=near]').click();
			yield* browser(() => settle());
			assert.equal(
				document.querySelector('[data-search]'),
				null,
				'the text box gives way to the index input'
			);
			const hours = element<HTMLInputElement>(
				document,
				'[data-similar-input=near] [data-similar-field=hours] input'
			);
			hours.value = '3';
			hours.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			element<HTMLElement>(document, '[data-similar-input]').dispatchEvent(
				new Event('submit', { bubbles: true, cancelable: true })
			);
			yield* browser(() => settle());
			assert.deepEqual(s.last().search, { near: { hours: 3 } });
			yield* browser(v.done);
		})
);

it.live(
	'Table: a pending description deadline clears busy and keeps the prior filter; a described relation filter and sort are editable rows ANDed under the author where (rule 16a)',
	() =>
		Effect.gen(function* () {
			let reject: (error: Error) => void = () => {
				throw new Error('description gate not started');
			};
			let attempts = 0;
			const s = yield* browser(() =>
				scripted({
					describe: () =>
						++attempts === 1
							? browser(
									() =>
										new Promise<DescribedFilter>((_resolve, no) => {
											reject = no;
										})
								)
							: Effect.succeed<DescribedFilter>({
									where: {
										and: [
											{ lines: { some: { qty: { gt: 2 } } } },
											{ account: { is: { name: { like: '%acme%' } } } }
										]
									},
									orderBy: { hours: 'desc' }
								})
				})
			);
			const v = yield* browser(() =>
				show(
					{
						part: 'table',
						view: Table,
						props: { of: 'jobs', columns: ['title', 'hours'], where: { status: { eq: 'done' } } },
						bolt: s.bolt,
						catalog: catalog
					},
					'/'
				)
			);
			element<HTMLElement>(document, '[data-view-trigger]').click();
			flushSync();
			const input = element<HTMLInputElement>(document, '[data-describe] input');
			input.value = 'acme jobs with more than 2 of a line, most hours first';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			const form = element<HTMLElement>(document, '[data-describe]');
			form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
			yield* browser(() => settle());
			assert.ok(element<HTMLElement>(document, '[data-view-loading]'));
			assert.equal(element<HTMLButtonElement>(form, 'button[type="submit"]').disabled, true);
			form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
			yield* browser(() => settle());
			assert.equal(attempts, 1, 'the pending request owns the submission');
			reject(
				Object.assign(new Error('Describing this filter took too long. Try again.'), {
					name: 'TimeoutError',
					code: 'timeout'
				})
			);
			yield* browser(() => settle());
			assert.equal(document.querySelector('[data-view-loading]'), null);
			assert.deepEqual(s.last().where, { status: { eq: 'done' } });
			assert.ok(element<HTMLElement>(document, '[data-view-error]'));
			assert.equal(element<HTMLButtonElement>(form, 'button[type="submit"]').disabled, false);
			form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
			yield* browser(() => settle());
			assert.equal(document.querySelector('[data-view-error]'), null);
			assert.deepEqual(s.last().where, {
				and: [
					{ status: { eq: 'done' } },
					{
						and: [
							{ lines: { some: { qty: { gt: 2 } } } },
							{ account: { is: { name: { like: '%acme%' } } } }
						]
					}
				]
			});
			assert.deepEqual(s.last().orderBy, [{ hours: 'desc' }]);
			assert.ok(
				element<HTMLElement>(document, '[data-filter-rows] [data-many=lines]'),
				'the relation group is a row the viewer edits'
			);
			yield* browser(v.done);
		})
);

// Native reads cross the Effect scheduler's event-loop boundary before Svelte receives them.
const flushBoard = async () => {
	for (let i = 0; i < 8; i++) {
		flushSync();
		await tick();
		// The scripted EventSource sends hello on the next timer turn, including under fake time.
		if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
		await setImmediate();
	}
	flushSync();
};
type CountRow = Row & { title: string; hours: number; status: string };
type CountAnswer = { rows: readonly { key: { status: string }; count: number }[]; next: null };
type AggregateScript<A extends Value> = (options: ReadOptions, answer: A) => A | Promise<A>;
const matchesScope = (row: Row, where: ReadOptions['where']): boolean => {
	if (where === undefined) return true;
	const nodes = fromWhere(catalog, 'jobs', where);
	assert.ok(nodes);
	return nodes.every((node) => matches(row, node));
};
async function changingBoard(
	aggregate?: AggregateScript<CountAnswer>,
	initialRows?: CountRow[],
	paginated = false
) {
	let rows = initialRows ?? [
		...[1, 2, 3].map((i) => ({
			id: `scheduled-${i}`,
			title: `Scheduled ${i}`,
			hours: 1,
			status: 'scheduled'
		})),
		{ id: 'done-1', title: 'Done 1', hours: 1, status: 'done' }
	];
	const readers = new Set<() => void>(),
		aggregates: ReadOptions[] = [],
		readCalls: ReadOptions[] = [];
	const page = (options: ReadOptions) => {
		const matching = rows.filter((row) => matchesScope(row, options.where));
		return {
			rows: matching.slice(0, options.limit),
			next: paginated && matching.length > (options.limit ?? 0) ? `c${options.limit}` : null
		};
	};
	const s = await scripted({
		read: (_model, options) => {
			readCalls.push(options);
			return page(options);
		},
		changes: (read, emit) => {
			if (read.m !== 'query') return () => {};
			readers.add(emit);
			return () => {
				readers.delete(emit);
			};
		},
		aggregate: (_model, options) => {
			aggregates.push(options);
			const answer: CountAnswer = {
				rows: ['scheduled', 'done'].map((status) => ({
					key: { status },
					count: rows.filter((row) => row.status === status && matchesScope(row, options.where))
						.length
				})),
				next: null
			};
			return aggregate?.(options, answer) ?? answer;
		}
	});
	return {
		...s,
		aggregates,
		readCalls,
		move(id = 'scheduled-1') {
			rows = rows.map((row) => (row.id === id ? { ...row, status: 'done' } : row));
			for (const reader of readers) reader();
		},
		readers
	};
}
function mountCountingBoard(s: Awaited<ReturnType<typeof changingBoard>>) {
	history.replaceState(null, '', '/');
	const target = document.body.appendChild(document.createElement('div'));
	const app = mount(Harness, {
		target,
		props: {
			bolt: s.bolt,
			catalog,
			part: 'board',
			view: Board,
			props: {
				of: 'jobs',
				by: 'status',
				card: ['title'],
				lanes: ['scheduled', 'done'],
				pageSize: 1,
				where: { hours: { gt: 0 } }
			}
		}
	});
	return {
		target,
		app,
		count: (status: string) =>
			target.querySelector(`[data-lane='"${status}"'] [data-lane-count]`)?.textContent
	};
}
it.live(
	'Board counts: live moves invalidate full counts, coalesce the final update, and remain quiet while stable',
	() =>
		Effect.gen(function* () {
			vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
			vi.setSystemTime(1000);
			const s = yield* browser(() => changingBoard()),
				v = mountCountingBoard(s);
			try {
				yield* browser(() => flushBoard());
				assert.equal(v.count('scheduled'), '3');
				assert.equal(v.count('done'), '1');
				assert.equal(
					v.target.querySelectorAll<HTMLElement>('[role=listitem]').length,
					2,
					'counts include records beyond the visible first pages'
				);
				assert.equal(
					s.aggregates.length,
					1,
					'initial page hydration does not duplicate the aggregate'
				);
				s.move();
				yield* browser(() => flushBoard());
				assert.equal(
					v.count('scheduled'),
					'',
					'old counts are hidden as soon as the live cards move'
				);
				s.move();
				yield* browser(() => flushBoard());
				yield* browser(() => vi.advanceTimersByTimeAsync(29999));
				yield* browser(() => flushBoard());
				assert.equal(s.aggregates.length, 1);
				const readsBeforeCount = s.readCalls.length;
				yield* browser(() => vi.advanceTimersByTimeAsync(1));
				yield* browser(() => flushBoard());
				assert.equal(
					s.readCalls.length,
					readsBeforeCount,
					'updating count metadata does not reopen unchanged page queries'
				);
				assert.equal(v.count('scheduled'), '2');
				assert.equal(v.count('done'), '2');
				assert.equal(s.aggregates.length, 2, 'one trailing aggregate covers the last update');
				yield* browser(() => vi.advanceTimersByTimeAsync(90000));
				yield* browser(() => flushBoard());
				assert.equal(s.aggregates.length, 2, 'stable boards do not poll');
			} finally {
				yield* browser(() => unmount(v.app));
				v.target.remove();
				vi.useRealTimers();
			}
		})
);
