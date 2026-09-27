// P2-INTEGRATE end to end on PGlite: the kit → engine entry → access, write, query, schema and guest areas together.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Outcome } from '../src/engine/contracts.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';
import { ACME, guest, manifest, seed, SHADY } from './engine-fixture.ts';

let t: TestWorkspace;
beforeEach(async () => {
	t = await testWorkspace({ manifest, guest, transforms: ['orders'], seed });
});
const ok = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return o;
};
const idOf = (o: Outcome, c = 'orders') => ok(o).records.find((r) => r.collection === c)!.id;
const writes = async <T>(n: number, run: () => Promise<T>): Promise<T> => {
	t.count.reset();
	const out = await run();
	expect(t.count.writes).toBe(n);
	return out;
};

describe('engine: create → read → update → delete through the full pipeline', () => {
	it('each act is one write statement; seq, roll-up, transform and state rules hold', async () => {
		const rep = t.as(t.member(['rep']));
		const created = await writes(1, () => rep.act('orders.create', { title: '  desk ', region: 'north', customer: ACME,
			lines: { create: [{ label: 'a', amount: '40' }, { label: 'b', amount: '10.50' }] } }));
		const id = idOf(created);
		expect(ok(created).records).toHaveLength(3);
		expect(await rep.get('orders', id)).toMatchObject({ title: 'desk', number: 'SO-0001', status: 'draft', total: { $dec: '50.50' } });

		const lines = (await rep.read('lines', { where: { order: { eq: id } }, orderBy: [{ label: 'asc' }], limit: 10 })).rows;
		expect(lines.map((l) => l['label'])).toEqual(['a', 'b']);
		await writes(1, () => rep.act('orders.update', { target: id, set: { note: 'n', lines: { update: [{ target: String(lines[0]!['id']), set: { amount: '1' } }] } } }).then(ok));
		expect(await rep.get('orders', id)).toMatchObject({ note: 'n', total: { $dec: '11.50' }, revision: 2 });

		await writes(1, () => rep.act('orders.update', { target: id, set: { status: 'submitted' } }).then(ok));
		expect(await rep.act('orders.update', { target: id, set: { title: 'x' } })).toMatchObject({ kind: 'refused', code: 'locked', field: 'title' });
		expect(await rep.act('orders.update', { target: id, set: { status: 'draft' } })).toMatchObject({ kind: 'refused', code: 'forbidden', field: 'status' });

		await writes(1, () => rep.act('orders.delete', { target: id }).then(ok));
		expect(await rep.get('orders', id)).toBeNull();
		expect((await t.as(t.admin).read('lines', { all: true })).rows).toEqual([]);
	});

	it('the transform reads as the workspace and refuses; its refusal is recorded once', async () => {
		const rep = t.as(t.member(['rep']));
		const refused = await writes(1, () => rep.act('orders.create', { title: 'x', region: 'north', customer: SHADY }, { key: 'k1' }));
		expect(refused).toEqual({ kind: 'refused', code: 'refused', message: 'Shady is blocked', field: 'customer', rule: 'orders.transform' });
		expect(await writes(0, () => rep.act('orders.create', { title: 'x', region: 'north', customer: SHADY }, { key: 'k1', retry: true }))).toEqual(refused);
		expect((await t.as(t.admin).read('orders', { all: true })).rows).toEqual([]);
	});

	it('an unmarked replay writes nothing and returns the first outcome byte for byte', async () => {
		const rep = t.as(t.member(['rep']));
		const input = { title: 'desk', region: 'north', customer: ACME };
		const first = await rep.act('orders.create', input, { key: 'same' });
		const again = await rep.act('orders.create', input, { key: 'same' });
		expect(JSON.stringify(again)).toBe(JSON.stringify(first));
		expect((await rep.read('orders', { all: true })).rows).toHaveLength(1);
		expect(await rep.act('orders.create', { ...input, title: 'other' }, { key: 'same' })).toMatchObject({ kind: 'refused', code: 'keyReuse' });
		expect(await rep.get('orders', idOf(ok(await rep.act('orders.create', { ...input, title: 'next' }))))).toMatchObject({ number: 'SO-0002' });
	});
});

describe('engine: authority end to end (rules 13, 14, 35)', () => {
	it('scopes rows, masks fields per row, and judges the pre- and post-image', async () => {
		const a = t.member(['rep']), b = t.member(['rep', 'auditor']);
		const mine = idOf(await t.as(a).act('orders.create', { title: 'a-order', region: 'north', note: 'secret', customer: ACME }));
		const theirs = idOf(await t.as(b).act('orders.create', { title: 'b-order', region: 'north', note: 'visible', customer: ACME }));

		expect((await t.as(a).read('orders', { all: true })).rows.map((r) => r['title'])).toEqual(['a-order']);
		expect(await t.as(a).get('orders', theirs)).toBeNull();
		const seen = (await t.as(b).read('orders', { orderBy: [{ title: 'asc' }], all: true })).rows;
		expect(seen.map((r) => [r['title'], r['note']])).toEqual([['a-order', { $masked: true }], ['b-order', 'visible']]);

		expect(await t.as(a).act('orders.update', { target: theirs, set: { note: 'x' } })).toMatchObject({ kind: 'refused', code: 'notFound' });
		expect(await t.as(a).act('orders.update', { target: mine, set: { region: 'south' } })).toMatchObject({ kind: 'refused', code: 'forbidden' });
		expect(await t.as(a).act('orders.create', { title: 'c', region: 'south', customer: ACME })).toMatchObject({ kind: 'refused', code: 'forbidden' });
		expect(await t.as(t.member(['auditor'])).act('orders.update', { target: mine, set: { note: 'x' } })).toMatchObject({ kind: 'refused', code: 'forbidden' });
	});

	it('a `via` child is scoped through its stored parent (rule 35)', async () => {
		const a = t.member(['rep']), b = t.member(['rep']);
		const id = idOf(await t.as(a).act('orders.create', { title: 'o', region: 'north', customer: ACME, lines: { create: [{ label: 'l', amount: '5' }] } }));
		const [line] = (await t.as(a).read('lines', { all: true })).rows;
		expect((await t.as(b).read('lines', { all: true })).rows).toEqual([]);
		expect(await t.as(b).act('lines.update', { target: String(line!['id']), set: { amount: '6' } })).toMatchObject({ code: 'notFound' });
		ok(await t.as(a).act('lines.update', { target: String(line!['id']), set: { amount: '7' } }));
		expect(await t.as(a).get('orders', id)).toMatchObject({ total: { $dec: '7' } });
		ok(await t.as(t.admin).act('orders.update', { target: id, set: { region: 'south' } }));
		expect(await t.as(a).act('lines.update', { target: String(line!['id']), set: { amount: '8' } })).toMatchObject({ code: 'forbidden' });
	});

	it('an administrator bypasses grants but not the model or the transform', async () => {
		const admin = t.as(t.admin);
		const id = idOf(await t.as(t.member(['rep'])).act('orders.create', { title: 'o', region: 'north', note: 'n', customer: ACME }));
		expect(await admin.get('orders', id)).toMatchObject({ note: 'n' });
		ok(await admin.act('orders.update', { target: id, set: { region: 'south', status: 'submitted' } }));
		expect(await admin.act('orders.update', { target: id, set: { title: 'y' } })).toMatchObject({ code: 'locked', field: 'title' });
		expect(await admin.act('orders.create', { title: 'z', region: 'south', customer: SHADY })).toMatchObject({ code: 'refused', field: 'customer' });
		expect(await admin.act('orders.create', { title: 'z', region: 'south', status: 'submitted', customer: ACME })).toMatchObject({ code: 'invalidInput', field: 'status' });
	});
});

describe('engine: guest walls (rules 71, 72)', () => {
	it('a transform spinning past 2 s of CPU is stopped and refused; nothing is written but the outcome', async () => {
		const started = Date.now();
		const o = await writes(1, () => t.as(t.admin).act('orders.create', { title: 'spin', region: 'north', customer: ACME }));
		expect(o).toMatchObject({ kind: 'refused' });
		expect((o as { message: string }).message).toMatch(/2000 ms of guest CPU/);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect((await t.as(t.admin).read('orders', { all: true })).rows).toEqual([]);
	}, 10_000);
});
