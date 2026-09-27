/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { catalogOf } from '../src/engine/access/pred.ts';
import { compileCommit } from '../src/engine/write/commit.ts';
import { changed, Flattener, withDefaults } from '../src/engine/write/flatten.ts';
import { minter } from '../src/engine/write/sql.ts';
import { manifest, member, NOW, TODAY } from './write-fixture.ts';
import * as q from './query.fixture.ts';

const cat = catalogOf(manifest);
const create = manifest.collections.orders!.create!.input as { columns: readonly string[] };

describe('engine/write decode and flatten', () => {
	it('decode names every offender at once, derived fields included (rule 23)', () => {
		const f = new Flattener(manifest, cat, () => 'id');
		f.create('orders', create, { title: 1, total: '5', number: 'PO-1', secret: true, status: 'nope' }, []);
		expect(f.problems.map((p) => p.path.join('.'))).toEqual(['title', 'total', 'number', 'secret', 'status']);
	});

	it('a vector input is exactly `dim` finite numbers (rule 16)', () => {
		const f = new Flattener(q.manifest, catalogOf(q.manifest), () => 'id');
		for (const color of [[0, 1, 2], [0, 1], [0, 1, Number.NaN], 'x']) f.update('orders', 'any', 'o1', { color }, null, []);
		expect(f.problems.map((p) => p.message)).toEqual(Array(3).fill('expected 3 finite numbers'));
	});

	it('relation actions flatten to one change per row; omitted relations write nothing (rules 21, 22)', () => {
		const f = new Flattener(manifest, cat, () => 'new');
		f.update('orders', 'any', 'o1', { lines: { create: [{ label: 'a', amount: '1' }], delete: ['l2'] }, tags: { link: ['t1'] } }, 3, []);
		expect(f.items.map((i) => [i.change.collection, i.change.op, i.change.id])).toEqual([
			['orders', 'update', 'o1'], ['lines', 'create', 'new'], ['lines', 'delete', 'l2'], ['tags', 'update', 't1']]);
		expect((f.items[1]!.change as { values: object }).values).toEqual({ label: 'a', amount: '1', order: 'o1' });
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
		expect(withDefaults(manifest, cat, 'orders', v, member, { now: NOW, today: TODAY })).toBe('title');
		expect(v).toMatchObject({ status: 'draft' });
	});

	it('an update equal to the stored values changes nothing (rule 29)', () => {
		expect(changed({ title: 'a', total: '10.50' }, { title: 'a' })).toEqual({});
		expect(changed({ amount: '10.50' }, { amount: 10.5 })).toEqual({});
		expect(changed({ title: '007' }, { title: '7' })).toEqual({ title: '7' });
	});

	it('ids minted in an invocation derive from (invocationId, n) and are uuidv7 (rule 24)', async () => {
		const [a, b] = [await minter('inv-1', NOW), await minter('inv-1', NOW)];
		const first = [a(), a()];
		expect([b(), b()]).toEqual(first);
		expect(first[0]).not.toBe(first[1]);
		expect(first[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect((await minter('inv-2', NOW))()).not.toBe(first[0]);
	});
});

describe('engine/write statement', () => {
	it('every data-modifying piece reads through the idempotency gate (rule 20)', () => {
		const sql = compileCommit(manifest, cat, {
			key: 'k', digest: 'd', issuedAt: NOW, now: NOW, today: TODAY, actor: member, owned: [], output: null,
			rate: [{ rule: 'act', bucket: 'a', limit: 5, windowStart: NOW }],
			writes: [
				{ collection: 'orders', id: 'o', op: 'create', values: { title: 't', status: 'draft' } },
				{ collection: 'lines', id: 'l', op: 'create', values: { label: 'a', amount: '1', order: 'o' } },
				{ collection: 'tags', id: 't', op: 'delete', revision: 1 },
			],
			runs: [{ id: 'r', automation: 'a', input: null, dueAt: NOW, cause: 'x', depth: 0 }], notices: [], outbox: [],
		}).text;
		const pieces = sql.split(/,\n(?=\w+ AS (?:MATERIALIZED )?\()/);
		const writing = pieces.filter((p) => /^\w+ AS \(\s*(INSERT|UPDATE|DELETE)/.test(p));
		expect(writing.length).toBeGreaterThan(5);
		for (const p of writing) if (!p.startsWith('idem ') && !p.startsWith('out ') && !p.startsWith('hist ')) expect(p).toContain('EXISTS (SELECT 1 FROM idem)');
		// the history and outcome pieces read only gated pieces (`allp`) or the gate itself
		expect(pieces.find((p) => p.startsWith('hist '))).toContain('FROM allp');
		expect(pieces.find((p) => p.startsWith('out '))).toContain('FROM idem');
	});
});

describe('notices (L-BOLT-356)', () => {
	it('sys_notification has one writer: the noticeInsert piece', async () => {
		const { readdirSync, readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const src = join(import.meta.dirname, '../src');
		const writers = readdirSync(src, { recursive: true }).map(String).filter((f) => /\.(ts|svelte)$/.test(f))
			.filter((f) => /INSERT\s+INTO\s+sys_notification\b/i.test(readFileSync(join(src, f), 'utf8')));
		expect(writers).toEqual(['engine/write/sql.ts']);
	});
});
