import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Predicate, Schema } from 'effect';
import { PgliteDb, Pristine } from '../src/node/db/pglite.ts';
import { dbError } from '../src/engine/db/wire.ts';
import { TenantDb, type TenantDbShape } from '../src/engine/db/tenant-db.ts';
import type { Json } from '../src/decl/values.ts';
import type { Authority, Reader, RowData } from '../src/engine/contracts.ts';
import {
	aggregate,
	decodeView,
	where,
	whereSql,
	type FieldInfo,
	type Pred
} from '@norbital-ai/store';
import { get, read, type ReadIR } from '../src/protocol/reads.ts';
import { fromStore, storeSync } from '../src/protocol/errors.ts';
import { readOptions } from '../src/engine/query/reader.ts';
import { lowerRead, readEngine, readTargets } from '../src/engine/query/engine.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { transformBridge } from '../src/engine/write/act.ts';
import { LIMITS } from '../src/engine/contracts.ts';
import { evaluate } from '../src/engine/query/eval.ts';
import { browserCatalog } from '../src/protocol/catalog.ts';
import { exposure } from '../src/engine/access/exposure.ts';
import { DDL, bindings, manifest, rep } from './query.fixture.ts';
// ── a PGlite TenantDb: `read` runs its statements in order inside one call ──
let pg: PGlite;
let reads = 0,
	statementCount = 0;
let native: TenantDbShape;
const db = TenantDb.typed({
	read: (statements) =>
		Effect.suspend(() => {
			reads++;
			statementCount += statements.length;
			return native.read(statements);
		}),
	write: (statement, lock) => native.write(statement, lock),
	transaction: (batch) => native.transaction(batch),
	session: () => native.session()
});
const exec = (text: string) => Effect.tryPromise({ try: () => pg.exec(text), catch: dbError });
const query = (text: string, params: readonly Json[] = []) => native.write({ text, params });
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const id = (kind: number, n: number) =>
	`00000000-0000-4000-8${kind}00-${n.toString(16).padStart(12, '0')}`;
const ACCOUNTS = [
	'alpha acme',
	'beta supplies',
	'acme north',
	'gamma',
	'delta acme works',
	'epsilon'
].map((name, i) => ({
	id: id(1, i),
	name,
	region: ['north', 'south', 'north', null, 'north', 'south'][i]!
}));
const ORDERS = Array.from({ length: 40 }, (_, i) => {
	const d = 1 + Math.floor(rnd() * 28);
	return {
		id: id(2, i),
		account: pick(ACCOUNTS).id,
		status: pick(['open', 'closed', 'held']),
		total: (Math.floor(rnd() * 100000) / 100).toFixed(2),
		qty: Math.floor(rnd() * 5),
		email: pick(['a@x.io', 'A@X.IO', 'b@y.io', null]),
		placed: `2026-09-${String(d).padStart(2, '0')}`,
		at: new Date(
			Date.parse('2026-09-20T00:00:00Z') + Math.floor(rnd() * 10 * 86400000)
		).toISOString(),
		tags: ['a', 'b', 'c'].filter(() => rnd() < 0.4),
		note: pick(['blue box', 'red', 'rose', null]),
		span:
			rnd() < 0.3
				? null
				: {
						from: `2026-09-${String(d).padStart(2, '0')}`,
						to:
							rnd() < 0.3
								? null
								: `2026-09-${String(Math.min(28, d + Math.floor(rnd() * 10))).padStart(2, '0')}`
					},
		color: rnd() < 0.2 ? null : [rnd(), rnd(), rnd()].map((x) => Math.round(x * 100) / 100),
		spot: rnd() < 0.3 ? null : { lat: 3 + rnd(), lng: 101 + rnd() }
	};
});
const LINES = Array.from({ length: 60 }, (_, i) => ({
	id: id(3, i),
	order: pick(ORDERS).id,
	sku: pick(['s1', 's2', 's3']),
	amount: (Math.floor(rnd() * 10000) / 100).toFixed(2)
}));
const NOTES = Array.from({ length: 20 }, (_, i) => ({
	id: id(4, i),
	about:
		rnd() < 0.5
			? { model: 'accounts', id: pick(ACCOUNTS).id }
			: { model: 'orders', id: pick(ORDERS).id },
	body: pick(['call back', 'paid', 'late'])
}));
const engine = readEngine({
	db,
	manifest,
	allBytes: 8 * 1024 * 1024,
	index: (c, name) =>
		c === 'orders' && name === 'hue'
			? {
					probe: Effect.fnUntraced(function* () {
						return { vector: [0, 0, 0], where: { status: { ne: 'held' } } };
					}),
					// the exact metric is not the index's: distance of the first channel from 0.5
					rerank: Effect.fnUntraced(function* (_input, rows) {
						reranked = rows.length;
						return rows.map((row) =>
							Math.abs(
								Schema.decodeUnknownSync(Schema.Array(Schema.Number))(row['color'])[0]! - 0.5
							)
						);
					})
				}
			: undefined
});
let reranked = 0;
const cat = engine.catalog;
const caller: Reader = { as: 'caller', authority: rep };
const workspace: Reader = { as: 'workspace' };
const run = (reader: Reader, ...batch: ReadIR[]) => engine.run(batch, reader, bindings);
type Page = {
	rows: RowData[];
	next: string | null;
};
const setup = Effect.fnUntraced(function* () {
	pg = yield* PgliteDb.open();
	native = PgliteDb.make(pg);
	yield* exec(DDL);
	for (const a of ACCOUNTS)
		yield* query('insert into accounts (id, name, region, secret) values ($1, $2, $3, $4)', [
			a.id,
			a.name,
			a.region,
			'shh'
		]);
	for (const o of ORDERS)
		yield* query(
			`insert into orders (id, account, status, total, qty, email, placed, at, tags, note, span, doc, color, spot)
		values ($1, $2, $3, $4, $5, $6, $7, $8, ARRAY(SELECT jsonb_array_elements_text($9::jsonb)), $10, case when $11::text is null then null else daterange($11::date, $12::date, '[]') end, $13, $14::vector, $15::point)`,
			[
				o.id,
				o.account,
				o.status,
				o.total,
				o.qty,
				o.email,
				o.placed,
				o.at,
				o.tags,
				o.note,
				o.span?.from ?? null,
				o.span?.to ?? null,
				{ big: o.id },
				o.color === null ? null : `[${o.color.join(',')}]`,
				o.spot === null ? null : `(${o.spot.lng},${o.spot.lat})`
			]
		);
	for (const l of LINES)
		yield* query('insert into lines (id, "order", sku, amount) values ($1, $2, $3, $4)', [
			l.id,
			l.order,
			l.sku,
			l.amount
		]);
	for (const n of NOTES)
		yield* query(
			'insert into notes (id, about__accounts, about__orders, body) values ($1, $2, $3, $4)',
			[
				n.id,
				n.about.model === 'accounts' ? n.about.id : null,
				n.about.model === 'orders' ? n.about.id : null,
				n.body
			]
		);
});
60000;
describe('next query engine (PGlite)', () => {
	it.live(
		'a write callback crossing preserves keyed read dependencies, answer positions and binding groups',
		() =>
			Effect.gen(function* () {
				yield* setup();
				const bridge = transformBridge(manifest, db, {
					id: 'callback-read-batch',
					kind: 'create',
					target: 'orders',
					input: [],
					ctx: {
						actor: { kind: 'system', run: 'callback-read-batch', by: { platform: 'test' } },
						now: bindings.now,
						today: bindings.today,
						tz: bindings.tz,
						seed: 'batch'
					},
					budget: {
						crossings: LIMITS.crossings.write,
						readBytes: LIMITS.readBytes
					}
				});
				const accounts = read(cat, 'accounts', {
					all: true,
					where: { region: { eq: 'north' } },
					select: { name: true }
				});
				const orders = read(cat, 'orders', {
					all: true,
					where: { account: { in: { member: '1:accounts', field: 'id' } } },
					select: { account: true }
				});
				if (accounts.kind !== 'read' || orders.kind !== 'read')
					throw new Error('The fixture declares native row reads.');
				const before = statementCount;
				const answers = yield* bridge.cross([
					{
						_tag: 'read',
						params: { scope: 'shared', n: 1 },
						read: {
							...accounts,
							member: 'accounts',
							cte: '1:accounts'
						}
					},
					{ _tag: 'notify', notices: null },
					{
						_tag: 'read',
						params: { n: 1, scope: 'shared' },
						read: {
							...orders,
							member: 'orders',
							cte: '1:orders'
						}
					},
					{
						_tag: 'read',
						params: { scope: 'separate' },
						read: read(cat, 'notes', { all: true, select: { body: true } })
					}
				]);
				expect(statementCount - before).toBe(2);
				expect(answers).toHaveLength(4);
				expect(answers[1]).toEqual({
					ok: false,
					error: { kind: 'bolt', code: 'unsupported', message: 'a write callback cannot notify' }
				});
				const page = Schema.Struct({
					rows: Schema.Array(Schema.Struct({ id: Schema.String })),
					next: Schema.NullOr(Schema.String)
				});
				const rows = [0, 2, 3].map((index) => {
					const answer = answers[index];
					expect(answer?.ok).toBe(true);
					if (answer === undefined || !answer.ok)
						throw new Error('The native batch must answer every read.');
					return Schema.decodeUnknownSync(page)(answer.value)
						.rows.map((row) => row.id)
						.sort();
				});
				const north = ACCOUNTS.filter((account) => account.region === 'north').map(
					(account) => account.id
				);
				expect(rows[0]).toEqual([...north].sort());
				expect(rows[1]).toEqual(
					ORDERS.filter((order) => north.includes(order.account))
						.map((order) => order.id)
						.sort()
				);
				expect(rows[2]).toEqual(NOTES.map((note) => note.id).sort());
				expect(bridge.tables().toSorted()).toEqual(['accounts', 'notes', 'orders']);
				expect(bridge.fingerprints()).toHaveLength(2);
				const notes = read(cat, 'notes', { all: true });
				if (notes.kind !== 'read') throw new Error('The fixture declares a native row read.');
				const independent = yield* bridge.cross([
					{
						_tag: 'read',
						params: {},
						read: { ...notes, model: 'absent' }
					},
					{
						_tag: 'read',
						params: {},
						read: read(cat, 'notes', { all: true, select: { body: true } })
					}
				]);
				expect(independent[0]?.ok).toBe(false);
				expect(independent[1]?.ok).toBe(true);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.effect(
		"a read request's targets are its roots, its layers and every model its filters hop into",
		() =>
			Effect.sync(() => {
				const request = lowerRead(manifest, 'query', [
					{
						orders: { where: { lines: { some: { sku: { eq: 's1' } } } }, fields: ['status'] },
						'orders.account': { fields: ['name'] },
						notes: { fields: ['body'] }
					}
				]);
				expect(request.kind).toBe('request');
				expect([...readTargets(cat, request)].sort()).toEqual([
					'accounts',
					'lines',
					'notes',
					'orders'
				]);
			})
	);
	it.live(
		'K3, rule 11a: grammar-generated predicates decode, round-trip, and agree in SQL and JS for the workspace, an admin and a masked caller; a corrupted clause is invalid',
		() =>
			Effect.gen(function* () {
				yield* setup();
				const all = Effect.fnUntraced(function* (c: string, reader: Reader, select?: object) {
					return (
						(yield* run(
							reader,
							read(cat, c, { all: true, ...(select === undefined ? {} : { select }) })
						))[0] as Page
					).rows;
				});
				const everything = {
					status: true,
					total: true,
					qty: true,
					email: true,
					placed: true,
					at: true,
					tags: true,
					note: true,
					span: true,
					spot: true,
					account: true,
					doc: true
				};
				const rows = {
					accounts: yield* all('accounts', workspace, { name: true, region: true, secret: true }),
					orders: yield* all('orders', workspace, everything),
					lines: yield* all('lines', workspace),
					notes: yield* all('notes', workspace)
				} as {
					[c: string]: RowData[];
				};
				const related = (c: string, rel: string, target: string, row: RowData): RowData[] => {
					const one = cat.models.get(c)!.one.get(rel);
					if (one !== undefined) {
						const v = row[rel] as
							| string
							| {
									model: string;
									id: string;
							  }
							| null;
						const to = typeof v === 'string' ? v : v?.model === target ? v.id : null;
						return rows[target]!.filter((r) => r.id === to);
					}
					const m = cat.models.get(c)!.many.get(rel)!;
					const fk = m.column.split('__')[0]!;
					return rows[target]!.filter((r) => {
						const v = r[fk] as
							| string
							| {
									id: string;
							  }
							| null;
						return (typeof v === 'string' ? v : v?.id) === row.id;
					});
				};
				// the grammar of §3.3.9 over the catalogue: a field, an operator its kind admits, an operand its kind admits, a
				// literal from the column's own values; relations by their quantifiers; combinators; to depth 4
				const untag = (value: unknown): Json =>
					Predicate.isObject(value) &&
					Object.keys(value).length === 1 &&
					typeof value['$dec'] === 'string'
						? value['$dec']
						: Schema.decodeUnknownSync(Schema.Json)(value);
				const pool = (m: string, f: string): Json[] =>
					[
						...new Set(
							rows[m]!.flatMap((row) =>
								row[f] === undefined || row[f] === null ? [] : [JSON.stringify(untag(row[f]))]
							)
						)
					].map((value) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(value));
				const EXPOSED: {
					[m: string]: readonly string[];
				} = { notes: ['body'] };
				type Opts = {
					actor: boolean;
					text: boolean;
				};
				const cmp = () => pick(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);
				const dayBoundary = () =>
					pick(['2026-08-31', '2026-09-01', '2026-09-21', '2026-10-01', '2027-01-01']);
				const instantBoundary = () => new Date(`${dayBoundary()}T00:00:00+08:00`).toISOString();
				function leaf(m: string, f: FieldInfo, o: Opts): object {
					const vals = pool(m, f.name),
						v = () => pick(vals);
					const list = () => vals.filter(() => rnd() < 0.4);
					switch (f.kind) {
						case 'enum':
							return pick([
								{ [cmp().slice(0, 2) === 'eq' ? 'eq' : 'ne']: pick(f.values!) },
								{ [pick(['in', 'nin'])]: f.values!.filter(() => rnd() < 0.5) }
							]);
						case 'decimal':
						case 'int': {
							const nums = FIELDS(m).filter(
								(g) => g.name !== f.name && (g.kind === 'decimal' || g.kind === 'int')
							);
							return pick([
								{ [cmp()]: v() },
								{ [cmp()]: v() },
								{ in: list() },
								...nums.map((g) => ({ [cmp()]: { field: g.name } })),
								...(f.kind === 'decimal' ? [{ gte: { param: 'min' } }] : [])
							]);
						}
						case 'date':
							return pick([
								{ [cmp()]: v() },
								{ gte: pick(['2026-09-20', '2026-09-25', '2026-09-28']) },
								{ [pick(['gte', 'lt'])]: dayBoundary() }
							]);
						case 'instant':
							return pick([
								{ [cmp()]: v() },
								{
									gt: new Date(Date.parse(bindings.now) + pick([-100, 100]) * 3600000).toISOString()
								},
								{ [pick(['gte', 'lt'])]: instantBoundary() }
							]);
						case 'period':
							return pick([
								{
									contains: pick([
										Schema.decodeUnknownSync(Schema.Struct({ from: Schema.String }))(v()).from,
										'2026-09-15',
										dayBoundary()
									])
								},
								{
									[pick(['overlaps', 'within'])]: {
										from: pick(['2026-08-31', '2026-09-01']),
										to: pick([null, '2026-09-12', bindings.today, '2026-10-01'])
									}
								},
								{ isNull: rnd() < 0.5 }
							]);
						case 'point':
							return pick([
								{ near: [{ lat: 3.5, lng: 101.5 }, pick([10000, 40000])] },
								{
									within: {
										bbox: [
											{ lat: 3, lng: 101 },
											{ lat: 3.5, lng: 101.5 }
										]
									}
								},
								{
									within: {
										polygon: [
											{ lat: 3, lng: 101 },
											{ lat: 4, lng: 101 },
											{ lat: 3.5, lng: 102 }
										]
									}
								},
								{ isNull: true }
							]);
						case 'json':
							return pick([
								{ contains: { big: pick(rows.orders!).id } },
								{ contains: {} },
								{ isNull: false }
							]);
						case 'text': {
							if (f.many)
								return pick([
									{ has: pick(['a', 'b', 'c']) },
									{ hasAny: ['a', 'b', 'c'].filter(() => rnd() < 0.5) },
									{ hasAll: ['a', 'b'].filter(() => rnd() < 0.7) },
									{ isEmpty: rnd() < 0.5 }
								]);
							const s = vals.length === 0 ? 'x' : String(v());
							const like = pick([
								`%${s.slice(1, 3)}%`,
								`${s.slice(0, 1).toUpperCase()}%`,
								`%${s.slice(-1)}`,
								`_${s.slice(1)}`,
								'%\\%%'
							]);
							const texts = FIELDS(m).filter(
								(g) => g.name !== f.name && g.kind === 'text' && !g.many
							);
							return pick([
								{ eq: s },
								{ ne: s },
								{ in: list() },
								{ like },
								{ isNull: rnd() < 0.5 },
								...texts.map((g) => ({ [pick(['eq', 'ne'])]: { field: g.name } })),
								...(f.email && o.actor
									? [{ eq: { actor: 'email' } }, { eq: { actor: 'email' } }]
									: []),
								...(o.text ? [{ [pick(['lt', 'gte'])]: s }] : [])
							]);
						}
						default:
							return { isNull: rnd() < 0.5 };
					}
				}
				const FIELDS = (m: string) =>
					[...cat.models.get(m)!.fields.values()].filter(
						(f) =>
							!f.name.includes('.') &&
							!['id', 'revision', 'created_by', 'updated_by', 'created_at', 'updated_at'].includes(
								f.name
							) &&
							!['vector', 'file', 'custom', 'ref', 'id'].includes(f.kind) &&
							!f.computed &&
							(EXPOSED[m] ?? [f.name]).includes(f.name)
					);
				function gen(m: string, depth: number, o: Opts): object {
					const info = cat.models.get(m)!;
					const r = rnd();
					if (depth < 4 && r < 0.12) return { and: [gen(m, depth + 1, o), gen(m, depth + 1, o)] };
					if (depth < 4 && r < 0.24) return { or: [gen(m, depth + 1, o), gen(m, depth + 1, o)] };
					if (depth < 4 && r < 0.3) return { not: gen(m, depth + 1, o) };
					if (depth < 4 && r < 0.5) {
						const rels = [...info.one.keys(), ...info.many.keys()].filter(
							(x) => m !== 'notes' || x === 'about'
						);
						const rel = pick(rels);
						const one = info.one.get(rel);
						if (one !== undefined) {
							const t = pick(one.targets);
							const body =
								rnd() < 0.7
									? { is: gen(t, depth + 1, o) }
									: pick([
											{ eq: pick(rows[t]!).id },
											{ in: rows[t]!.filter(() => rnd() < 0.3).map((x) => x.id) },
											{ isNull: rnd() < 0.5 }
										]);
							return { [rel]: one.targets.length > 1 ? { [t]: body } : body };
						}
						const child = info.many.get(rel)!.child;
						const amounts = pool(child, 'amount');
						return {
							[rel]: pick([
								{ [pick(['some', 'none', 'every'])]: gen(child, depth + 1, o) },
								{ count: { [cmp()]: pick([0, 1, 2]) } },
								...(child === 'lines'
									? [
											{
												[pick(['sum', 'min', 'max', 'avg'])]: {
													of: 'amount',
													[cmp()]: pick([...amounts, 0, '50'])
												}
											}
										]
									: [])
							])
						};
					}
					const f = pick(FIELDS(m));
					return { [f.name]: leaf(m, f, o) };
				}
				// rule 11a's mutation step: one operator object or relation body becomes a shape every kind refuses
				const BAD = [{}, { nope: 1 }, { eq: null }, { isNull: 'yes' }, { eq: { now: '+-1d' } }];
				function corrupt(m: string, w: object): object {
					const spots: {
						obj: {
							[k: string]: unknown;
						};
						key: string;
						rel: boolean;
					}[] = [];
					const walk = (
						mm: string,
						node: {
							[k: string]: unknown;
						}
					) => {
						const info = cat.models.get(mm)!;
						for (const [k, v] of Object.entries(node)) {
							if (k === 'and' || k === 'or')
								(v as object[]).forEach((x) =>
									walk(
										mm,
										x as {
											[k: string]: unknown;
										}
									)
								);
							else if (k === 'not')
								walk(
									mm,
									v as {
										[k: string]: unknown;
									}
								);
							else if (info.many.has(k)) {
								spots.push({ obj: node, key: k, rel: true });
								for (const [q, x] of Object.entries(v as object))
									if (q === 'some' || q === 'none' || q === 'every')
										walk(info.many.get(k)!.child, x);
							} else if (info.one.has(k)) {
								spots.push({ obj: node, key: k, rel: true });
								const one = info.one.get(k)!;
								const body = (one.targets.length > 1 ? Object.values(v as object)[0] : v) as {
									is?: object;
								};
								if (body.is !== undefined)
									walk(
										one.targets.length > 1 ? Object.keys(v as object)[0]! : one.targets[0]!,
										body.is as {
											[k: string]: unknown;
										}
									);
							} else spots.push({ obj: node, key: k, rel: false });
						}
					};
					const copy = JSON.parse(JSON.stringify(w)) as {
						[k: string]: unknown;
					};
					walk(m, copy);
					const s = pick(spots);
					s.obj[s.key] = s.rel ? pick([{}, { bogus: {} }]) : pick(BAD);
					return copy;
				}
				const admin: Authority = { ...rep, admin: true };
				for (const [reader, authority] of [
					[workspace, null],
					[{ as: 'caller', authority: admin }, admin],
					[caller, rep]
				] as [Reader, Authority | null][]) {
					const o = { actor: authority !== null, text: false };
					const wheres = Array.from({ length: 200 }, () => gen('orders', 0, o));
					const browser = authority === null ? cat : browserCatalog(exposure(manifest, authority));
					const preds: Pred[] = wheres.map((w) => {
						const p = storeSync(where(cat, 'orders', w));
						expect(storeSync(where(cat, 'orders', JSON.parse(JSON.stringify(w))))).toEqual(p);
						expect(storeSync(decodeView(browser, 'orders', { where: w })).dropped).toEqual([]);
						expect(() => storeSync(where(cat, 'orders', corrupt('orders', w)))).toThrow(
							expect.objectContaining({ code: 'invalid' })
						);
						return p;
					});
					const results = yield* db.read(
						preds.map((p) => storeSync(whereSql(cat, 'orders', p, readOptions(reader, bindings))))
					);
					const env = { cat, bindings, authority, scoped: authority !== null, related };
					const inScope = (r: RowData) =>
						authority === null ||
						authority.admin ||
						(authority.models.orders!.read['orders'] ?? []).some((a) =>
							evaluate({ ...env, scoped: false }, 'orders', a.where, r)
						);
					let telling = 0;
					const scoped = rows.orders!.filter(inScope).length;
					preds.forEach((p, i) => {
						const js = rows
							.orders!.filter((r) => inScope(r) && evaluate(env, 'orders', p, r))
							.map((r) => r.id)
							.sort();
						expect({
							w: JSON.stringify(wheres[i]),
							ids: results[i]!.rows.map((r) => r.id)
						}).toEqual({ w: JSON.stringify(wheres[i]), ids: js });
						if (js.length > 0 && js.length < scoped) telling++;
					});
					// most predicates split the rows: an all-empty or all-full run would prove nothing
					expect(telling).toBeGreaterThan(preds.length / 3);
					// text ordering follows the database collation, which the JS evaluator does not model: SQL only
					const text = Array.from({ length: 30 }, () => gen('orders', 0, { ...o, text: true }));
					yield* db.read(
						text.map((w) =>
							storeSync(
								whereSql(
									cat,
									'orders',
									storeSync(where(cat, 'orders', w)),
									readOptions(reader, bindings)
								)
							)
						)
					);
				}
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'rules 9 and 11: explicit pages walk every row once in orderBy-then-id order; a cursor is bound to its query',
		() =>
			Effect.gen(function* () {
				yield* setup();
				for (const orderBy of [
					{ total: 'desc' },
					{ note: 'asc' },
					[{ status: 'asc' }, { note: 'desc' }]
				]) {
					const seen: string[] = [];
					let after: string | undefined;
					do {
						const page = (yield* run(
							workspace,
							read(cat, 'orders', {
								orderBy,
								limit: 7,
								...(after === undefined ? {} : { after }),
								select: { total: true, note: true, status: true }
							})
						))[0] as Page;
						expect(page.rows.length).toBeLessThanOrEqual(7);
						seen.push(...page.rows.map((r) => r.id as string));
						after = page.next ?? undefined;
					} while (after !== undefined);
					const all = (
						(yield* run(
							workspace,
							read(cat, 'orders', { orderBy, all: true, select: { total: true } })
						))[0] as Page
					).rows.map((r) => r.id);
					expect(seen).toEqual(all);
					expect(new Set(seen).size).toBe(ORDERS.length);
				}
				const byTotal = (
					(yield* run(
						workspace,
						read(cat, 'orders', {
							orderBy: { total: 'desc' },
							all: true,
							select: { total: true }
						})
					))[0] as Page
				).rows;
				const totals = byTotal.map((r) =>
					Number(
						(
							r.total as {
								$dec: string;
							}
						).$dec
					)
				);
				expect(totals).toEqual([...totals].sort((a, b) => b - a));
				const first = (yield* run(workspace, read(cat, 'orders', { limit: 3 })))[0] as Page;
				expect(
					yield* Effect.flip(
						run(
							workspace,
							read(cat, 'orders', { limit: 3, after: first.next!, where: { qty: { gt: 0 } } })
						)
					)
				).toMatchObject({ code: 'badCursor' });
				expect((yield* run(workspace, read(cat, 'orders', { limit: 0 })))[0]).toEqual({
					rows: [],
					next: null
				});
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'nearest first: a point orders by great-circle distance from a point, pages by cursor, rows without a point last',
		() =>
			Effect.gen(function* () {
				yield* setup();
				const at = { lat: 3.5, lng: 101.5 };
				const rad = (d: number) => (d * Math.PI) / 180;
				const metres = (p: { lat: number; lng: number }) =>
					6371008.8 *
					2 *
					Math.asin(
						Math.sqrt(
							Math.sin(rad(p.lat - at.lat) / 2) ** 2 +
								Math.cos(rad(at.lat)) *
									Math.cos(rad(p.lat)) *
									Math.sin(rad(p.lng - at.lng) / 2) ** 2
						)
					);
				const want = [...ORDERS]
					.sort((x, y) =>
						x.spot === null
							? y.spot === null
								? x.id.localeCompare(y.id)
								: 1
							: y.spot === null
								? -1
								: metres(x.spot) - metres(y.spot) || x.id.localeCompare(y.id)
					)
					.map((o) => o.id);
				const orderBy = { spot: { near: at } };
				const seen: string[] = [];
				let after: string | undefined;
				do {
					const page = (yield* run(
						workspace,
						read(cat, 'orders', {
							orderBy,
							limit: 7,
							...(after === undefined ? {} : { after }),
							select: { spot: true }
						})
					))[0] as Page;
					seen.push(...page.rows.map((r) => r.id as string));
					after = page.next ?? undefined;
				} while (after !== undefined);
				expect(seen).toEqual(want);
				// through a one-relation's point is the same key shape; a non-point field is refused
				expect(() => read(cat, 'orders', { orderBy: { total: { near: at } }, limit: 5 })).toThrow(
					/not a point/
				);
				expect(() =>
					read(cat, 'orders', { orderBy: { spot: { near: { lat: 99, lng: 1 } } }, limit: 5 })
				).not.toThrow(); // the grammar checks shape, not range
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'rules 11 and 14: a related sort key orders by the target field, pages through it by cursor, and needs the target read unmasked',
		() =>
			Effect.gen(function* () {
				yield* setup();
				const acc = new Map(ACCOUNTS.map((a) => [a.id, a]));
				const ord = new Map(ORDERS.map((o) => [o.id, o]));
				const byId = (
					x: {
						id: string;
					},
					y: {
						id: string;
					}
				) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
				const walk = Effect.fnUntraced(function* (
					reader: Reader,
					model: string,
					orderBy: Json,
					limit: number
				) {
					const seen: string[] = [];
					let after: string | undefined;
					do {
						const page = (yield* run(
							reader,
							read(cat, model, {
								orderBy,
								limit,
								...(after === undefined ? {} : { after })
							})
						))[0] as Page;
						seen.push(...page.rows.map((r) => r.id as string));
						after = page.next ?? undefined;
					} while (after !== undefined);
					return seen;
				});
				// one hop: account name ascending (distinct first letters: the database collation and JS agree), then id
				const byName = [...ORDERS]
					.sort(
						(x, y) => acc.get(x.account)!.name.localeCompare(acc.get(y.account)!.name) || byId(x, y)
					)
					.map((o) => o.id);
				expect(
					(
						(yield* run(
							workspace,
							read(cat, 'orders', { orderBy: { account: { name: 'asc' } }, all: true })
						))[0] as Page
					).rows.map((r) => r.id)
				).toEqual(byName);
				expect(yield* walk(workspace, 'orders', { account: { name: 'asc' } }, 7)).toEqual(byName);
				// two hops, descending
				const byOrderAccount = [...LINES]
					.sort(
						(x, y) =>
							acc
								.get(ord.get(y.order)!.account)!
								.name.localeCompare(acc.get(ord.get(x.order)!.account)!.name) || byId(x, y)
					)
					.map((l) => l.id);
				expect(
					yield* walk(workspace, 'lines', { order: { account: { name: 'desc' } } }, 9)
				).toEqual(byOrderAccount);
				// a nullable target field: nulls first descending, as an own field; then an own key; every row once across pages
				const mixed: Json = [{ account: { region: 'desc' } }, { total: 'asc' }];
				const all = (
					(yield* run(workspace, read(cat, 'orders', { orderBy: mixed, all: true })))[0] as Page
				).rows.map((r) => r.id as string);
				const region = (id: string) => acc.get(ord.get(id)!.account)!.region;
				expect(
					all
						.slice(0, all.filter((id) => region(id) === null).length)
						.every((id) => region(id) === null)
				).toBe(true);
				expect(yield* walk(workspace, 'orders', mixed, 5)).toEqual(all);
				expect(new Set(all).size).toBe(ORDERS.length);
				// a caller: in scope only, same order; a cursor is bound to its related key
				const scoped = byName.filter((id) => acc.get(ord.get(id)!.account)!.region === 'north');
				expect(yield* walk(caller, 'orders', { account: { name: 'asc' } }, 4)).toEqual(scoped);
				const first = (yield* run(
					caller,
					read(cat, 'orders', { orderBy: { account: { name: 'asc' } }, limit: 3 })
				))[0] as Page;
				expect(
					yield* Effect.flip(
						run(
							caller,
							read(cat, 'orders', {
								orderBy: { account: { region: 'asc' } },
								limit: 3,
								after: first.next!
							})
						)
					)
				).toMatchObject({ code: 'badCursor' });
				// rule 14: a masked target field, an unread target and a masked FK refuse; the workspace sorts by any of them
				expect(
					yield* Effect.flip(
						run(caller, read(cat, 'orders', { orderBy: { account: { secret: 'asc' } }, limit: 5 }))
					)
				).toMatchObject({ code: 'invalidInput' });
				const { accounts: _accounts, ...withoutAccounts } = rep.models;
				const noAccounts: Reader = {
					as: 'caller',
					authority: { ...rep, models: withoutAccounts }
				};
				expect(
					yield* Effect.flip(
						run(
							noAccounts,
							read(cat, 'orders', { orderBy: { account: { name: 'asc' } }, limit: 5 })
						)
					)
				).toMatchObject({ code: 'invalidInput' });
				const maskedFk: Reader = {
					as: 'caller',
					authority: {
						...rep,
						models: {
							...rep.models,
							orders: {
								...rep.models.orders!,
								masks: { orders: { account: { t: 'const', value: false } } }
							}
						}
					}
				};
				expect(
					yield* Effect.flip(
						run(maskedFk, read(cat, 'orders', { orderBy: { account: { name: 'asc' } }, limit: 5 }))
					)
				).toMatchObject({ code: 'invalidInput' });
				expect(
					(
						(yield* run(
							workspace,
							read(cat, 'orders', { orderBy: { account: { secret: 'asc' } }, limit: 5 })
						))[0] as Page
					).rows
				).toHaveLength(5);
				// the grammar: an arc is not a hop, three hops and a dotted key are invalid
				expect(() => read(cat, 'notes', { orderBy: { about: { name: 'asc' } }, limit: 5 })).toThrow(
					/not a one-relation/
				);
				expect(() =>
					read(cat, 'lines', {
						orderBy: { order: { account: { name: { x: 'asc' } } } },
						limit: 5
					})
				).toThrow(/at most 2 relations/);
				expect(() => read(cat, 'orders', { orderBy: { 'account.name': 'asc' }, limit: 5 })).toThrow(
					/one \{ field/
				);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('rule 12: one batch is one round trip; identical reads run once', () =>
		Effect.gen(function* () {
			yield* setup();
			const before = reads;
			const a = read(cat, 'accounts', { limit: 2 });
			const out = yield* run(
				workspace,
				a,
				get(cat, 'orders', ORDERS[0]!.id),
				a,
				yield* aggregate(cat, 'orders', { count: true }).pipe(Effect.mapError(fromStore))
			);
			expect(reads - before).toBe(1);
			expect(out[0]).toEqual(out[2]);
			expect((out[1] as RowData).id).toBe(ORDERS[0]!.id);
			expect(out[3]).toEqual({ count: 40 });
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		"rule 12: a batch of N reads is one statement, each read answered as if alone, under the caller's policies",
		() =>
			Effect.gen(function* () {
				yield* setup();
				const batch = [
					read(cat, 'accounts', { all: true, select: { name: true } }),
					read(cat, 'orders', { limit: 3, orderBy: { placed: 'desc' } }),
					get(cat, 'orders', ORDERS[1]!.id),
					get(cat, 'orders', ORDERS[2]!.id),
					yield* aggregate(cat, 'orders', { count: true, where: { status: { eq: 'open' } } }).pipe(
						Effect.mapError(fromStore)
					),
					read(cat, 'lines', {
						all: true,
						where: { sku: { eq: 's1' } },
						select: { amount: true }
					}),
					read(cat, 'notes', { limit: 0 })
				];
				for (const reader of [workspace, caller]) {
					const alone = [];
					for (const one of batch) alone.push((yield* run(reader, one))[0]);
					const [r0, s0] = [reads, statementCount];
					expect(yield* run(reader, ...batch)).toEqual(alone);
					expect([reads - r0, statementCount - s0]).toEqual([1, 1]);
				}
				// the caller sees only its scope in every member: rep reads the north accounts' orders
				const north = new Set(ACCOUNTS.filter((a) => a.region === 'north').map((a) => a.id));
				const [accounts, far] = yield* run(
					caller,
					read(cat, 'accounts', { all: true }),
					get(cat, 'orders', ORDERS.find((o) => !north.has(o.account))!.id)
				);
				expect((accounts as Page).rows.map((r) => r.id).sort()).toEqual([...north].sort());
				expect(far).toBeNull();
			}).pipe(Effect.provide(Pristine.layer))
	);
	/** A batch read labelled as a keyed query's member. */
	const member = (read: ReadIR, key: string, cte?: string): ReadIR =>
		({ ...read, member: key, ...(cte === undefined ? {} : { cte }) }) as ReadIR;
	it.live(
		"rule 12: a keyed member reads an earlier member's values inside the one statement, under that member's scope",
		() =>
			Effect.gen(function* () {
				yield* setup();
				const ref = (where: object, cte: string) =>
					member(
						read(cat, 'orders', { all: true, where, select: { account: true } }),
						'orders',
						cte
					);
				const north = ACCOUNTS.filter((a) => a.region === 'north').map((a) => a.id);
				for (const reader of [workspace, caller]) {
					const s0 = statementCount;
					const [accounts, orders] = (yield* run(
						reader,
						member(
							read(cat, 'accounts', {
								all: true,
								where: { region: { eq: 'north' } },
								select: { name: true }
							}),
							'accounts',
							'1:accounts'
						),
						ref({ account: { in: { member: '1:accounts', field: 'id' } } }, '1:orders')
					)) as [Page, Page];
					expect(statementCount - s0).toBe(1);
					expect(accounts.rows.map((r) => r.id).sort()).toEqual([...north].sort());
					const expected = ORDERS.filter((o) => north.includes(o.account))
						.map((o) => o.id)
						.sort();
					expect(orders.rows.map((r) => r.id).sort()).toEqual(expected);
				}
				// the referenced rows are the earlier member's as its reader sees them: the rep's accounts are its north ones
				const [, scoped] = (yield* run(
					caller,
					member(read(cat, 'accounts', { all: true }), 'accounts', '2:accounts'),
					ref({ account: { nin: { member: '2:accounts', field: 'id' } } }, '2:orders')
				)) as [Page, Page];
				expect(scoped.rows).toEqual([]);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		"rule 12: a member reference walks the earlier member's relation arms (a path, through a many arm)",
		() =>
			Effect.gen(function* () {
				yield* setup();
				const north = ACCOUNTS.filter((a) => a.region === 'north').map((a) => a.id);
				const orders = new Set(ORDERS.filter((o) => north.includes(o.account)).map((o) => o.id));
				const s0 = statementCount;
				const [, lines] = (yield* run(
					workspace,
					member(
						read(cat, 'accounts', {
							all: true,
							where: { region: { eq: 'north' } },
							select: { name: true, orders: { select: { status: true }, all: true } }
						}),
						'accounts',
						'3:accounts'
					),
					member(
						read(cat, 'lines', {
							all: true,
							where: { order: { in: { member: '3:accounts', field: 'orders.id' } } },
							select: { order: true }
						}),
						'lines',
						'3:lines'
					)
				)) as [Page, Page];
				expect(statementCount - s0).toBe(1);
				expect(lines.rows.map((r) => r.id).sort()).toEqual(
					LINES.filter((l) => orders.has(l.order))
						.map((l) => l.id)
						.sort()
				);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'an export arm `{ all: true }` returns every related row (no 21-row display cap), in one statement',
		() =>
			Effect.gen(function* () {
				yield* setup();
				const account = ACCOUNTS[0]!.id;
				for (let i = 0; i < 30; i++)
					yield* query(
						'insert into orders (id, account, status, total, qty, placed, at) values ($1, $2, $3, $4, $5, $6, $7)',
						[id(5, i), account, 'open', '1.00', 1, '2026-09-01', '2026-09-01T00:00:00Z']
					);
				const s0 = statementCount;
				const [page] = (yield* run(
					workspace,
					read(cat, 'accounts', {
						all: true,
						select: { name: true, orders: { select: { status: true }, all: true } }
					})
				)) as [Page];
				expect(statementCount - s0).toBe(1);
				const held = page.rows.find((r) => r.id === account)?.orders;
				expect(Array.isArray(held) ? held.length : -1).toBe(
					30 + ORDERS.filter((o) => o.account === account).length
				);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'rule 9: a keyed read member past its cap names itself; the rest of the batch is still one statement',
		() =>
			Effect.gen(function* () {
				yield* setup();
				const small = readEngine({ db, manifest, allBytes: 200 });
				const s0 = statementCount;
				expect(
					yield* Effect.flip(
						small.run(
							[
								member(read(cat, 'accounts', { limit: 1 }), 'one'),
								member(read(cat, 'orders', { all: true }), 'every')
							],
							workspace,
							bindings
						)
					)
				).toMatchObject({
					code: 'tooLarge',
					message: "member 'every': the read of orders is larger than 200 bytes; page it (rule 9)"
				});
				expect(statementCount - s0).toBe(1);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		"rule 13, decision 3: each level is scoped by its root's arms for that path, never the layer model's own grants; a layer out of scope is null (a ref) or absent (a list), its root stays",
		() =>
			Effect.gen(function* () {
				yield* setup();
				const north = new Set(ACCOUNTS.filter((a) => a.region === 'north').map((a) => a.id));
				const [accounts, orders, lines, far] = (yield* run(
					caller,
					read(cat, 'accounts', {
						all: true,
						select: { name: true, orders: { select: { status: true }, all: true } }
					}),
					read(cat, 'orders', { all: true, select: { account: { select: { name: true } } } }),
					read(cat, 'lines', { all: true, select: { order: { select: { status: true } } } }),
					get(cat, 'orders', ORDERS.find((o) => !north.has(o.account))!.id)
				)) as [Page, Page, Page, Json];
				expect(accounts.rows.map((r) => r.id).sort()).toEqual([...north].sort());
				expect(accounts.rows.flatMap((r) => r.orders as RowData[]).length).toBe(
					ORDERS.filter((o) => north.has(o.account)).length
				);
				expect(orders.rows.every((r) => r.account !== null)).toBe(true);
				expect(orders.rows.length).toBe(ORDERS.filter((o) => north.has(o.account)).length);
				expect(lines.rows.length).toBe(LINES.length);
				// lines' policy reads every order through `lines.order`: the orders grant is never consulted
				expect(lines.rows.every((r) => r.order !== null)).toBe(true);
				expect(far).toBeNull();
				// a `where` on the layer narrows that layer only: a line of a southern order keeps its row, its order nulls
				const northern: Pred = {
					t: 'one',
					rel: 'account',
					target: 'accounts',
					pred: { t: 'cmp', field: 'region', op: 'eq', arg: { _tag: 'Lit', value: 'north' } }
				};
				const narrowed: Reader = {
					as: 'caller',
					authority: {
						...rep,
						key: 'narrowed',
						models: {
							...rep.models,
							lines: {
								...rep.models['lines']!,
								read: {
									lines: [{ policy: 'rep', where: { t: 'const', value: true }, fields: 'all' }],
									'lines.order': [{ policy: 'rep', where: northern, fields: 'all' }]
								}
							}
						}
					}
				};
				const [narrow] = (yield* run(
					narrowed,
					read(cat, 'lines', { all: true, select: { order: { select: { status: true } } } })
				)) as [Page];
				expect(narrow.rows.length).toBe(LINES.length);
				expect(narrow.rows.filter((r) => r.order === null).length).toBe(
					LINES.filter((l) => !north.has(ORDERS.find((o) => o.id === l.order)!.account)).length
				);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'rule 14: a masked field neither leaks through where, order or select nor aggregates',
		() =>
			Effect.gen(function* () {
				yield* setup();
				const where = { total: { gt: '500' } };
				const [raw, masked] = [
					(yield* run(
						workspace,
						read(cat, 'orders', { all: true, where, select: { status: true, account: true } })
					))[0] as Page,
					(yield* run(
						caller,
						read(cat, 'orders', { all: true, where, select: { status: true, total: true } })
					))[0] as Page
				];
				const north = new Set(ACCOUNTS.filter((a) => a.region === 'north').map((a) => a.id));
				const oracle = raw.rows.filter((r) => north.has(r.account as string));
				expect(oracle.some((r) => r.status !== 'open')).toBe(true);
				expect(masked.rows.map((r) => r.id)).toEqual(
					oracle.filter((r) => r.status === 'open').map((r) => r.id)
				);
				const shown = (
					(yield* run(
						caller,
						read(cat, 'orders', { all: true, select: { status: true, total: true } })
					))[0] as Page
				).rows;
				expect(
					shown
						.filter((r) => r.status !== 'open')
						.every((r) => JSON.stringify(r.total) === '{"$masked":true}')
				).toBe(true);
				expect(
					shown
						.filter((r) => r.status === 'open')
						.every(
							(r) =>
								typeof (
									r.total as {
										$dec?: string;
									}
								).$dec === 'string'
						)
				).toBe(true);
				expect(
					yield* Effect.flip(
						run(
							caller,
							yield* aggregate(cat, 'orders', { max: ['total'] }).pipe(Effect.mapError(fromStore))
						)
					)
				).toMatchObject({ code: 'forbidden' });
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('rule 14: a masked foreign key reads masked, filters nothing and joins nothing', () =>
		Effect.gen(function* () {
			yield* setup();
			const blind: Reader = {
				as: 'caller',
				authority: {
					...rep,
					key: 'blind',
					models: {
						...rep.models,
						orders: {
							...rep.models['orders']!,
							masks: { orders: { account: { t: 'const', value: false } } }
						}
					}
				}
			};
			const [rows] = (yield* run(
				blind,
				read(cat, 'orders', { all: true, select: { account: true, status: true } })
			)) as [Page];
			expect(rows.rows.length).toBeGreaterThan(0);
			expect(rows.rows.map((r) => r.account)).toEqual(rows.rows.map(() => ({ $masked: true })));
			const [joined] = (yield* run(
				blind,
				read(cat, 'orders', { all: true, select: { account: { select: { name: true } } } })
			)) as [Page];
			expect(joined.rows.every((r) => r.account === null)).toBe(true);
			const [probe] = (yield* run(
				blind,
				read(cat, 'orders', { all: true, where: { account: { eq: ORDERS[0]!.account } } })
			)) as [Page];
			expect(probe.rows).toEqual([]);
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'rules 10 and 15, X-33: a workspace row is stored fields unmasked; a caller default row omits json; an explicit select returns it',
		() =>
			Effect.gen(function* () {
				yield* setup();
				const [ws, call] = (yield* Effect.all(
					[
						run(workspace, get(cat, 'accounts', ACCOUNTS[0]!.id)),
						run(caller, get(cat, 'accounts', ACCOUNTS[0]!.id))
					],
					{ concurrency: 'unbounded' }
				)) as [[RowData], [RowData]];
				expect(ws[0]).toMatchObject({ name: 'alpha acme', secret: 'shh', revision: 1 });
				expect(ws[0]).not.toHaveProperty('shout');
				expect(call[0]).toMatchObject({ shout: 'ALPHA ACME', secret: { $masked: true } });
				const [dflt, explicit] = (yield* run(
					workspace,
					read(cat, 'orders', { limit: 1 }),
					read(cat, 'orders', { limit: 1, select: { doc: true, span: true, color: true } })
				)) as [Page, Page];
				expect(ws[0]).toHaveProperty('created_at');
				const cdefault = (yield* run(caller, read(cat, 'orders', { limit: 1 })))[0] as Page;
				expect(cdefault.rows[0]).not.toHaveProperty('doc');
				expect(dflt.rows[0]).toHaveProperty('doc');
				expect(explicit.rows[0]!.doc).toEqual({ big: explicit.rows[0]!.id });
				expect(Object.keys(explicit.rows[0]!).sort()).toEqual(['color', 'doc', 'id', 'span']);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'rule 16: a named search ranks by the index, re-ranks limit × candidates exactly, and returns a page',
		() =>
			Effect.gen(function* () {
				yield* setup();
				const [answer] = yield* run(
					caller,
					lowerRead(manifest, 'read', [
						'orders',
						{ search: { hue: {} }, select: { color: true }, limit: 2 }
					])
				);
				const page = yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
						next: Schema.NullOr(Schema.String)
					})
				)(answer);
				const out = page.rows;
				expect(page.next).toBeNull();
				expect(
					(yield* run(
						caller,
						lowerRead(manifest, 'read', ['orders', { search: { hue: {} }, limit: 0 }])
					))[0]
				).toEqual({ rows: [], next: null });
				const north = new Set(ACCOUNTS.filter((a) => a.region === 'north').map((a) => a.id));
				const pool = ORDERS.filter(
					(o) => o.color !== null && o.status !== 'held' && north.has(o.account)
				)
					.map((o) => ({ o, d: Math.hypot(...o.color!) }))
					.sort((a, b) => a.d - b.d || a.o.id.localeCompare(b.o.id))
					.slice(0, 6);
				expect(reranked).toBe(Math.min(6, pool.length));
				const expected = pool
					.sort((a, b) => Math.abs(a.o.color![0]! - 0.5) - Math.abs(b.o.color![0]! - 0.5))
					.slice(0, 2)
					.map((x) => x.o.id);
				expect(out.map((r) => r.id)).toEqual(expected);
				expect(typeof out[0]!.$distance).toBe('number');
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'search: rows matching every word rank first; a model without searchable fields refuses',
		() =>
			Effect.gen(function* () {
				yield* setup();
				const page = (yield* run(
					workspace,
					read(cat, 'accounts', { search: 'acme alp', limit: 10, select: { name: true } })
				))[0] as Page;
				expect(page.rows.map((r) => r.name)).toEqual(
					expect.arrayContaining(['alpha acme', 'acme north', 'delta acme works'])
				);
				expect(page.rows[0]!.name).toBe('alpha acme');
				expect(page.rows).toHaveLength(3);
				expect(
					yield* Effect.flip(run(workspace, read(cat, 'orders', { search: 'x', limit: 1 })))
				).toMatchObject({ code: 'invalid' });
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('aggregate: buckets by month and through a one-relation, exact decimal sums, paged', () =>
		Effect.gen(function* () {
			yield* setup();
			const out = (yield* run(
				workspace,
				yield* aggregate(cat, 'orders', {
					by: ['account.region', { month: 'placed' }],
					count: true,
					sum: ['total'],
					all: true
				}).pipe(Effect.mapError(fromStore))
			))[0] as Page;
			const region = (o: (typeof ORDERS)[number]) =>
				ACCOUNTS.find((a) => a.id === o.account)!.region;
			expect(out.rows.length).toBeGreaterThan(2);
			for (const g of out.rows) {
				const key = g.key as {
					[k: string]: Json;
				};
				const members = ORDERS.filter(
					(o) => region(o) === key['account.region'] && key.placed === '2026-09-01'
				);
				expect(g.count).toBe(members.length);
				const total = (
					g.sum as {
						total: {
							$dec: string;
						};
					}
				).total.$dec;
				expect(Math.round(Number(total) * 100)).toBe(
					members.reduce((s, o) => s + Math.round(Number(o.total) * 100), 0)
				);
			}
			const p1 = (yield* run(
				workspace,
				yield* aggregate(cat, 'orders', { by: ['status'], count: true, limit: 2 }).pipe(
					Effect.mapError(fromStore)
				)
			))[0] as Page;
			const p2 = (yield* run(
				workspace,
				yield* aggregate(cat, 'orders', {
					by: ['status'],
					count: true,
					limit: 2,
					after: p1.next
				}).pipe(Effect.mapError(fromStore))
			))[0] as Page;
			expect(
				[...p1.rows, ...p2.rows].map(
					(r) =>
						(
							r.key as {
								status: string;
							}
						).status
				)
			).toEqual(['closed', 'held', 'open']);
			expect(p2.next).toBeNull();
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'rule 9: `all` past its caps is tooLarge, never clamped (rows, bytes, relation arms)',
		() =>
			Effect.gen(function* () {
				yield* setup();
				const small = readEngine({ db, manifest, allBytes: 1000 });
				expect(
					yield* Effect.flip(small.run([read(cat, 'orders', { all: true })], workspace, bindings))
				).toMatchObject({ code: 'tooLarge' });
				yield* exec(
					`insert into lines (id, "order", sku, amount) select gen_random_uuid(), '${ORDERS[0]!.id}', 'bulk', 1 from generate_series(1, 10001)`
				);
				expect(
					yield* Effect.flip(
						run(workspace, get(cat, 'orders', ORDERS[0]!.id, { select: { lines: { all: true } } }))
					)
				).toMatchObject({ code: 'tooLarge' });
				const limited = (yield* run(
					workspace,
					get(cat, 'orders', ORDERS[0]!.id, { select: { lines: { limit: 5 } } })
				))[0] as {
					lines: RowData[];
				};
				expect(limited.lines).toHaveLength(5);
				yield* exec(
					`insert into notes (id, about__accounts, body) select gen_random_uuid(), '${ACCOUNTS[0]!.id}', 'x' from generate_series(1, 50001)`
				);
				expect(
					yield* Effect.flip(
						run(workspace, read(cat, 'notes', { all: true, select: { body: true } }))
					)
				).toMatchObject({ code: 'tooLarge' });
			}).pipe(Effect.provide(Pristine.layer)),
		60000
	);
	it.live(
		'rule 9: a page ends at one crossing of row bytes, its cursor after the last row that fits; a row past it is tooLarge',
		() =>
			Effect.gen(function* () {
				yield* setup();
				const mib = 1024 * 1024;
				yield* exec(
					`insert into notes (id, about__accounts, body) select gen_random_uuid(), '${ACCOUNTS[0]!.id}', repeat('x', ${mib}) from generate_series(1, 6)`
				);
				const seen: string[] = [];
				let after: string | undefined;
				let pages = 0;
				do {
					const page = (yield* run(
						workspace,
						read(cat, 'notes', {
							limit: 50,
							...(after === undefined ? {} : { after }),
							select: { body: true }
						})
					))[0] as Page;
					// the database stopped the page: no more than one crossing ever reached the engine
					expect(JSON.stringify(page.rows).length).toBeLessThanOrEqual(LIMITS.crossingBytes);
					seen.push(...page.rows.map((r) => r.id as string));
					after = page.next ?? undefined;
					pages++;
				} while (after !== undefined);
				expect(pages).toBe(2);
				expect(new Set(seen).size).toBe(NOTES.length + 6);
				yield* exec(`update notes set body = repeat('x', ${5 * mib}) where id = '${NOTES[0]!.id}'`);
				expect(
					yield* Effect.flip(
						run(
							workspace,
							read(cat, 'notes', {
								where: { id: { eq: NOTES[0]!.id } },
								limit: 1,
								select: { body: true }
							})
						)
					)
				).toMatchObject({
					code: 'tooLarge',
					message: `a row of notes is larger than ${LIMITS.crossingBytes} bytes; select fewer fields (rule 9)`
				});
			}).pipe(Effect.provide(Pristine.layer)),
		60000
	);
});
