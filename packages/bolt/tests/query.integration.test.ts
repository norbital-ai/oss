import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { Authority, Pred, ReadIR, Reader, RowData, TenantDb } from '../src/engine/contracts.ts';
import { readEngine } from '../src/engine/query/engine.ts';
import { evaluate } from '../src/engine/query/eval.ts';
import * as ir from '../src/protocol/ir.ts';
import { whereSql } from '../src/engine/query/sql.ts';
import { browserCatalog, type FieldInfo } from '../src/protocol/catalog.ts';
import { exposure } from '../src/shell/nav.ts';
import { DDL, bindings, manifest, rep } from './query.fixture.ts';

// ── a PGlite TenantDb: `read` runs its statements in order inside one call ──
let pg: PGlite;
let reads = 0, statementCount = 0;
const db: TenantDb = {
	async read(statements) {
		reads++;
		statementCount += statements.length;
		const out = [];
		for (const s of statements) {
			const r = await pg.query<{ [c: string]: Json }>(s.text, s.params as unknown[]);
			out.push({ rows: r.rows, affected: r.affectedRows ?? 0 });
		}
		return out;
	},
	async write() { throw new Error('reads only'); },
	async transaction(body) { return pg.transaction((tx) => body({ query: async (s) => { const r = await tx.query<{ [c: string]: Json }>(s.text, s.params as unknown[]); return { rows: r.rows, affected: r.affectedRows ?? 0 }; } })); },
};

let seed = 7;
const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const id = (kind: number, n: number) => `00000000-0000-4000-8${kind}00-${n.toString(16).padStart(12, '0')}`;
const ACCOUNTS = ['alpha acme', 'beta supplies', 'acme north', 'gamma', 'delta acme works', 'epsilon'].map((name, i) => ({ id: id(1, i), name, region: [ 'north', 'south', 'north', null, 'north', 'south'][i]! }));
const ORDERS = Array.from({ length: 40 }, (_, i) => {
	const d = 1 + Math.floor(rnd() * 28);
	return { id: id(2, i), account: pick(ACCOUNTS).id, status: pick(['open', 'closed', 'held']), total: (Math.floor(rnd() * 100_000) / 100).toFixed(2),
		qty: Math.floor(rnd() * 5), email: pick(['a@x.io', 'A@X.IO', 'b@y.io', null]), placed: `2026-09-${String(d).padStart(2, '0')}`,
		at: new Date(Date.parse('2026-09-20T00:00:00Z') + Math.floor(rnd() * 10 * 86_400_000)).toISOString(),
		tags: ['a', 'b', 'c'].filter(() => rnd() < 0.4), note: pick(['blue box', 'red', 'rose', null]),
		span: rnd() < 0.3 ? null : { from: `2026-09-${String(d).padStart(2, '0')}`, to: rnd() < 0.3 ? null : `2026-09-${String(Math.min(28, d + Math.floor(rnd() * 10))).padStart(2, '0')}` },
		color: rnd() < 0.2 ? null : [rnd(), rnd(), rnd()].map((x) => Math.round(x * 100) / 100), spot: rnd() < 0.3 ? null : { lat: 3 + rnd(), lng: 101 + rnd() } };
});
const LINES = Array.from({ length: 60 }, (_, i) => ({ id: id(3, i), order: pick(ORDERS).id, sku: pick(['s1', 's2', 's3']), amount: (Math.floor(rnd() * 10_000) / 100).toFixed(2) }));
const NOTES = Array.from({ length: 20 }, (_, i) => ({ id: id(4, i), about: rnd() < 0.5 ? { collection: 'accounts', id: pick(ACCOUNTS).id } : { collection: 'orders', id: pick(ORDERS).id }, body: pick(['call back', 'paid', 'late']) }));

const engine = readEngine({ db, manifest, allBytes: 8 * 1024 * 1024,
	similarity: (c, name) => c === 'orders' && name === 'hue' ? {
		probe: async () => ({ field: 'color', vector: [0, 0, 0], where: { status: { ne: 'held' } } }),
		// the exact metric is not the index's: distance of the first channel from 0.5
		rerank: async (_input, rows) => { reranked = rows.length; return rows.map((r) => Math.abs((r.color as number[])[0]! - 0.5)); },
	} : undefined });
let reranked = 0;
const cat = engine.catalog;
const caller: Reader = { as: 'caller', authority: rep };
const workspace: Reader = { as: 'workspace' };
const run = async (reader: Reader, ...batch: ReadIR[]) => engine.run(batch, reader, bindings);
type Page = { rows: RowData[]; next: string | null };

beforeAll(async () => {
	pg = new PGlite({ extensions: { vector } });
	await pg.exec(DDL);
	for (const a of ACCOUNTS) await pg.query('insert into accounts (id, name, region, secret) values ($1, $2, $3, $4)', [a.id, a.name, a.region, 'shh']);
	for (const o of ORDERS) await pg.query(`insert into orders (id, account, status, total, qty, email, placed, at, tags, note, span, doc, color, spot)
		values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, case when $11::text is null then null else daterange($11::date, $12::date, '[]') end, $13, $14::vector, $15::point)`,
		[o.id, o.account, o.status, o.total, o.qty, o.email, o.placed, o.at, o.tags, o.note, o.span?.from ?? null, o.span?.to ?? null,
			{ big: o.id }, o.color === null ? null : `[${o.color.join(',')}]`, o.spot === null ? null : `(${o.spot.lng},${o.spot.lat})`]);
	for (const l of LINES) await pg.query('insert into lines (id, "order", sku, amount) values ($1, $2, $3, $4)', [l.id, l.order, l.sku, l.amount]);
	for (const n of NOTES) await pg.query('insert into notes (id, about__accounts, about__orders, body) values ($1, $2, $3, $4)',
		[n.id, n.about.collection === 'accounts' ? n.about.id : null, n.about.collection === 'orders' ? n.about.id : null, n.body]);
}, 60_000);
afterAll(async () => { await pg.close(); });

describe('next query engine (PGlite)', () => {
	it('K3, rule 11a: grammar-generated predicates decode, round-trip, and agree in SQL and JS for the workspace, an admin and a masked caller; a corrupted clause is invalid', async () => {
		const all = async (c: string, reader: Reader, select?: object) => ((await run(reader, ir.read(cat, c, { all: true, ...(select === undefined ? {} : { select }) })))[0] as Page).rows;
		const everything = { status: true, total: true, qty: true, email: true, placed: true, at: true, tags: true, note: true, span: true, spot: true, account: true, doc: true };
		const rows = { accounts: await all('accounts', workspace, { name: true, region: true, secret: true }), orders: await all('orders', workspace, everything),
			lines: await all('lines', workspace), notes: await all('notes', workspace) } as { [c: string]: RowData[] };
		const related = (c: string, rel: string, target: string, row: RowData): RowData[] => {
			const one = cat.models.get(c)!.one.get(rel);
			if (one !== undefined) {
				const v = row[rel] as string | { collection: string; id: string } | null;
				const to = typeof v === 'string' ? v : v?.collection === target ? v.id : null;
				return rows[target]!.filter((r) => r.id === to);
			}
			const m = cat.models.get(c)!.many.get(rel)!;
			const fk = m.column.split('__')[0]!;
			return rows[target]!.filter((r) => { const v = r[fk] as string | { id: string } | null; return (typeof v === 'string' ? v : v?.id) === row.id; });
		};
		// the grammar of §3.3.9 over the catalogue: a field, an operator its kind admits, an operand its kind admits, a
		// literal from the column's own values; relations by their quantifiers; combinators; to depth 4
		const untag = (v: unknown): Json => isTagged(v) ? Object.values(v)[0] as Json : v as Json;
		const isTagged = (v: unknown): v is object => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && Object.keys(v)[0]!.startsWith('$');
		const pool = (m: string, f: string): Json[] => [...new Set(rows[m]!.map((r) => untag(r[f])).filter((v) => v !== null && v !== undefined).map((v) => JSON.stringify(v)))].map((v) => JSON.parse(v) as Json);
		const EXPOSED: { [m: string]: readonly string[] } = { notes: ['body'] };
		type Opts = { actor: boolean; text: boolean };
		const cmp = () => pick(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);
		const unit = () => pick(['week', 'month', 'quarter', 'year']);
		const startOf = () => rnd() < 0.5 ? { startOf: unit() } : { startOf: unit(), shift: pick([-1, 1, -2]) };
		function leaf(m: string, f: FieldInfo, o: Opts): object {
			const vals = pool(m, f.name), v = () => pick(vals);
			const list = () => vals.filter(() => rnd() < 0.4);
			switch (f.kind) {
				case 'enum': return pick([{ [cmp().slice(0, 2) === 'eq' ? 'eq' : 'ne']: pick(f.values!) }, { [pick(['in', 'nin'])]: f.values!.filter(() => rnd() < 0.5) }]);
				case 'decimal': case 'int': {
					const nums = FIELDS(m).filter((g) => g.name !== f.name && (g.kind === 'decimal' || g.kind === 'int'));
					return pick([{ [cmp()]: v() }, { [cmp()]: v() }, { in: list() }, ...nums.map((g) => ({ [cmp()]: { field: g.name } })), ...(f.kind === 'decimal' ? [{ gte: { param: 'min' } }] : [])]);
				}
				case 'date': return pick([{ [cmp()]: v() }, { gte: { today: pick(['-5d', '', '+3d']) } }, { [pick(['gte', 'lt'])]: startOf() }]);
				case 'instant': return pick([{ [cmp()]: v() }, { gt: { now: pick(['-100h', '+100h']) } }, { [pick(['gte', 'lt'])]: startOf() }]);
				case 'period': return pick([{ contains: v() === null ? '2026-09-10' : pick([(v() as { from: string }).from, { today: '-10d' }, startOf()]) },
					{ [pick(['overlaps', 'within'])]: { from: pick(['2026-09-01', startOf()]), to: pick([null, '2026-09-12', { today: '' }, { startOf: 'month', shift: 1 }]) } }, { isNull: rnd() < 0.5 }]);
				case 'point': return pick([{ near: [{ lat: 3.5, lng: 101.5 }, pick([10_000, 40_000])] }, { within: { bbox: [{ lat: 3, lng: 101 }, { lat: 3.5, lng: 101.5 }] } },
					{ within: { polygon: [{ lat: 3, lng: 101 }, { lat: 4, lng: 101 }, { lat: 3.5, lng: 102 }] } }, { isNull: true }]);
				case 'json': return pick([{ contains: { big: pick(rows.orders!).id } }, { contains: {} }, { isNull: false }]);
				case 'text': {
					if (f.many) return pick([{ has: pick(['a', 'b', 'c']) }, { hasAny: ['a', 'b', 'c'].filter(() => rnd() < 0.5) }, { hasAll: ['a', 'b'].filter(() => rnd() < 0.7) }, { isEmpty: rnd() < 0.5 }]);
					const s = vals.length === 0 ? 'x' : String(v());
					const like = pick([`%${s.slice(1, 3)}%`, `${s.slice(0, 1).toUpperCase()}%`, `%${s.slice(-1)}`, `_${s.slice(1)}`, '%\\%%']);
					const texts = FIELDS(m).filter((g) => g.name !== f.name && g.kind === 'text' && !g.many);
					return pick([{ eq: s }, { ne: s }, { in: list() }, { like }, { isNull: rnd() < 0.5 }, ...texts.map((g) => ({ [pick(['eq', 'ne'])]: { field: g.name } })),
						...(f.email && o.actor ? [{ eq: { actor: 'email' } }, { eq: { actor: 'email' } }] : []), ...(o.text ? [{ [pick(['lt', 'gte'])]: s }] : [])]);
				}
				default: return { isNull: rnd() < 0.5 };
			}
		}
		const FIELDS = (m: string) => [...cat.models.get(m)!.fields.values()].filter((f) => !f.name.includes('.') && !['id', 'revision', 'approval_id', 'created_by', 'updated_by', 'created_at', 'updated_at'].includes(f.name)
			&& !['vector', 'file', 'custom', 'ref', 'id'].includes(f.kind) && !f.computed && (EXPOSED[m] ?? [f.name]).includes(f.name));
		function gen(m: string, depth: number, o: Opts): object {
			const info = cat.models.get(m)!;
			const r = rnd();
			if (depth < 4 && r < 0.12) return { and: [gen(m, depth + 1, o), gen(m, depth + 1, o)] };
			if (depth < 4 && r < 0.24) return { or: [gen(m, depth + 1, o), gen(m, depth + 1, o)] };
			if (depth < 4 && r < 0.3) return { not: gen(m, depth + 1, o) };
			if (depth < 4 && r < 0.5) {
				const rels = [...info.one.keys(), ...info.many.keys()].filter((x) => m !== 'notes' || x === 'about');
				const rel = pick(rels);
				const one = info.one.get(rel);
				if (one !== undefined) {
					const t = pick(one.targets);
					const body = rnd() < 0.7 ? { is: gen(t, depth + 1, o) } : pick([{ eq: pick(rows[t]!).id }, { in: rows[t]!.filter(() => rnd() < 0.3).map((x) => x.id) }, { isNull: rnd() < 0.5 }]);
					return { [rel]: one.targets.length > 1 ? { [t]: body } : body };
				}
				const child = info.many.get(rel)!.child;
				const amounts = pool(child, 'amount');
				return { [rel]: pick([{ [pick(['some', 'none', 'every'])]: gen(child, depth + 1, o) }, { count: { [cmp()]: pick([0, 1, 2]) } },
					...(child === 'lines' ? [{ [pick(['sum', 'min', 'max', 'avg'])]: { of: 'amount', [cmp()]: pick([...amounts, 0, '50']) } }] : [])]) };
			}
			const f = pick(FIELDS(m));
			return { [f.name]: leaf(m, f, o) };
		}
		// rule 11a's mutation step: one operator object or relation body becomes a shape every kind refuses
		const BAD = [{}, { nope: 1 }, { eq: null }, { isNull: 'yes' }, { eq: { now: '+-1d' } }];
		function corrupt(m: string, w: object): object {
			const spots: { obj: { [k: string]: unknown }; key: string; rel: boolean }[] = [];
			const walk = (mm: string, node: { [k: string]: unknown }) => {
				const info = cat.models.get(mm)!;
				for (const [k, v] of Object.entries(node)) {
					if (k === 'and' || k === 'or') (v as object[]).forEach((x) => walk(mm, x as { [k: string]: unknown }));
					else if (k === 'not') walk(mm, v as { [k: string]: unknown });
					else if (info.many.has(k)) {
						spots.push({ obj: node, key: k, rel: true });
						for (const [q, x] of Object.entries(v as object)) if (q === 'some' || q === 'none' || q === 'every') walk(info.many.get(k)!.child, x);
					} else if (info.one.has(k)) {
						spots.push({ obj: node, key: k, rel: true });
						const one = info.one.get(k)!;
						const body = (one.targets.length > 1 ? Object.values(v as object)[0] : v) as { is?: object };
						if (body.is !== undefined) walk(one.targets.length > 1 ? Object.keys(v as object)[0]! : one.targets[0]!, body.is as { [k: string]: unknown });
					} else spots.push({ obj: node, key: k, rel: false });
				}
			};
			const copy = JSON.parse(JSON.stringify(w)) as { [k: string]: unknown };
			walk(m, copy);
			const s = pick(spots);
			s.obj[s.key] = s.rel ? pick([{}, { bogus: {} }]) : pick(BAD);
			return copy;
		}
		const admin: Authority = { ...rep, admin: true };
		for (const [reader, authority] of [[workspace, null], [{ as: 'caller', authority: admin }, admin], [caller, rep]] as [Reader, Authority | null][]) {
			const o = { actor: authority !== null, text: false };
			const wheres = Array.from({ length: 200 }, () => gen('orders', 0, o));
			const browser = authority === null ? cat : browserCatalog(exposure(manifest, authority));
			const preds: Pred[] = wheres.map((w) => {
				const p = ir.where(cat, 'orders', w);
				expect(ir.where(cat, 'orders', JSON.parse(JSON.stringify(w)))).toEqual(p);
				expect(ir.decodeView(browser, 'orders', { where: w as Json }).dropped).toEqual([]);
				expect(() => ir.where(cat, 'orders', corrupt('orders', w))).toThrow(expect.objectContaining({ code: 'invalid' }));
				return p;
			});
			const results = await db.read(preds.map((p) => whereSql(cat, 'orders', p, reader, bindings)));
			const env = { cat, bindings, authority, scoped: authority !== null, related };
			const inScope = (r: RowData) => authority === null || authority.admin || authority.collections.orders!.read.some((a) => evaluate({ ...env, scoped: false }, 'orders', a.where, r));
			let telling = 0;
			const scoped = rows.orders!.filter(inScope).length;
			preds.forEach((p, i) => {
				const js = rows.orders!.filter((r) => inScope(r) && evaluate(env, 'orders', p, r)).map((r) => r.id).sort();
				expect({ w: JSON.stringify(wheres[i]), ids: results[i]!.rows.map((r) => r.id) }).toEqual({ w: JSON.stringify(wheres[i]), ids: js });
				if (js.length > 0 && js.length < scoped) telling++;
			});
			// most predicates split the rows: an all-empty or all-full run would prove nothing
			expect(telling).toBeGreaterThan(preds.length / 3);
			// text ordering follows the database collation, which the JS evaluator does not model: SQL only
			const text = Array.from({ length: 30 }, () => gen('orders', 0, { ...o, text: true }));
			await db.read(text.map((w) => whereSql(cat, 'orders', ir.where(cat, 'orders', w), reader, bindings)));
		}
	});

	it('rules 9 and 11: explicit pages walk every row once in orderBy-then-id order; a cursor is bound to its query', async () => {
		for (const orderBy of [{ total: 'desc' }, { note: 'asc' }, [{ status: 'asc' }, { note: 'desc' }]]) {
			const seen: string[] = [];
			let after: string | undefined;
			do {
				const page = (await run(workspace, ir.read(cat, 'orders', { orderBy, limit: 7, ...(after === undefined ? {} : { after }), select: { total: true, note: true, status: true } })))[0] as Page;
				expect(page.rows.length).toBeLessThanOrEqual(7);
				seen.push(...page.rows.map((r) => r.id as string));
				after = page.next ?? undefined;
			} while (after !== undefined);
			const all = ((await run(workspace, ir.read(cat, 'orders', { orderBy, all: true, select: { total: true } })))[0] as Page).rows.map((r) => r.id);
			expect(seen).toEqual(all);
			expect(new Set(seen).size).toBe(ORDERS.length);
		}
		const byTotal = ((await run(workspace, ir.read(cat, 'orders', { orderBy: { total: 'desc' }, all: true, select: { total: true } })))[0] as Page).rows;
		const totals = byTotal.map((r) => Number((r.total as { $dec: string }).$dec));
		expect(totals).toEqual([...totals].sort((a, b) => b - a));
		const first = (await run(workspace, ir.read(cat, 'orders', { limit: 3 })))[0] as Page;
		await expect(run(workspace, ir.read(cat, 'orders', { limit: 3, after: first.next!, where: { qty: { gt: 0 } } }))).rejects.toMatchObject({ code: 'badCursor' });
		expect((await run(workspace, ir.read(cat, 'orders', { limit: 0 })))[0]).toEqual({ rows: [], next: null });
	});

	it('nearest first: a point orders by great-circle distance from a point, pages by cursor, rows without a point last', async () => {
		const at = { lat: 3.5, lng: 101.5 };
		const rad = (d: number) => d * Math.PI / 180;
		const metres = (p: { lat: number; lng: number }) => 6371008.8 * 2 * Math.asin(Math.sqrt(Math.sin(rad(p.lat - at.lat) / 2) ** 2
			+ Math.cos(rad(at.lat)) * Math.cos(rad(p.lat)) * Math.sin(rad(p.lng - at.lng) / 2) ** 2));
		const want = [...ORDERS].sort((x, y) => x.spot === null ? (y.spot === null ? x.id.localeCompare(y.id) : 1) : y.spot === null ? -1
			: metres(x.spot) - metres(y.spot) || x.id.localeCompare(y.id)).map((o) => o.id);
		const orderBy = { spot: { near: at } };
		const seen: string[] = [];
		let after: string | undefined;
		do {
			const page = (await run(workspace, ir.read(cat, 'orders', { orderBy, limit: 7, ...(after === undefined ? {} : { after }), select: { spot: true } })))[0] as Page;
			seen.push(...page.rows.map((r) => r.id as string));
			after = page.next ?? undefined;
		} while (after !== undefined);
		expect(seen).toEqual(want);
		// through a one-relation's point is the same key shape; a non-point field is refused
		expect(() => ir.read(cat, 'orders', { orderBy: { total: { near: at } }, limit: 5 })).toThrow(/not a point/);
		expect(() => ir.read(cat, 'orders', { orderBy: { spot: { near: { lat: 99, lng: 1 } } }, limit: 5 })).not.toThrow(); // the grammar checks shape, not range
	});

	it('rules 11 and 14: a related sort key orders by the target field, pages through it by cursor, and needs the target read unmasked', async () => {
		const acc = new Map(ACCOUNTS.map((a) => [a.id, a]));
		const ord = new Map(ORDERS.map((o) => [o.id, o]));
		const byId = (x: { id: string }, y: { id: string }) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
		const walk = async (reader: Reader, collection: string, orderBy: Json, limit: number) => {
			const seen: string[] = [];
			let after: string | undefined;
			do {
				const page = (await run(reader, ir.read(cat, collection, { orderBy, limit, ...(after === undefined ? {} : { after }) })))[0] as Page;
				seen.push(...page.rows.map((r) => r.id as string));
				after = page.next ?? undefined;
			} while (after !== undefined);
			return seen;
		};
		// one hop: account name ascending (distinct first letters: the database collation and JS agree), then id
		const byName = [...ORDERS].sort((x, y) => acc.get(x.account)!.name.localeCompare(acc.get(y.account)!.name) || byId(x, y)).map((o) => o.id);
		expect(((await run(workspace, ir.read(cat, 'orders', { orderBy: { account: { name: 'asc' } }, all: true })))[0] as Page).rows.map((r) => r.id)).toEqual(byName);
		expect(await walk(workspace, 'orders', { account: { name: 'asc' } }, 7)).toEqual(byName);
		// two hops, descending
		const byOrderAccount = [...LINES].sort((x, y) => acc.get(ord.get(y.order)!.account)!.name.localeCompare(acc.get(ord.get(x.order)!.account)!.name) || byId(x, y)).map((l) => l.id);
		expect(await walk(workspace, 'lines', { order: { account: { name: 'desc' } } }, 9)).toEqual(byOrderAccount);
		// a nullable target field: nulls first descending, as an own field; then an own key; every row once across pages
		const mixed: Json = [{ account: { region: 'desc' } }, { total: 'asc' }];
		const all = ((await run(workspace, ir.read(cat, 'orders', { orderBy: mixed, all: true })))[0] as Page).rows.map((r) => r.id as string);
		const region = (id: string) => acc.get(ord.get(id)!.account)!.region;
		expect(all.slice(0, all.filter((id) => region(id) === null).length).every((id) => region(id) === null)).toBe(true);
		expect(await walk(workspace, 'orders', mixed, 5)).toEqual(all);
		expect(new Set(all).size).toBe(ORDERS.length);
		// a caller: in scope only, same order; a cursor is bound to its related key
		const scoped = byName.filter((id) => acc.get(ord.get(id)!.account)!.region === 'north');
		expect(await walk(caller, 'orders', { account: { name: 'asc' } }, 4)).toEqual(scoped);
		const first = (await run(caller, ir.read(cat, 'orders', { orderBy: { account: { name: 'asc' } }, limit: 3 })))[0] as Page;
		await expect(run(caller, ir.read(cat, 'orders', { orderBy: { account: { region: 'asc' } }, limit: 3, after: first.next! }))).rejects.toMatchObject({ code: 'badCursor' });
		// rule 14: a masked target field, an unread target and a masked FK refuse; the workspace sorts by any of them
		await expect(run(caller, ir.read(cat, 'orders', { orderBy: { account: { secret: 'asc' } }, limit: 5 }))).rejects.toMatchObject({ code: 'invalidInput' });
		const noAccounts: Reader = { as: 'caller', authority: { ...rep, collections: { ...rep.collections, accounts: undefined as never } } };
		await expect(run(noAccounts, ir.read(cat, 'orders', { orderBy: { account: { name: 'asc' } }, limit: 5 }))).rejects.toMatchObject({ code: 'invalidInput' });
		const maskedFk: Reader = { as: 'caller', authority: { ...rep, collections: { ...rep.collections, orders: { ...rep.collections.orders!, masks: { account: { t: 'const', value: false } } } } } };
		await expect(run(maskedFk, ir.read(cat, 'orders', { orderBy: { account: { name: 'asc' } }, limit: 5 }))).rejects.toMatchObject({ code: 'invalidInput' });
		expect(((await run(workspace, ir.read(cat, 'orders', { orderBy: { account: { secret: 'asc' } }, limit: 5 })))[0] as Page).rows).toHaveLength(5);
		// the grammar: an arc is not a hop, three hops and a dotted key are invalid
		expect(() => ir.read(cat, 'notes', { orderBy: { about: { name: 'asc' } }, limit: 5 })).toThrow(/not a one-relation/);
		expect(() => ir.read(cat, 'lines', { orderBy: { order: { account: { name: { x: 'asc' } } } }, limit: 5 })).toThrow(/at most 2 relations/);
		expect(() => ir.read(cat, 'orders', { orderBy: { 'account.name': 'asc' }, limit: 5 })).toThrow(/one \{ field/);
	});

	it('rule 12: one batch is one round trip; identical reads run once', async () => {
		const before = reads;
		const a = ir.read(cat, 'accounts', { limit: 2 });
		const out = await run(workspace, a, ir.get(cat, 'orders', ORDERS[0]!.id), a, ir.aggregate(cat, 'orders', { count: true }));
		expect(reads - before).toBe(1);
		expect(out[0]).toEqual(out[2]);
		expect((out[1] as RowData).id).toBe(ORDERS[0]!.id);
		expect(out[3]).toEqual({ count: 40 });
	});

	it('rule 12: a batch of N reads is one statement, each read answered as if alone, under the caller\'s policies', async () => {
		const batch = [ir.read(cat, 'accounts', { all: true, select: { name: true } }), ir.read(cat, 'orders', { limit: 3, orderBy: { placed: 'desc' } }),
			ir.get(cat, 'orders', ORDERS[1]!.id), ir.get(cat, 'orders', ORDERS[2]!.id), ir.aggregate(cat, 'orders', { count: true, where: { status: { eq: 'open' } } }),
			ir.read(cat, 'lines', { all: true, where: { sku: { eq: 's1' } }, select: { amount: true } }), ir.read(cat, 'notes', { limit: 0 })];
		for (const reader of [workspace, caller]) {
			const alone = [];
			for (const one of batch) alone.push((await run(reader, one))[0]);
			const [r0, s0] = [reads, statementCount];
			expect(await run(reader, ...batch)).toEqual(alone);
			expect([reads - r0, statementCount - s0]).toEqual([1, 1]);
		}
		// the caller sees only its scope in every member: rep reads the north accounts' orders
		const north = new Set(ACCOUNTS.filter((a) => a.region === 'north').map((a) => a.id));
		const [accounts, far] = await run(caller, ir.read(cat, 'accounts', { all: true }), ir.get(cat, 'orders', ORDERS.find((o) => !north.has(o.account))!.id));
		expect((accounts as Page).rows.map((r) => r.id).sort()).toEqual([...north].sort());
		expect(far).toBeNull();
	});

	/** A batch read labelled as a keyed read's member (what the runner lowers `ctx.read({ … })` to). */
	const member = (read: ReadIR, key: string, cte?: string): ReadIR => ({ ...read, member: key, ...(cte === undefined ? {} : { cte }) }) as ReadIR;
	it('rule 12: a keyed member reads an earlier member\'s values inside the one statement, under that member\'s scope', async () => {
		const ref = (where: object, cte: string) => member(ir.read(cat, 'orders', { all: true, where, select: { account: true } }), 'orders', cte);
		const north = ACCOUNTS.filter((a) => a.region === 'north').map((a) => a.id);
		for (const reader of [workspace, caller]) {
			const s0 = statementCount;
			const [accounts, orders] = await run(reader, member(ir.read(cat, 'accounts', { all: true, where: { region: { eq: 'north' } }, select: { name: true } }), 'accounts', '1:accounts'),
				ref({ account: { in: { member: '1:accounts', field: 'id' } } }, '1:orders')) as [Page, Page];
			expect(statementCount - s0).toBe(1);
			expect(accounts.rows.map((r) => r.id).sort()).toEqual([...north].sort());
			const expected = ORDERS.filter((o) => north.includes(o.account)).map((o) => o.id).sort();
			expect(orders.rows.map((r) => r.id).sort()).toEqual(expected);
		}
		// the referenced rows are the earlier member's as its reader sees them: the rep's accounts are its north ones
		const [, scoped] = await run(caller, member(ir.read(cat, 'accounts', { all: true }), 'accounts', '2:accounts'),
			ref({ account: { nin: { member: '2:accounts', field: 'id' } } }, '2:orders')) as [Page, Page];
		expect(scoped.rows).toEqual([]);
	});

	it('rule 12: a member reference walks the earlier member\'s relation arms (a path, through a many arm)', async () => {
		const north = ACCOUNTS.filter((a) => a.region === 'north').map((a) => a.id);
		const orders = new Set(ORDERS.filter((o) => north.includes(o.account)).map((o) => o.id));
		const s0 = statementCount;
		const [, lines] = await run(workspace,
			member(ir.read(cat, 'accounts', { all: true, where: { region: { eq: 'north' } }, select: { name: true, orders: { select: { status: true }, all: true } } }), 'accounts', '3:accounts'),
			member(ir.read(cat, 'lines', { all: true, where: { order: { in: { member: '3:accounts', field: 'orders.id' } } }, select: { order: true } }), 'lines', '3:lines')) as [Page, Page];
		expect(statementCount - s0).toBe(1);
		expect(lines.rows.map((r) => r.id).sort()).toEqual(LINES.filter((l) => orders.has(l.order)).map((l) => l.id).sort());
	});

	it('rule 9: a keyed read member past its cap names itself; the rest of the batch is still one statement', async () => {
		const small = readEngine({ db, manifest, allBytes: 200 });
		const s0 = statementCount;
		await expect(small.run([member(ir.read(cat, 'accounts', { limit: 1 }), 'one'), member(ir.read(cat, 'orders', { all: true }), 'every')], workspace, bindings))
			.rejects.toMatchObject({ code: 'tooLarge', message: "member 'every': the read of orders is larger than 200 bytes; page it (rule 9)" });
		expect(statementCount - s0).toBe(1);
	});

	it('rule 13: a caller read is scoped at every level; out of scope is absent, or null through a one-relation', async () => {
		const north = new Set(ACCOUNTS.filter((a) => a.region === 'north').map((a) => a.id));
		const [accounts, orders, lines, far] = await run(caller,
			ir.read(cat, 'accounts', { all: true, select: { name: true, orders: { select: { status: true }, all: true } } }),
			ir.read(cat, 'orders', { all: true, select: { account: { select: { name: true } } } }),
			ir.read(cat, 'lines', { all: true, select: { order: { select: { status: true } } } }),
			ir.get(cat, 'orders', ORDERS.find((o) => !north.has(o.account))!.id)) as [Page, Page, Page, Json];
		expect(accounts.rows.map((r) => r.id).sort()).toEqual([...north].sort());
		expect(accounts.rows.flatMap((r) => r.orders as RowData[]).length).toBe(ORDERS.filter((o) => north.has(o.account)).length);
		expect(orders.rows.every((r) => r.account !== null)).toBe(true);
		expect(orders.rows.length).toBe(ORDERS.filter((o) => north.has(o.account)).length);
		expect(lines.rows.length).toBe(LINES.length);
		expect(lines.rows.filter((r) => r.order === null).length).toBe(LINES.filter((l) => !north.has(ORDERS.find((o) => o.id === l.order)!.account)).length);
		expect(far).toBeNull();
	});

	it('rule 14: a masked field neither leaks through where, order or select nor aggregates', async () => {
		const where = { total: { gt: '500' } };
		const [raw, masked] = [(await run(workspace, ir.read(cat, 'orders', { all: true, where, select: { status: true, account: true } })))[0] as Page,
			(await run(caller, ir.read(cat, 'orders', { all: true, where, select: { status: true, total: true } })))[0] as Page];
		const north = new Set(ACCOUNTS.filter((a) => a.region === 'north').map((a) => a.id));
		const oracle = raw.rows.filter((r) => north.has(r.account as string));
		expect(oracle.some((r) => r.status !== 'open')).toBe(true);
		expect(masked.rows.map((r) => r.id)).toEqual(oracle.filter((r) => r.status === 'open').map((r) => r.id));
		const shown = ((await run(caller, ir.read(cat, 'orders', { all: true, select: { status: true, total: true } })))[0] as Page).rows;
		expect(shown.filter((r) => r.status !== 'open').every((r) => JSON.stringify(r.total) === '{"$masked":true}')).toBe(true);
		expect(shown.filter((r) => r.status === 'open').every((r) => typeof (r.total as { $dec?: string }).$dec === 'string')).toBe(true);
		await expect(run(caller, ir.aggregate(cat, 'orders', { max: ['total'] }))).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('rule 14: a masked foreign key reads masked, filters nothing and joins nothing', async () => {
		const blind: Reader = { as: 'caller', authority: { ...rep, key: 'blind', collections: { ...rep.collections,
			orders: { ...rep.collections['orders']!, masks: { account: { t: 'const', value: false } } } } } };
		const [rows] = await run(blind, ir.read(cat, 'orders', { all: true, select: { account: true, status: true } })) as [Page];
		expect(rows.rows.length).toBeGreaterThan(0);
		expect(rows.rows.map((r) => r.account)).toEqual(rows.rows.map(() => ({ $masked: true })));
		const [joined] = await run(blind, ir.read(cat, 'orders', { all: true, select: { account: { select: { name: true } } } })) as [Page];
		expect(joined.rows.every((r) => r.account === null)).toBe(true);
		const [probe] = await run(blind, ir.read(cat, 'orders', { all: true, where: { account: { eq: ORDERS[0]!.account } } })) as [Page];
		expect(probe.rows).toEqual([]);
	});

	it('rules 10 and 15, X-33: a workspace row is stored fields unmasked; a caller default row omits json; an explicit select returns it', async () => {
		const [ws, call] = await Promise.all([run(workspace, ir.get(cat, 'accounts', ACCOUNTS[0]!.id)), run(caller, ir.get(cat, 'accounts', ACCOUNTS[0]!.id))]) as [[RowData], [RowData]];
		expect(ws[0]).toMatchObject({ name: 'alpha acme', secret: 'shh', revision: 1 });
		expect(ws[0]).not.toHaveProperty('shout');
		expect(call[0]).toMatchObject({ shout: 'ALPHA ACME', secret: { $masked: true } });
		const [dflt, explicit] = await run(workspace, ir.read(cat, 'orders', { limit: 1 }), ir.read(cat, 'orders', { limit: 1, select: { doc: true, span: true, color: true } })) as [Page, Page];
		expect(ws[0]).toHaveProperty('created_at');
		const cdefault = (await run(caller, ir.read(cat, 'orders', { limit: 1 })))[0] as Page;
		expect(cdefault.rows[0]).not.toHaveProperty('doc');
		expect(dflt.rows[0]).toHaveProperty('doc');
		expect(explicit.rows[0]!.doc).toEqual({ big: explicit.rows[0]!.id });
		expect(Object.keys(explicit.rows[0]!).sort()).toEqual(['color', 'doc', 'id', 'span']);
	});

	it('rule 16: a named similarity ranks by the index, re-ranks limit × candidates exactly, and returns limit', async () => {
		const out = (await run(caller, { kind: 'similar', collection: 'orders', similarity: 'hue', input: {}, limit: 2 }))[0] as RowData[];
		const north = new Set(ACCOUNTS.filter((a) => a.region === 'north').map((a) => a.id));
		const pool = ORDERS.filter((o) => o.color !== null && o.status !== 'held' && north.has(o.account))
			.map((o) => ({ o, d: Math.hypot(...o.color!) })).sort((a, b) => a.d - b.d || a.o.id.localeCompare(b.o.id)).slice(0, 6);
		expect(reranked).toBe(Math.min(6, pool.length));
		const expected = pool.sort((a, b) => Math.abs(a.o.color![0]! - 0.5) - Math.abs(b.o.color![0]! - 0.5)).slice(0, 2).map((x) => x.o.id);
		expect(out.map((r) => r.id)).toEqual(expected);
		expect(typeof out[0]!.$distance).toBe('number');
	});

	it('search: rows matching every word rank first; a collection without searchable fields refuses', async () => {
		const page = (await run(workspace, ir.read(cat, 'accounts', { search: 'acme alp', limit: 10, select: { name: true } })))[0] as Page;
		expect(page.rows.map((r) => r.name)).toEqual(expect.arrayContaining(['alpha acme', 'acme north', 'delta acme works']));
		expect(page.rows[0]!.name).toBe('alpha acme');
		expect(page.rows).toHaveLength(3);
		await expect(run(workspace, ir.read(cat, 'orders', { search: 'x', limit: 1 }))).rejects.toMatchObject({ code: 'invalid' });
	});

	it('aggregate: buckets by month and through a one-relation, exact decimal sums, paged', async () => {
		const out = (await run(workspace, ir.aggregate(cat, 'orders', { by: ['account.region', { month: 'placed' }], count: true, sum: ['total'], all: true })))[0] as Page;
		const region = (o: typeof ORDERS[number]) => ACCOUNTS.find((a) => a.id === o.account)!.region;
		expect(out.rows.length).toBeGreaterThan(2);
		for (const g of out.rows) {
			const key = g.key as { [k: string]: Json };
			const members = ORDERS.filter((o) => region(o) === key['account.region'] && (key.placed as { $d: string }).$d === '2026-09-01');
			expect(g.count).toBe(members.length);
			const total = (g.sum as { total: { $dec: string } }).total.$dec;
			expect(Math.round(Number(total) * 100)).toBe(members.reduce((s, o) => s + Math.round(Number(o.total) * 100), 0));
		}
		const p1 = (await run(workspace, ir.aggregate(cat, 'orders', { by: ['status'], count: true, limit: 2 })))[0] as Page;
		const p2 = (await run(workspace, ir.aggregate(cat, 'orders', { by: ['status'], count: true, limit: 2, after: p1.next })))[0] as Page;
		expect([...p1.rows, ...p2.rows].map((r) => (r.key as { status: string }).status)).toEqual(['closed', 'held', 'open']);
		expect(p2.next).toBeNull();
	});

	it('rule 9: `all` past its caps is tooLarge, never clamped (rows, bytes, relation arms)', async () => {
		const small = readEngine({ db, manifest, allBytes: 1000 });
		await expect(small.run([ir.read(cat, 'orders', { all: true })], workspace, bindings)).rejects.toMatchObject({ code: 'tooLarge' });
		await pg.exec(`insert into lines (id, "order", sku, amount) select gen_random_uuid(), '${ORDERS[0]!.id}', 'bulk', 1 from generate_series(1, 10001)`);
		await expect(run(workspace, ir.get(cat, 'orders', ORDERS[0]!.id, { select: { lines: { all: true } } }))).rejects.toMatchObject({ code: 'tooLarge' });
		const limited = (await run(workspace, ir.get(cat, 'orders', ORDERS[0]!.id, { select: { lines: { limit: 5 } } })))[0] as { lines: RowData[] };
		expect(limited.lines).toHaveLength(5);
		await pg.exec(`insert into notes (id, about__accounts, body) select gen_random_uuid(), '${ACCOUNTS[0]!.id}', 'x' from generate_series(1, 50001)`);
		await expect(run(workspace, ir.read(cat, 'notes', { all: true, select: { body: true } }))).rejects.toMatchObject({ code: 'tooLarge' });
	}, 60_000);
});
