// The read engine (A4, rule 12): one batch = one pipelined round trip. Identical reads run once; a similarity read's
// probe runs before the round trip and its re-rank after. Nothing is clamped (rule 9): `all` past its cap is `tooLarge`.
import type { Bindings, EngineManifest, Pred, ReadEngine, ReadIR, Reader, RowData, SelectIR, Sql, TenantDb } from '../contracts.ts';
import { BoltError, LIMITS } from '../contracts.ts';
import type { Json } from '../../decl/values.ts';
import type { Catalog } from '../../protocol/catalog.ts';
import { collectionOf, defaultFields, SEMANTIC, storedFields } from '../../protocol/catalog.ts';
import { catalogOf } from '../access/pred.ts';
import { where } from '../../protocol/ir.ts';
import type { Compiled } from './sql.ts';
import { compile as compileSource, compileGets as compileSourceGets, encodeCursor, type QuerySourceOptions } from './sql.ts';

/** A declared similarity's attached bodies, run in the guest: `probe` picks the vector, `rerank` re-measures a page. */
export type SimilarityBodies = {
	probe(input: Json): Promise<{ field: string; vector: readonly number[]; where?: Json }>;
	rerank?: (input: Json, rows: readonly RowData[]) => Promise<readonly (number | undefined)[]>;
};
export type ReadEngineConfig = {
	/** Native write planning only: qualified prospective model sources. Never supplied by a guest. */
	querySources?: QuerySourceOptions;
	/** Trusted native projection after row/column authorization, before caller delivery. */
	projection?: (read: ReadIR, answer: Json, reader: Reader, bindings: Bindings) => Promise<Json>;
	db: TenantDb; manifest: EngineManifest;
	similarity?: (collection: string, name: string) => SimilarityBodies | undefined;
	/** Reads another area answers: `history` (§5.2), `query` (a guest invocation), `after` (the write compiler), `transcript` (the agent). */
	delegate?: Partial<Record<'history' | 'query' | 'after' | 'transcript' | 'inbox' | 'conversations', (read: ReadIR, reader: Reader, bindings: Bindings) => Promise<Json>>>;
	/** The byte cap of an `all` read: 8 MiB on `/q` (the default), 4 MiB per guest crossing. */
	allBytes?: number;
	/** `search.semantic`'s probe (L-BOLT-123): one text embedded on the collection's model class; absent → `/semantic` and `similar({ to: text })` are `unavailable`. */
	embed?: (collection: string, text: string) => Promise<readonly number[]>;
};

const tooLarge = (message: string) => new BoltError('tooLarge', 'deliver', message);
type Plan = { compiled?: Compiled; similar?: { bodies: SimilarityBodies; input: Json; limit: number; keep?: ReadonlySet<string> }; answer?: Promise<Json> };

export function readEngine(config: ReadEngineConfig): ReadEngine & { catalog: Catalog } {
	const compile:typeof compileSource=(cat,ir,reader,bindings,probe)=>compileSource(cat,ir,reader,bindings,probe,config.querySources);
	const compileGets:typeof compileSourceGets=(cat,collection,ids,select,reader,bindings)=>compileSourceGets(cat,collection,ids,select,reader,bindings,config.querySources);
	const cat = catalogOf(config.manifest);
	const allBytes = config.allBytes ?? LIMITS.page.allBytes;
	const requiresProjection = Object.values(config.manifest.collections).some(spec => (spec.read as { projection?: unknown }).projection !== undefined);

	async function plan(ir: ReadIR, reader: Reader, bindings: Bindings): Promise<Plan> {
		if (ir.kind === 'history' || ir.kind === 'query' || ir.kind === 'after' || ir.kind === 'transcript' || ir.kind === 'inbox' || ir.kind === 'conversations') {
			const d = config.delegate?.[ir.kind];
			if (d === undefined) throw new BoltError('unsupported', 'decode', `this host answers no '${ir.kind}' read`);
			return { answer: d(ir, reader, bindings) };
		}
		if ((ir.kind === 'read' && 'limit' in ir.page && ir.page.limit === 0) || (ir.kind === 'similar' && ir.limit === 0)) return { answer: Promise.resolve(ir.kind === 'read' ? { rows: [], next: null } : []) };
		// L-BOLT-123: `/semantic <text>` and `similar(c, { to })` over `search.semantic`
		const embed = async (text: string) => {
			if (collectionOf(cat, ir.collection).model.semantic === undefined) throw new BoltError('invalid', 'decode', `'${ir.collection}' declares no search.semantic (rule 16)`);
			if (config.embed === undefined) throw new BoltError('unavailable', 'facility', 'this host embeds no text: semantic search is unavailable');
			return config.embed(ir.collection, text);
		};
		if (ir.kind === 'read' && ir.search !== undefined && /^\/semantic(\s|$)/.test(ir.search)) {
			const text = ir.search.replace(/^\/semantic\s*/, '');
			if (text === '') throw new BoltError('invalid', 'decode', '/semantic needs something to search for');
			return { compiled: compile(cat, ir, reader, bindings, { field: SEMANTIC, vector: await embed(text), take: 0 }) };
		}
		if (ir.kind === 'similar' && ir.similarity === SEMANTIC) {
			const to = ir.input as string | { record: { id: string } };
			return { compiled: compile(cat, ir, reader, bindings, typeof to === 'string' ? { field: SEMANTIC, vector: await embed(to), take: ir.limit }
				: { field: SEMANTIC, vector: [], from: to.record.id, take: ir.limit }) };
		}
		if (ir.kind !== 'similar') return { compiled: compile(cat, ir, reader, bindings) };
		const bodies = config.similarity?.(ir.collection, ir.similarity);
		if (bodies === undefined) throw new BoltError('invalid', 'decode', `'${ir.collection}' has no similarity '${ir.similarity}'`);
		const probe = await bodies.probe(ir.input);
		const candidates = bodies.rerank === undefined ? 1 : collectionOf(cat, ir.collection).similarity[ir.similarity]?.candidates ?? 4;
		const take = ir.limit * candidates;
		if (take > LIMITS.page.max) throw tooLarge(`similar asks the index for ${take} rows (limit × candidates ≤ ${LIMITS.page.max})`);
		const w: Pred | undefined = probe.where === undefined ? undefined : where(cat, ir.collection, probe.where);
		if (reader.as === 'caller' && w !== undefined) guardProjectedOperands(config.manifest, { kind: 'read', collection: ir.collection, where: w, select: ir.select ?? { fields: null, relations: {} }, page: { limit: ir.limit } });
		// a rerank measures the whole row: a narrowed select is widened for it and narrowed back after (hook:reads)
		const want = bodies.rerank === undefined ? null : ir.select?.fields ?? null;
		const c = collectionOf(cat, ir.collection);
		const wide = want === null ? ir : { ...ir, select: { ...ir.select!, fields: [...new Set([...want, ...(reader.as === 'caller' ? defaultFields(c) : storedFields(c.model))])] } };
		return { compiled: compile(cat, wide, reader, bindings, { field: probe.field, vector: probe.vector, ...(w === undefined ? {} : { where: w }), take }),
			similar: { bodies, input: ir.input, limit: ir.limit, ...(want === null ? {} : { keep: new Set(['id', '$distance', ...want, ...Object.keys(ir.select!.relations)]) }) } };
	}

	async function finish(p: Plan, ir: ReadIR, rows: readonly { readonly [c: string]: Json }[]): Promise<Json> {
		const c = p.compiled!;
		const js = rows.map((r) => r.j as { [k: string]: Json });
		armsFit(ir, js);
		if (c.kind === 'one' || c.kind === 'agg') return js[0] ?? null;
		if (ir.kind === 'similar' && p.similar === undefined) return js; // search.semantic: nearest first, already limited
		if (p.similar !== undefined) {
			const { bodies, input, limit, keep } = p.similar;
			if (bodies.rerank === undefined) return js.slice(0, limit);
			const scores = await bodies.rerank(input, js);
			// scored rows ascending; an `undefined` score keeps index order behind them (stable sort)
			const order = js.map((row, i) => ({ row, s: scores[i] ?? Infinity })).sort((x, y) => x.s - y.s);
			return order.slice(0, limit).map((x) => keep === undefined ? x.row : Object.fromEntries(Object.entries(x.row).filter(([k]) => keep.has(k))));
		}
		if (c.limit === 'all') {
			const of = 'collection' in ir ? ` of ${String(ir.collection)}` : '';
			if (js.length > LIMITS.page.all) throw tooLarge(`the read${of} matches more than ${LIMITS.page.all} rows; page it (rule 9)`);
			if (JSON.stringify(js).length > allBytes) throw tooLarge(`the read${of} is larger than ${allBytes} bytes; page it (rule 9)`);
			return { rows: js, next: null };
		}
		const more = js.length > c.limit!;
		const page = js.slice(0, c.limit!);
		const last = page.at(-1);
		const next = more && last !== undefined ? encodeCursor(c.hash, last.$k as (string | null)[]) : null;
		return { rows: page.map(({ $k: _, ...row }) => row), next };
	}

	return {
		catalog: cat,
		async run(batch, reader, bindings) {
			if (reader.as === 'caller' && requiresProjection && config.projection === undefined) throw new BoltError('unavailable','deliver','This native reader must enforce its declared JSON projections.');
			const keys = batch.map((ir) => JSON.stringify(ir));
			const unique = [...new Set(keys)];
			const irs = unique.map((k) => batch[keys.indexOf(k)]!);
			if (reader.as === 'caller') for (const ir of irs) guardProjectedOperands(config.manifest, ir);
			// rule 12: `get`s of one shape merge into one lateral statement
			const merged = new Map<number, { s: number; n: number }>();
			const mergedSql: Sql[] = [];
			const gets = irs.flatMap((ir, i) => ir.kind === 'get' ? [[ir, i] as const] : []);
			for (const g of Map.groupBy(gets, ([ir]) => JSON.stringify([ir.collection, ir.select])).values()) {
				if (g.length < 2) continue;
				mergedSql.push(compileGets(cat, g[0]![0].collection, g.map(([ir]) => ir.id), g[0]![0].select, reader, bindings));
				g.forEach(([, i], n) => merged.set(i, { s: mergedSql.length - 1, n }));
			}
			// probes first (they may cross into the guest), then one round trip for every statement
			const plans = await Promise.all(irs.map((ir, k): Plan | Promise<Plan> => merged.has(k) ? {} : plan(ir, reader, bindings)));
			const statements: Sql[] = plans.flatMap((p) => p.compiled === undefined ? [] : [p.compiled.sql]);
			const base = statements.length;
			statements.push(...mergedSql);
			const results = statements.length === 0 ? [] : await config.db.read(statements);
			let i = 0;
			const answers = await Promise.all(plans.map((p, k) => {
				const at = merged.get(k);
				if (at === undefined) return p.answer ?? finish(p, irs[k]!, results[i++]!.rows);
				const j = (results[base + at.s]!.rows[at.n]?.['j'] ?? null) as { [k: string]: Json } | null;
				armsFit(irs[k]!, j === null ? [] : [j]);
				return j;
			}));
			const delivered = reader.as !== 'caller' || config.projection === undefined ? answers
				: await Promise.all(answers.map((answer, index) => config.projection!(irs[index]!, answer, reader, bindings)));
			return keys.map((k) => delivered[unique.indexOf(k)]!);
		},
	};
}

/** A many-relation arm asked for `all` holds at most `LIMITS.page.relationArm` rows (rule 9), at any depth. */
function armsFit(ir: ReadIR, rows: readonly { [k: string]: Json }[]): void {
	if (ir.kind !== 'read' && ir.kind !== 'get') return;
	const walk = (sel: SelectIR, rs: readonly { [k: string]: Json }[]) => {
		for (const [rel, r] of Object.entries(sel.relations)) for (const row of rs) {
			const v = row[rel];
			const list = (r.many ? v : v === null || v === undefined ? [] : [v]) as { [k: string]: Json }[];
			if (r.many && r.page !== undefined && 'all' in r.page && list.length > LIMITS.page.relationArm)
				throw tooLarge(`relation '${rel}' holds more than ${LIMITS.page.relationArm} rows; state a limit (rule 9)`);
			walk(r.select, list);
		}
	};
	walk(ir.select, rows);
}

/** Raw predicates and aggregates must not infer data withheld by a JSON projection. */
function guardProjectedOperands(manifest: EngineManifest, read: ReadIR): void {
 const protectedFields = (collection: string): readonly string[] => (manifest.collections[collection]?.read as { projection?: { fields: readonly string[] } } | undefined)?.projection?.fields ?? [];
 const check = (collection: string, field: string) => {
  if (protectedFields(collection).includes(field)) throw new BoltError('forbidden','decode','Projected JSON columns cannot be used as raw read operands.');
 };
 const predicate = (collection: string, value: import('../contracts.ts').Pred): void => {
  if (value.t === 'and' || value.t === 'or') { for(const child of value.of)predicate(collection,child); }
  else if(value.t==='not')predicate(collection,value.of);
  else if(value.t==='one'||value.t==='many')predicate(value.target,value.pred);
  else if('field' in value)check(collection,value.field);
  else if(value.t==='agg')check(value.target,value.of);
 };
 if('where' in read && read.where!==undefined)predicate(read.collection,read.where);
 if('order' in read && read.order!==undefined)for(const order of read.order)check(read.collection,order.field);
 if(read.kind==='aggregate')for(const field of [...read.by.map(bucket=>bucket.field),...(read.sum??[]),...(read.avg??[]),...(read.min??[]),...(read.max??[])])check(read.collection,field);
 const select = (selected: import('../contracts.ts').SelectIR): void => {
  for(const relation of Object.values(selected.relations)) {
   if(relation.where!==undefined)predicate(relation.target,relation.where);
   for(const order of relation.order??[])check(relation.target,order.field);
   select(relation.select);
  }
 };
 if('select' in read && read.select!==undefined)select(read.select);
}
