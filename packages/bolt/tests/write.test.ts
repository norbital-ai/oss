/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { catalogOf } from '../src/engine/access/pred.ts';
import { compileCommit } from '../src/engine/write/commit.ts';
import { changed, Flattener, layerSel, withDefaults } from '../src/engine/write/flatten.ts';
import { minter } from '../src/engine/write/sql.ts';
import { manifest, member, NOW, TODAY } from './write-fixture.ts';
import * as q from './query.fixture.ts';

const cat = catalogOf(manifest);
const create = layerSel(
	manifest,
	cat,
	manifest.exposures.orders!.create!.columns,
	'create',
	'orders'
);

describe('engine/write decode and flatten', () => {
	it('decode names every offender at once, derived fields included (rule 23)', () => {
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

	it('a vector input is exactly `dim` finite numbers (rule 16)', () => {
		const f = new Flattener(q.manifest, catalogOf(q.manifest), () => 'id');
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
													target: { kind: 'id', of: 'tags', optional: true }
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
		const f = new Flattener(expanded, catalogOf(expanded), () => 'parent');
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
		const empty = new Flattener(expanded, catalogOf(expanded), () => 'parent');
		empty.create('orders', 'any', { title: 'none', selection: { kind: 'none' } }, []);
		expect(empty.problems).toEqual([]);
		expect(empty.items.map((item) => item.refs)).toEqual([[]]);
	});

	it('relation actions flatten to one change per row; omitted relations write nothing (rules 21, 22)', () => {
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
		expect((f.items[1]!.change as { values: object }).values).toEqual({
			label: 'a',
			amount: '1',
			order: 'o1'
		});
		const none = new Flattener(manifest, cat, () => 'new');
		none.update('orders', 'any', 'o1', { lines: {} }, null, []);
		expect(none.items).toHaveLength(1);
	});

	it('an owned child never changes parent: link on an owned relation is refused', () => {
		const f = new Flattener(manifest, cat, () => 'x');
		f.update('orders', 'any', 'o1', { lines: { link: ['l1'] } }, null, []);
		expect(f.problems[0]!.message).toMatch(/never changes its parent/);
	});

	it('defaults: a state lands in initial, a required field missing is named (rule 23a)', () => {
		const v: Record<string, never> = {};
		expect(withDefaults(manifest, cat, 'orders', v, member, { now: NOW, today: TODAY })).toBe(
			'title'
		);
		expect(v).toMatchObject({ status: 'draft' });
	});

	it('an update equal to the stored values changes nothing (rule 29)', () => {
		expect(changed({ title: 'a', total: '10.50' }, { title: 'a' })).toEqual({});
		expect(changed({ amount: '10.50' }, { amount: 10.5 })).toEqual({});
		expect(changed({ title: '007' }, { title: '7' })).toEqual({ title: '7' });
	});

	it('ids minted in an invocation derive from (invocationId, n) and are uuidv7 (rule 24)', () => {
		const [a, b] = [minter('inv-1', NOW), minter('inv-1', NOW)];
		const first = [a(), a()];
		expect([b(), b()]).toEqual(first);
		expect(first[0]).not.toBe(first[1]);
		expect(first[0]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
		expect(minter('inv-2', NOW)()).not.toBe(first[0]);
	});
});

describe('engine/write statement', () => {
	it('every data-modifying piece reads through the idempotency gate (rule 20)', () => {
		const phases = compileCommit(manifest, cat, {
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
			runs: [{ id: 'r', automation: 'a', input: null, dueAt: NOW, cause: 'x', depth: 0 }],
			notices: []
		});
		const mutation = phases.find((phase) => phase.text.includes('native_fresh AS'));
		const finalizer = phases.find((phase) => phase.text.includes('native_saved AS'));
		if (mutation === undefined || finalizer === undefined)
			throw new Error('The commit needs mutation and finalization phases.');
		const pieces = mutation.text.split(/,\n(?=\w+ AS (?:MATERIALIZED )?\()/);
		const writing = pieces.filter((piece) => /^p\d+ AS \(\s*(INSERT|UPDATE|DELETE)/.test(piece));
		expect(writing.length).toBeGreaterThanOrEqual(3);
		for (const piece of writing) expect(piece).toContain('EXISTS (SELECT 1 FROM idem)');
		expect(pieces.find((piece) => piece.startsWith('native_fresh '))).toContain(
			'EXISTS (SELECT 1 FROM idem)'
		);
		// A subsequent command can see rows written by native FK actions; only a fresh admitted invocation finalizes.
		expect(finalizer.text).toContain('FROM pg_temp.bolt_changes');
		expect(finalizer.text).toContain('FROM pg_temp.bolt_write_context');
		expect(finalizer.text).toContain('AND fresh');
		expect(finalizer.text).toContain('FROM allp');
		expect(finalizer.text).toContain('FROM idem');
		expect(phases.indexOf(mutation)).toBeLessThan(phases.indexOf(finalizer));
		expect(phases.at(-1)?.text).toContain('DELETE FROM pg_temp.bolt_write_context');
	});
});
