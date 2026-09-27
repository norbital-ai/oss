// The value codec on PGlite: periods written on every path (act, nested relation action, seed restore), and the
// transform's `existing` handed over in wire form (X-11, rule 70, §5.8).
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest, GuestPort, Invocation, Outcome, TenantDb } from '../src/engine/contracts.ts';
import { openPglite } from '../src/engine/db/pglite.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { act, type ActRequest, type WriteEngine } from '../src/engine/write/act.ts';
import { seed } from '../src/engine/write/seed.ts';
import { readEngine } from '../src/engine/query/engine.ts';
import { read, where } from '../src/protocol/ir.ts';
import { evaluate } from '../src/engine/query/eval.ts';
import { catalogOf } from '../src/engine/access/pred.ts';
import { guestRunner } from '../src/engine/guest/runner.ts';
import { lowerRead } from '../src/engine/index.ts';
import { LIMITS } from '../src/engine/contracts.ts';
import { admin, manifest as base, NOW, TODAY } from './write-fixture.ts';

const cols = ['name', 'span', 'slot'];
const manifest: EngineManifest = {
	...base,
	models: {
		shifts: { description: 'A shift', label: 'name', fields: { name: { kind: 'text' }, span: { kind: 'period', of: 'date' }, slot: { kind: 'period', of: 'instant', optional: true }, notes: { kind: 'json', optional: true } } },
		breaks: { description: 'A break', label: 'name', fields: { name: { kind: 'text' }, span: { kind: 'period', of: 'date' } } },
	},
	relationships: { 'breaks.shift': { to: 'shifts', inverse: 'breaks', owned: true } },
	collections: {
		shifts: { read: { fields: 'all' }, create: { input: { columns: cols, with: { breaks: { create: { columns: ['name', 'span'] } } } } }, update: { input: { columns: cols } } },
		breaks: { read: { fields: 'all' } },
	},
};

let pg: PGlite, db: TenantDb;
let n = 0;
beforeEach(async () => {
	({ pg, db } = await openPglite());
	await applyPlan(db, plan(null, manifest), { accept: true });
});
const run = (over: Partial<ActRequest> & Pick<ActRequest, 'verb' | 'input'>, engine: Partial<WriteEngine> = {}) => act({ manifest, db, ...engine },
	{ collection: 'shifts', key: `key-${n}`, issuedAt: NOW, authority: admin, bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} }, invocationId: `inv-${n++}`, ...over });
const committed = (o: Outcome) => { if (o.kind !== 'committed') throw new Error(JSON.stringify(o)); return o; };
const stored = async (t: string) => (await pg.query<{ name: string; span: string; slot: string | null }>(`select name, span::text, slot::text from ${t} order by name`)).rows;

describe('codec: periods reach Postgres as ranges on every write path (X-11)', () => {
	it('act create, a nested relation create and an update store inclusive date and closed-open instant ranges', async () => {
		const o = committed((await run({ verb: 'create', input: {
			name: 'a', span: { from: '2026-01-01', to: '2026-01-31' }, slot: { start: '2026-01-01T09:00:00Z', end: null },
			breaks: { create: [{ name: 'b', span: { from: { $d: '2026-01-05' }, to: null } }] },
		} })).outcome);
		expect(await stored('shifts')).toEqual([{ name: 'a', span: '[2026-01-01,2026-02-01)', slot: '["2026-01-01 09:00:00+00",)' }]);
		expect((await pg.query(`select span::text from breaks`)).rows).toEqual([{ span: '[2026-01-05,)' }]);
		const id = o.records.find((r) => r.collection === 'shifts')!.id;
		committed((await run({ verb: 'update', input: { target: id, set: { span: { from: '2026-02-01', to: '2026-02-01' } } } })).outcome);
		expect((await stored('shifts'))[0]!.span).toBe('[2026-02-01,2026-02-02)');
	});

	it('an inverted period is refused at decode, before any write', async () => {
		expect((await run({ verb: 'create', input: { name: 'x', span: { from: '2026-02-01', to: '2026-01-01' } } })).outcome)
			.toMatchObject({ kind: 'refused', code: 'invalidInput', field: 'span' });
	});

	it('a seed restore stores period values', async () => {
		await seed(manifest, db, { shifts: [{ id: '0199a000-0000-7000-8000-000000000001', name: 's', span: { from: '2025-01-01', to: null } }] }, NOW);
		expect(await stored('shifts')).toEqual([{ name: 's', span: '[2025-01-01,)', slot: null }]);
	});
});

describe('codec: the transform reads `existing` in wire form (§5.8)', () => {
	it('an update hands the guest the stored row as `db.read` would: tagged ends, not range text', async () => {
		const id = committed((await run({ verb: 'create', input: { name: 'a', span: { from: '2026-01-01', to: '2026-01-31' } } })).outcome)
			.records.find((r) => r.collection === 'shifts')!.id;
		let seen: Json = null;
		const guest: GuestPort = { invoke: async (inv: Invocation) => {
			seen = (inv.ctx.existing?.[0] ?? null) as Json;
			return { kind: 'ok', output: [inv.input === null ? {} : (inv.input as Json[])[0]!], cpuMs: 0 };
		} };
		committed((await run({ verb: 'update', input: { target: id, set: { name: 'b' } } }, { guest, transforms: new Set(['shifts']) })).outcome);
		expect(seen).toMatchObject({ id, name: 'a', span: { from: { $d: '2026-01-01' }, to: { $d: '2026-01-31' } }, slot: null });
	});
});

describe('codec: `Where` says a json list is empty', () => {
	it('`isEmpty` matches `[]` and null, `isEmpty: false` a non-empty list; SQL and the JS evaluator agree', async () => {
		const id = (n: number) => `0199a000-0000-7000-8000-00000000000${n}`;
		const span = { from: '2026-01-01', to: null };
		await seed(manifest, db, { shifts: [{ id: id(1), name: 'empty', span, notes: [] }, { id: id(2), name: 'none', span }, { id: id(3), name: 'full', span, notes: ['x'] },
			{ id: id(4), name: 'object', span, notes: { a: 1 } }] }, NOW);
		const cat = catalogOf(manifest), b = { now: NOW, today: TODAY, tz: 'UTC', params: {} };
		const names = async (isEmpty: boolean) => {
			const [page] = await readEngine({ db, manifest }).run([read(cat, 'shifts', { where: { notes: { isEmpty } }, orderBy: 'name', all: true })], { as: 'workspace' }, b);
			return (page as { rows: { name: string }[] }).rows.map((r) => r.name);
		};
		expect(await names(true)).toEqual(['empty', 'none']);
		expect(await names(false)).toEqual(['full']);
		const p = where(cat, 'shifts', { notes: { isEmpty: true } });
		expect([[], null, ['x'], { a: 1 }].map((notes) => evaluate({ cat, bindings: b, authority: null }, 'shifts', p, { id: id(9), notes }))).toEqual([true, true, false, false]);
	});
});

describe('codec: the MY-nihon payroll read pattern fits one transform (rule 72)', () => {
	it('two waves, 7.1 MB of statutory rules paged 4 rows a crossing with `select`: under 40 crossings, 4 MiB each, 32 MiB read', async () => {
		// the hr-payroll MY-nihon lineage's 39 schemes: KiB of `rules` per row, as the seed bank measures them
		const sizes = [[717, 5], [377, 5], [191, 4], [189, 1], [47, 5], [28, 5], [11, 2], [10, 2], [2, 5], [1, 5]].flatMap(([k, n]) => Array<number>(n!).fill(k! * 1024));
		const m: EngineManifest = { ...base, models: {
			schemes: { description: 'A scheme', label: 'code', fields: { code: { kind: 'text' }, rules: { kind: 'json' }, authority: { kind: 'json' }, rate: { kind: 'decimal', scale: 2 } } },
			people: { description: 'A person', label: 'name', fields: { name: { kind: 'text' }, since: { kind: 'date' } } },
		}, relationships: {}, collections: { schemes: { read: { fields: 'all' } }, people: { read: { fields: 'all' } } } };
		({ pg, db } = await openPglite());
		await applyPlan(db, plan(null, m), { accept: true });
		const uuid = (i: number) => `0199a000-0000-7000-8000-${String(i).padStart(12, '0')}`;
		await seed(m, db, {
			schemes: sizes.map((bytes, i) => ({ id: uuid(i), code: `S${String(i).padStart(2, '0')}`, rules: [{ when: 'x'.repeat(bytes - 20) }], authority: { text: 'y'.repeat(2_200) }, rate: '11.00' })),
			people: Array.from({ length: 89 }, (_, i) => ({ id: uuid(100 + i), name: `p${i}`, since: '2024-01-01' })),
		}, NOW);
		const reads = readEngine({ db, manifest: m });
		const batches: number[] = [];
		const bridge = { cross: async (calls: readonly { op: string; read?: never }[]) => {
			batches.push(calls.length);
			return (await reads.run(calls.map((c) => c.read!), { as: 'workspace' }, { now: NOW, today: TODAY, tz: 'UTC', params: {} })).map((value) => ({ ok: true as const, value }));
		} };
		// world.ts: wave 1 (9 reads by company), wave 2 (16 reads by people, plus the lineage's schemes 4 rows a page)
		const source = `export default { collection: { schemes: { bodies: { transform: async (inputs, ctx) => {
	const small = (n) => Promise.all(Array.from({ length: n }, () => ctx.db.read('people', { where: { name: { like: 'p%' } }, all: true })));
	await small(9);
	const pages = async () => { const rows = []; let after = null;
		do { const p = await ctx.db.read('schemes', { select: { code: true, rules: true, rate: true }, orderBy: 'code', limit: 4, ...(after === null ? {} : { after }) }); rows.push(...p.rows); after = p.next; } while (after !== null);
		return rows; };
	const [schemes, people] = await Promise.all([pages(), small(16)]);
	const bytes = schemes.reduce((n, s) => n + s.rules[0].when.length, 0);
	return [{ schemes: schemes.length, people: people[0].rows.length, bytes, authority: schemes.some((s) => 'authority' in s), since: typeof people[0].rows[0].since, rate: typeof schemes[0].rate }];
} } } } };`;
		const inv: Invocation = { id: 'payroll', kind: 'transform', target: 'schemes', input: [{}],
			ctx: { actor: admin.actor, now: NOW, today: TODAY, tz: 'UTC', seed: 's', existing: [null] },
			budget: { cpuMs: LIMITS.guestCpuMs, crossings: LIMITS.crossings.sync, readBytes: LIMITS.readBytes } };
		const o = await guestRunner({ source }, { lowerRead: (member, args) => lowerRead(m, member, args), console: () => {} }).invoke(inv, bridge as never);
		if (o.kind !== 'ok') throw new Error(JSON.stringify(o));
		expect(o.output).toEqual([{ schemes: 39, people: 89, bytes: sizes.reduce((a, b) => a + b - 20, 0), authority: false, since: 'string', rate: 'string' }]);
		expect(batches.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(LIMITS.crossings.sync);
		expect(o.cpuMs).toBeLessThan(LIMITS.guestCpuMs);
	});
});
