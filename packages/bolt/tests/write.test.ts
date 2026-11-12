/// <reference types="node" />
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { catalog_of } from '../src/engine/access/pred.ts';
import { compileCommit } from '../src/engine/write/commit.ts';
import { Flattener, layerSel, withDefaults } from '../src/engine/write/flatten.ts';
import { storedChanges } from '../src/engine/db/stored.ts';
import type { Json } from '../src/decl/values.ts';
import { minter } from '../src/engine/write/sql.ts';
import { manifest, member, NOW, TODAY } from './write-fixture.ts';
import * as q from './query.fixture.ts';

const required = <A>(value: A | undefined): A => {
	if (value === undefined) throw new Error('Missing write fixture value.');
	return value;
};
const cat = catalog_of(manifest);
const create = layerSel(
	manifest,
	cat,
	required(required(manifest.exposures.orders).create).columns,
	'create',
	'orders'
);

describe('engine/write decode and flatten', () => {
	it('refuses unknown model metadata without flattening rows or inventing defaults', () => {
		const f = new Flattener(manifest, cat, () => 'id');
		f.create('absent_model', 'any', { title: 'No model' }, [0]);
		expect(f.items).toEqual([]);
		expect(f.problems).toEqual([{ path: [0], message: "unknown model 'absent_model'" }]);
		const values: Record<string, Json> = { title: 'Unchanged' };
		expect(
			withDefaults(manifest, cat, 'absent_model', values, member, { now: NOW, today: TODAY })
		).toMatchObject({ _tag: 'BoltError', code: 'unknown_model' });
		expect(values).toEqual({ title: 'Unchanged' });
	});
	it('decode names every offender at once, derived fields included', () => {
		const f = new Flattener(manifest, cat, () => 'id');
		f.create(
			'orders',
			create,
			{ title: 1, total: '5', number: 'PO-1', secret: true, status: 'nope' },
			[]
		);
		expect(f.problems.map((p) => p.path.join('.'))).toEqual([
			'title',
			'total',
			'number',
			'secret',
			'status'
		]);
	});

	it('a vector input is exactly `dim` finite numbers', () => {
		const f = new Flattener(q.manifest, catalog_of(q.manifest), () => 'id');
		for (const color of [[0, 1, 2], [0, 1], [0, 1, Number.NaN], 'x'])
			f.update('orders', 'any', 'o1', { color }, null, []);
		expect(f.problems.map((p) => p.message)).toEqual(Array(3).fill('expected 3 finite numbers'));
	});

	it('collects typed references through record and union values, without inventing references for nulls', () => {
		const orders = manifest.models.orders;
		if (orders === undefined) throw new Error('The write fixture must contain orders.');
		const expanded: EngineManifest = {
			...manifest,
			models: {
				...manifest.models,
				orders: {
					...orders,
					fields: {
						...orders.fields,
						selection: {
							kind: 'json',
							shape: {
								kind: 'union',
								by: 'kind',
								arms: {
									chosen: {
										targets: {
											kind: 'record',
											of: {
												kind: 'object',
												fields: {
													target: { kind: 'ref', to: 'tags', optional: true }
												}
											}
										}
									},
									none: {}
								}
							}
						}
					}
				}
			}
		};
		const id = '0199a000-0000-7000-8000-00000000000a';
		const f = new Flattener(expanded, catalog_of(expanded), () => 'parent');
		f.create(
			'orders',
			'any',
			{
				title: 'chosen',
				selection: {
					kind: 'chosen',
					targets: {
						first: { target: id },
						second: { target: null },
						third: {}
					}
				}
			},
			[]
		);
		expect(f.problems).toEqual([]);
		expect(f.items.map((item) => item.refs)).toEqual([
			[{ field: 'selection.targets.first.target', to: 'tags', id }]
		]);
		const empty = new Flattener(expanded, catalog_of(expanded), () => 'parent');
		empty.create('orders', 'any', { title: 'none', selection: { kind: 'none' } }, []);
		expect(empty.problems).toEqual([]);
		expect(empty.items.map((item) => item.refs)).toEqual([[]]);
	});

	it('relation actions flatten to one change per row; omitted relations write nothing', () => {
		const f = new Flattener(manifest, cat, () => 'new');
		f.update(
			'orders',
			'any',
			'o1',
			{ lines: { create: [{ label: 'a', amount: '1' }], delete: ['l2'] }, tags: { link: ['t1'] } },
			3,
			[]
		);
		expect(f.items.map((i) => [i.change.model, i.change.op, i.change.id])).toEqual([
			['orders', 'update', 'o1'],
			['lines', 'create', 'new'],
			['lines', 'delete', 'l2'],
			['tags', 'update', 't1']
		]);
		const child = required(f.items[1]).change;
		if (child.op !== 'create') throw new Error('The nested action must create a child.');
		// a decimal is canonical as the wire's exact `{ $dec }` value from the flattener on
		expect(child.values).toEqual({
			label: 'a',
			amount: { $dec: '1' },
			order: 'o1'
		});
		const none = new Flattener(manifest, cat, () => 'new');
		none.update('orders', 'any', 'o1', { lines: {} }, null, []);
		expect(none.items).toHaveLength(1);
	});

	it('an owned child never changes parent: link on an owned relation is refused', () => {
		const f = new Flattener(manifest, cat, () => 'x');
		f.update('orders', 'any', 'o1', { lines: { link: ['l1'] } }, null, []);
		expect(required(f.problems[0]).message).toMatch(/never changes its parent/);
	});

	it('defaults: a state lands in initial, a required field missing is named', () => {
		const v: Record<string, Json> = {};
		expect(withDefaults(manifest, cat, 'orders', v, member, { now: NOW, today: TODAY })).toBe(
			'title'
		);
		expect(v).toMatchObject({ status: 'draft' });
	});

	it('an update equal to the stored values changes nothing', () => {
		expect(storedChanges(cat, 'orders', { title: 'a', total: '10.50' }, { title: 'a' })).toEqual(
			{}
		);
		expect(storedChanges(cat, 'lines', { amount: '10.50' }, { amount: 10.5 })).toEqual({});
		expect(storedChanges(cat, 'orders', { title: '007' }, { title: '7' })).toEqual({ title: '7' });
		expect(storedChanges(cat, 'lines', { amount: '10.50' }, { amount: '10.51' })).toEqual({
			amount: '10.51'
		});
		expect(storedChanges(cat, 'orders', { note: null }, { note: null })).toEqual({});
		expect(storedChanges(cat, 'orders', { note: 'kept' }, { note: null })).toEqual({ note: null });
		const query_catalog = catalog_of(q.manifest);
		expect(
			storedChanges(
				query_catalog,
				'orders',
				{ doc: { $decimal: '10.50' } },
				{ doc: { $decimal: '10.5' } }
			)
		).toEqual({ doc: { $decimal: '10.5' } });
		expect(
			storedChanges(
				query_catalog,
				'orders',
				{ doc: { $decimal: '10.50' } },
				{ doc: { $decimal: '10.50' } }
			)
		).toEqual({});
	});

	it('ids minted in an invocation derive from (invocationId, n) and are uuidv7', () => {
		const [a, b] = [minter('inv-1', NOW), minter('inv-1', NOW)];
		const first = [a(), a()];
		expect([b(), b()]).toEqual(first);
		expect(first[0]).not.toBe(first[1]);
		expect(first[0]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
		expect(minter('inv-2', NOW)()).not.toBe(first[0]);
		const sequence = minter('inv-1', NOW),
			origin = sequence();
		for (let index = 1; index <= 257; index++) {
			const id = sequence();
			if (index !== 1 && index !== 255 && index !== 256 && index !== 257) continue;
			expect(id.slice(0, -8)).toBe(origin.slice(0, -8));
			expect(BigInt(`0x${id.slice(-8)}`)).toBe(BigInt(`0x${origin.slice(-8)}`) ^ BigInt(index));
		}
	});
});

describe('engine/write statement', () => {
	it.effect('every data-modifying piece reads through the idempotency gate', () =>
		Effect.gen(function* () {
			const statement = yield* compileCommit(manifest, cat, {
				key: 'k',
				digest: 'd',
				issuedAt: NOW,
				now: NOW,
				today: TODAY,
				actor: member,
				writer: { starter: null, actor: 'test', depth: 0 },
				owned: [],
				output: null,
				rate: [{ rule: 'act', bucket: 'a', limit: 5, windowStart: NOW }],
				writes: [
					{ model: 'orders', id: 'o', op: 'create', values: { title: 't', status: 'draft' } },
					{
						model: 'lines',
						id: 'l',
						op: 'create',
						values: { label: 'a', amount: '1', order: 'o' }
					},
					{ model: 'tags', id: 't', op: 'delete', revision: 1 }
				],
				runs: [{ id: 'r', automation: 'a', input: null, due_at: NOW, cause: 'x', depth: 0 }],
				notices: []
			});
			// one statement: every row piece, its history and effects, and the outcome read the gate
			const pieces = statement.text.split(/,\n(?=\w+ AS (?:MATERIALIZED )?\()/);
			const writing = pieces.filter((piece) => /^p\d+ AS \(\s*(INSERT|UPDATE|DELETE)/.test(piece));
			expect(writing.length).toBeGreaterThanOrEqual(3);
			for (const piece of writing) expect(piece).toContain('EXISTS (SELECT 1 FROM idem)');
			expect(pieces.find((piece) => piece.startsWith('out '))).toContain('FROM idem');
			expect(statement.text).toContain('FROM allp');
			expect(statement.text).not.toContain('pg_temp.');
		})
	);
});
