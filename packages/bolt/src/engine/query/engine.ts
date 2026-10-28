// The read engine (A4, rule 12): one batch = one pipelined round trip. Identical reads run once; an index search's
// probe runs before the round trip and its re-rank after. Nothing is clamped (rule 9): `all` past its cap is `tooLarge`.
import {
	Cache,
	Context,
	Crypto,
	Effect,
	Latch,
	Request,
	RequestResolver,
	Result,
	Layer,
	Schema
} from 'effect';
import type { Authority, Bindings, CrossAnswer, Reader, RowData, Rows, Sql } from '../contracts.ts';
import type { Order, Pred, SelectIR } from '@norbital-ai/store';
import { decodeRead, type ReadIR } from '../../protocol/reads.ts';
import type { EngineManifest } from '../manifest.ts';
import type { Entry, ReadsShape as ReadEngine } from '../services.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { syncState } from '../sync/index.ts';
import { approvable, heldModels, rowApproval } from '../approvals/lock.ts';
import { LIMITS } from '../contracts.ts';
import { DbError, type EngineError } from '../errors.ts';
import { BoltError, fromStore } from '../../protocol/errors.ts';
import { Reads, Manifest, Guest } from '../services.ts';
import { SqlReadCapture, TenantDb as TenantDbService } from '../db/tenant-db.ts';
import { Ai } from '../ports.ts';

import { decodeInput, type Decoded } from '../callables/decode.ts';
import { encodeWire } from '@norbital-ai/std/wire';
import { agentRead } from '../agent/reads.ts';
import { readHistory } from './history.ts';
import type { Json } from '../../decl/values.ts';
import {
	exposureOf,
	compile as compileSource,
	compileGets as compileSourceGets,
	defaultFields,
	encodeCursor,
	OVER,
	q,
	SEMANTIC,
	storedFields,
	where,
	type Catalog,
	type Compiled,
	type Probe
} from '@norbital-ai/store';
import { catalogOf } from '../access/pred.ts';
import { composable, isComposable, readOptions } from './reader.ts';
const jsonArray = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);
/** A `search.indexes` entry's bodies, run in the guest: `probe` picks the vector, `rerank` re-measures a page. */
export type IndexBodies = {
	probe(
		input: Json,
		custom: NonNullable<Decoded['custom']>
	): Effect.Effect<{ vector: readonly number[]; where?: Json }, EngineError>;
	rerank?: (
		input: Json,
		rows: readonly RowData[]
	) => Effect.Effect<readonly (number | undefined)[], EngineError>;
};
type ReadEngineConfig = {
	/** Native write planning only: qualified prospective model sources. Never supplied by a guest. */
	querySources?: { readonly sources?: ReadonlyMap<string, string> };
	db: TenantDb;
	manifest: EngineManifest;
	/** Models open approval requests held when the engine started (`$approval` beyond today's grants). */
	held?: ReadonlySet<string>;
	index?: (model: string, name: string, bindings: Bindings) => IndexBodies | undefined;
	/** Reads another area answers: `history` (§5.2), `after` (the write compiler), `transcript` (the agent). */
	delegate?: Partial<
		Record<
			'history' | 'after' | 'transcript' | 'inbox' | 'conversations',
			(
				read: ReadIR,
				reader: Reader,
				bindings: Bindings,
				from: Entry
			) => Effect.Effect<Json, EngineError>
		>
	>;
	/** The byte cap of an `all` read: 8 MiB on `/q` (the default), 4 MiB per guest crossing. */
	allBytes?: number;
	/** `search.semantic`'s probe (L-BOLT-123): one text embedded on the model's model class; absent → `/semantic` and `similar({ to: text })` are `unavailable`. */
	embed?: (model: string, text: string) => Effect.Effect<readonly number[], EngineError>;
};
const checkedRead = <A>(read: () => A) =>
	Effect.try({
		try: read,
		catch: (error) =>
			error instanceof BoltError
				? error
				: BoltError.make(
						'badAnswer',
						'decode',
						error instanceof Error ? error.message : String(error),
						error
					)
	});
const tooLarge = (message: string) => BoltError.make('tooLarge', 'deliver', message);
/** H8: while provided, every read this engine runs adds the models it touched, so a view re-runs on exactly those. */
export const ReadDeps = Context.Reference<Set<string> | undefined>('bolt/ReadDeps', {
	defaultValue: () => undefined
});
/** Models a related sort key reads (`account.name` → accounts): the row image cannot place rows by their values. */
export function sortTargets(
	cat: Catalog,
	model: string,
	order: Order | undefined,
	out = new Set<string>()
): Set<string> {
	for (const { field } of order ?? []) {
		let m = model;
		for (const s of field.split('.').slice(0, -1))
			out.add((m = cat.models.get(m)?.one.get(s)?.targets[0] ?? m));
	}
	return out;
}
/** Models a selection's relation arms read, with their own order keys. */
export const selectTargets = (cat: Catalog, s: SelectIR, out = new Set<string>()): Set<string> => {
	for (const r of Object.values(s.relations))
		for (const target of r.targets ?? [r.target])
			selectTargets(
				cat,
				r.targetSelects?.[target] ?? r.select,
				sortTargets(cat, target, r.order, out.add(target))
			);
	return out;
};
/**
 * The models one read touches: its own, each one its `where`, selection (every layer) and order cross, and those the
 * caller's read arms and masks on each of them cross. A read request touches what each of its roots' reads does.
 */
export function readTargets(cat: Catalog, ir: ReadIR, authority?: Authority): ReadonlySet<string> {
	if (ir.kind === 'request')
		return new Set(
			ir.roots.flatMap((r) =>
				('read' in r ? [r.read] : r.asOf).flatMap((x: ReadIR) => [
					...readTargets(cat, x, authority)
				])
			)
		);
	const out = new Set<string>();
	const pred = (p: Pred | undefined): void => {
		if (p === undefined) return;
		if (p.t === 'and' || p.t === 'or') p.of.forEach(pred);
		else if (p.t === 'not') pred(p.of);
		else if (p.t === 'one' || p.t === 'many') {
			add(p.target);
			pred(p.pred);
		} else if (p.t === 'count' || p.t === 'agg') add(p.target);
	};
	const select = (s: SelectIR): void => {
		for (const r of Object.values(s.relations))
			for (const target of r.targets ?? [r.target]) {
				add(target);
				pred(r.where);
				for (const t of sortTargets(cat, target, r.order)) add(t);
				select(r.targetSelects?.[target] ?? r.select);
			}
	};
	function add(model: string): void {
		if (out.has(model)) return;
		out.add(model);
		const grant = authority === undefined || authority.admin ? undefined : authority.models[model];
		for (const arm of Object.values(grant?.read ?? {}).flat()) pred(arm.where);
		for (const mask of Object.values(grant?.masks ?? {}).flatMap(Object.values)) pred(mask);
	}
	add(ir.model);
	if ('where' in ir) pred(ir.where);
	if ('select' in ir && ir.select !== undefined) select(ir.select);
	if (ir.kind === 'read') for (const t of sortTargets(cat, ir.model, ir.order)) add(t);
	return out;
}
type Plan = {
	compiled?: Compiled;
	similar?: {
		bodies: IndexBodies;
		input: Json;
		limit: number;
		keep?: ReadonlySet<string>;
	};
	answer?: Effect.Effect<Json, EngineError>;
};
export function readEngine(config: ReadEngineConfig): ReadEngine & {
	catalog: Catalog;
} {
	const options = (reader: Reader, bindings: Bindings) =>
		readOptions(reader, bindings, { sources: config.querySources?.sources, approvals, allBytes });
	const compile = (cat: Catalog, ir: ReadIR, reader: Reader, bindings: Bindings, probe?: Probe) =>
		ir.kind === 'read' || ir.kind === 'get' || ir.kind === 'aggregate' || ir.kind === 'similar'
			? compileSource(cat, ir, options(reader, bindings), probe).pipe(Effect.mapError(fromStore))
			: Effect.fail(BoltError.make('invalid', 'decode', `'${ir.kind}' is not a statement read`));
	const compileGets = (
		cat: Catalog,
		model: string,
		ids: readonly string[],
		select: SelectIR,
		reader: Reader,
		bindings: Bindings
	) =>
		compileSourceGets(cat, model, ids, select, options(reader, bindings)).pipe(
			Effect.mapError(fromStore)
		);
	const cat = catalogOf(config.manifest);
	// a request opens only on a model today's grants route, or one an earlier release's request still holds
	const approvals = new Set([...approvable(config.manifest, cat), ...(config.held ?? [])]);
	const allBytes = config.allBytes ?? LIMITS.page.allBytes;
	const plan = Effect.fn('Bolt.plan')(function* (
		ir: ReadIR,
		reader: Reader,
		bindings: Bindings,
		from: Entry
	) {
		if (ir.kind === 'request')
			return yield* Effect.fail(
				BoltError.make('internal', 'decode', 'a read request is answered by its roots')
			);
		if (
			ir.kind === 'history' ||
			ir.kind === 'after' ||
			ir.kind === 'transcript' ||
			ir.kind === 'inbox' ||
			ir.kind === 'conversations'
		) {
			const d = config.delegate?.[ir.kind];
			if (d === undefined)
				return yield* Effect.fail(
					BoltError.make('unsupported', 'decode', `this host answers no '${ir.kind}' read`)
				);
			return { answer: d(ir, reader, bindings, from) };
		}
		if (
			(ir.kind === 'read' && ir.page._tag === 'Limit' && ir.page.limit === 0) ||
			(ir.kind === 'similar' && ir.limit === 0)
		)
			return { answer: Effect.succeed({ rows: [], next: null }) };
		// `$similar` in a predicate: every distinct (model, text) embedded once, together, before the statement
		if (
			(ir.kind === 'read' || ir.kind === 'aggregate' || ir.kind === 'similar') &&
			ir.where !== undefined &&
			JSON.stringify(ir.where).includes('"t":"similar"')
		) {
			if (config.embed === undefined)
				return yield* Effect.fail(
					BoltError.make(
						'unavailable',
						'facility',
						'this host embeds no text: $similar is unavailable'
					)
				);
			const probes = new Map<string, Effect.Effect<readonly number[], EngineError>>();
			const walk = (p: Pred, c: string): void => {
				if (p.t === 'and' || p.t === 'or') p.of.forEach((x) => walk(x, c));
				else if (p.t === 'not') walk(p.of, c);
				else if (p.t === 'one' || p.t === 'many') walk(p.pred, p.target);
				else if (p.t === 'similar' && !probes.has(`${c}\n${p.to}`))
					probes.set(`${c}\n${p.to}`, config.embed!(c, p.to));
			};
			walk(ir.where, ir.model);
			const vectors = new Map(
				yield* Effect.all(
					[...probes].map(
						Effect.fnUntraced(function* ([k, v]: [
							string,
							Effect.Effect<readonly number[], EngineError>
						]) {
							return [k, yield* v] as const;
						})
					),
					{ concurrency: 'unbounded' }
				)
			);
			const put = (p: Pred, c: string): Pred =>
				p.t === 'and' || p.t === 'or'
					? { ...p, of: p.of.map((x) => put(x, c)) }
					: p.t === 'not'
						? { ...p, of: put(p.of, c) }
						: p.t === 'one' || p.t === 'many'
							? { ...p, pred: put(p.pred, p.target) }
							: p.t === 'similar'
								? { ...p, vector: vectors.get(`${c}\n${p.to}`)! }
								: p;
			ir = { ...ir, where: put(ir.where, ir.model) };
		}
		// L-BOLT-123: `/semantic <text>` and `similar(c, { to })` over `search.semantic`
		const embed = Effect.fnUntraced(function* (text: string) {
			if (
				(yield* exposureOf(cat, ir.model).pipe(Effect.mapError(fromStore))).model.semantic ===
				undefined
			)
				return yield* Effect.fail(
					BoltError.make('invalid', 'decode', `'${ir.model}' declares no search.semantic (rule 16)`)
				);
			if (config.embed === undefined)
				return yield* Effect.fail(
					BoltError.make(
						'unavailable',
						'facility',
						'this host embeds no text: semantic search is unavailable'
					)
				);
			return yield* config.embed(ir.model, text);
		});
		if (ir.kind === 'read' && ir.search !== undefined && /^\/semantic(\s|$)/.test(ir.search)) {
			const text = ir.search.replace(/^\/semantic\s*/, '');
			if (text === '')
				return yield* Effect.fail(
					BoltError.make('invalid', 'decode', '/semantic needs something to search for')
				);
			return {
				compiled: yield* compile(cat, ir, reader, bindings, {
					field: SEMANTIC,
					vector: yield* embed(text),
					take: 0
				})
			};
		}
		if (ir.kind === 'similar' && ir.index === SEMANTIC) {
			const to = ir.input as
				| string
				| {
						record: {
							id: string;
						};
				  };
			return {
				compiled: yield* compile(
					cat,
					ir,
					reader,
					bindings,
					typeof to === 'string'
						? { field: SEMANTIC, vector: yield* embed(to), take: ir.limit }
						: { field: SEMANTIC, vector: [], from: to.record.id, take: ir.limit }
				)
			};
		}
		if (ir.kind !== 'similar') return { compiled: yield* compile(cat, ir, reader, bindings) };
		const bodies = config.index?.(ir.model, ir.index, bindings);
		const spec = config.manifest.models[ir.model]?.search?.indexes?.[ir.index];
		if (bodies === undefined || spec === undefined)
			return yield* Effect.fail(
				BoltError.make('invalid', 'decode', `'${ir.model}' has no search index '${ir.index}'`)
			);
		const decoded = decodeInput(spec.input, ir.input, config.manifest.customFields ?? {});
		if (decoded.problems.length > 0)
			return yield* BoltError.make(
				'invalidInput',
				'decode',
				decoded.problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ')
			);
		const input = encodeWire(decoded.value);
		const probe = yield* bodies.probe(input, decoded.custom ?? []);
		const candidates =
			bodies.rerank === undefined
				? 1
				: ((yield* exposureOf(cat, ir.model).pipe(Effect.mapError(fromStore))).model.indexes[
						ir.index
					]?.candidates ?? 4);
		const take = ir.limit * candidates;
		if (take > LIMITS.page.max)
			return yield* Effect.fail(
				tooLarge(
					`the search asks the index for ${take} rows (limit × candidates ≤ ${LIMITS.page.max})`
				)
			);
		const w: Pred | undefined =
			probe.where === undefined
				? undefined
				: yield* where(cat, ir.model, probe.where).pipe(Effect.mapError(fromStore));
		// a rerank measures the whole row: a narrowed select is widened for it and narrowed back after (hook:reads)
		const want = bodies.rerank === undefined ? null : (ir.select?.fields ?? null);
		const c = yield* exposureOf(cat, ir.model).pipe(Effect.mapError(fromStore));
		const wide =
			want === null
				? ir
				: {
						...ir,
						select: {
							...ir.select!,
							fields: [
								...new Set([
									...want,
									...(reader.as === 'caller' ? defaultFields(c) : storedFields(c.model))
								])
							]
						}
					};
		return {
			compiled: yield* compile(cat, wide, reader, bindings, {
				field: ir.index,
				vector: probe.vector,
				...(w === undefined ? {} : { where: w }),
				take
			}),
			similar: {
				bodies,
				input,
				limit: ir.limit,
				...(want === null
					? {}
					: {
							keep: new Set([
								'id',
								'$distance',
								'$approval',
								...want,
								...Object.keys(ir.select!.relations)
							])
						})
			}
		};
	});
	const finish = Effect.fn('Bolt.finish')(function* (
		p: Plan,
		ir: ReadIR,
		rows: readonly {
			readonly [c: string]: Json;
		}[]
	) {
		const c = p.compiled!;
		const answered = rows.map(
			(r) =>
				r.j as {
					[k: string]: Json;
				}
		);
		// the database stopped at the read's byte budget (`budgeted`): the marker is no row
		const over = answered.at(-1)?.[OVER] === true;
		const js = over ? answered.slice(0, -1) : answered;
		const of = 'model' in ir ? ` of ${String(ir.model)}` : '';
		yield* checkedRead(() => armsFit(ir, js));
		if (c.kind === 'one' || c.kind === 'agg') return js[0] ?? null;
		if (ir.kind === 'similar' && over)
			return yield* Effect.fail(tooLarge(`the search${of} is larger than ${allBytes} bytes`));
		if (ir.kind === 'similar' && p.similar === undefined) return { rows: js, next: null }; // search.semantic: nearest first, already limited
		if (p.similar !== undefined) {
			const { bodies, input, limit, keep } = p.similar;
			if (bodies.rerank === undefined) return { rows: js.slice(0, limit), next: null };
			const scores = yield* bodies.rerank(input, js);
			// scored rows ascending; an `undefined` score keeps index order behind them (stable sort)
			const order = js
				.map((row, i) => ({ row, s: scores[i] ?? Infinity }))
				.sort((x, y) => x.s - y.s);
			const ranked = order
				.slice(0, limit)
				.map((x) =>
					keep === undefined
						? x.row
						: Object.fromEntries(Object.entries(x.row).filter(([k]) => keep.has(k)))
				);
			return { rows: ranked, next: null };
		}
		if (c.limit === 'all') {
			if (js.length > LIMITS.page.all)
				return yield* Effect.fail(
					tooLarge(`the read${of} matches more than ${LIMITS.page.all} rows; page it (rule 9)`)
				);
			if (over)
				return yield* Effect.fail(
					tooLarge(`the read${of} is larger than ${allBytes} bytes; page it (rule 9)`)
				);
			return { rows: js, next: null };
		}
		// a page ends early at one crossing's bytes, its cursor after the last row that fits
		if (over && js.length === 0)
			return yield* Effect.fail(
				tooLarge(
					`a row${of} is larger than ${LIMITS.crossingBytes} bytes; select fewer fields (rule 9)`
				)
			);
		const more = over || js.length > c.limit!;
		const page = js.slice(0, c.limit!);
		const last = page.at(-1);
		const next =
			more && last !== undefined ? encodeCursor(c.hash, last.$k as (string | null)[]) : null;
		return { rows: page.map(({ $k: _, ...row }) => row), next };
	});
	const run: ReadEngine['run'] = Effect.fn('Bolt.read')(function* (
		batch: readonly ReadIR[],
		reader: Reader,
		bindings: Bindings,
		from: Entry = 'Client'
	) {
		// a read request is its roots' reads, all in this one round trip, answered keyed by root
		if (batch.some((ir) => ir.kind === 'request')) {
			const parts = (ir: ReadIR): readonly ReadIR[] =>
				ir.kind === 'request'
					? ir.roots.flatMap((r): readonly ReadIR[] => ('read' in r ? [r.read] : r.asOf))
					: [ir];
			const values = yield* run(batch.flatMap(parts), reader, bindings, from);
			let at = 0;
			const next = () => values[at++] ?? null;
			return batch.map((ir): Json => {
				if (ir.kind !== 'request') return next();
				return Object.fromEntries(
					ir.roots.map((r) => {
						if ('read' in r) return [r.root, next()];
						const keep = r.fields === undefined ? undefined : new Set(['id', ...r.fields]);
						const rows = r.asOf.flatMap((): Json[] => {
							const row = next();
							if (row === null || typeof row !== 'object' || jsonArray(row)) return [];
							return [
								keep === undefined
									? row
									: Object.fromEntries(Object.entries(row).filter(([k]) => keep.has(k)))
							];
						});
						return [r.root, { rows, next: null }];
					})
				);
			});
		}
		const deps = yield* ReadDeps;
		if (deps !== undefined)
			for (const ir of batch)
				for (const model of readTargets(
					cat,
					ir,
					reader.as === 'caller' ? reader.authority : undefined
				))
					deps.add(model);
		const keys = batch.map((ir) => JSON.stringify(ir));
		const unique = [...new Set(keys)];
		const irs = unique.map((k) => batch[keys.indexOf(k)]!);
		// rule 12: `get`s of one shape merge into one lateral statement
		const merged = new Map<
			number,
			{
				s: number;
				n: number;
			}
		>();
		const mergedSql: Sql[] = [];
		const gets = irs.flatMap((ir, i) =>
			ir.kind === 'get' && ir.cte === undefined ? [[ir, i] as const] : []
		);
		for (const g of Map.groupBy(gets, ([ir]) => JSON.stringify([ir.model, ir.select])).values()) {
			if (g.length < 2) continue;
			mergedSql.push(
				composable(
					yield* compileGets(
						cat,
						g[0]![0].model,
						g.map(([ir]) => ir.id),
						g[0]![0].select,
						reader,
						bindings
					)
				)
			);
			g.forEach(([, i], n) => merged.set(i, { s: mergedSql.length - 1, n }));
		}
		// probes first (they may cross into the guest), then one round trip for every statement
		const plans = yield* Effect.all(
			irs.map((ir, k): Effect.Effect<Plan, EngineError> =>
				merged.has(k) ? Effect.succeed({}) : plan(ir, reader, bindings, from)
			),
			{ concurrency: 'unbounded' }
		);
		const statements: Sql[] = plans.flatMap((p) =>
			p.compiled === undefined ? [] : [composable(p.compiled.sql)]
		);
		const ctes = plans.flatMap((p, k) =>
			p.compiled === undefined
				? []
				: [
						(
							irs[k] as {
								cte?: string;
							}
						).cte
					]
		);
		const base = statements.length;
		statements.push(...mergedSql);
		const results = statements.length === 0 ? [] : yield* readComposed(config.db, statements, ctes);
		let i = 0;
		const answers = yield* Effect.all(
			plans.map(
				Effect.fnUntraced(function* (p: Plan, k: number) {
					const at = merged.get(k);
					return yield* Effect.gen(function* () {
						if (at === undefined) return yield* p.answer ?? finish(p, irs[k]!, results[i++]!.rows);
						const j = (results[base + at.s]!.rows[at.n]?.['j'] ?? null) as {
							[k: string]: Json;
						} | null;
						yield* checkedRead(() => armsFit(irs[k]!, j === null ? [] : [j]));
						return j;
					}).pipe(
						Effect.catch((e) =>
							Effect.gen(function* () {
								// a keyed read's member names itself in its cap (`ctx.read({ … })`)
								const member = (
									irs[k] as {
										member?: string;
									}
								).member;
								return yield* Effect.fail(
									member === undefined || !(e instanceof BoltError)
										? e
										: BoltError.make(e.code, e.phase, `member '${member}': ${e.message}`, e)
								);
							})
						)
					);
				})
			),
			{ concurrency: 'unbounded' }
		);
		// every reader's root rows carry `$sync` and the open request holding them as `$approval` (rule 46b)
		const exposed = yield* Effect.all(
			answers.map(
				Effect.fnUntraced(function* (answer: Json, index: number) {
					const ir = irs[index]!;
					if ((ir.kind !== 'get' && ir.kind !== 'read' && ir.kind !== 'similar') || answer === null)
						return answer;
					const object = (value: Json): value is RowData =>
						value !== null && typeof value === 'object' && !jsonArray(value);
					const rows =
						ir.kind === 'get'
							? [answer]
							: object(answer) && jsonArray(answer['rows'])
								? answer['rows']
								: [];
					const records = rows.filter(object).filter((row) => typeof row['id'] === 'string');
					const ids = records.map((row) => String(row['id']));
					// a record a write sync sends carries each sync's latest delivery state as `$sync`
					// Delivery status is advisory; its worker must not invalidate a business read.
					const states = yield* syncState(config.manifest, config.db, ir.model, ids).pipe(
						Effect.provideService(SqlReadCapture, undefined)
					);
					// rule 46b: the statement read the open request holding each row as a raw `$approval` (sql.ts `root`)
					const names = approvals.has(ir.model) ? rowApproval : undefined;
					if (states === undefined && names === undefined) return answer;
					const attach = (row: Json): Json => {
						if (!object(row) || typeof row['id'] !== 'string') return row;
						const { $approval: raw, ...rest } = row;
						const approval = raw === undefined || raw === null ? undefined : names?.(raw);
						return {
							...rest,
							...(states === undefined ? {} : { $sync: states.get(row['id']) ?? {} }),
							...(approval === undefined ? {} : { $approval: approval })
						};
					};
					return ir.kind === 'get'
						? attach(answer)
						: object(answer)
							? { ...answer, rows: rows.map(attach) }
							: answer;
				})
			),
			{ concurrency: 'unbounded' }
		);
		return keys.map((k) => exposed[unique.indexOf(k)]!);
	});
	return { catalog: cat, run };
}
/**
 * Rule 12: a batch's composable statements as one statement. Each one's rows fold into one jsonb array (each row as
 * its `to_jsonb`, in the statement's own order) beside its ordinal, so N reads cost one statement and one snapshot;
 * any other statement rides the same round trip as itself. Placeholders are renumbered into one parameter list
 * (compiled reads bind only `$n` placeholders; their literals hold no `$<digit>`); past the bind cap the batch
 * continues in a further statement of the same round trip. A keyed read's members (`ctes`) are named CTEs, so a later
 * member's `MemberRef` reads an earlier one inside the statement.
 */
export const readComposed = Effect.fn('Bolt.readComposed')(function* (
	db: TenantDb,
	statements: readonly Sql[],
	ctes: readonly (string | undefined)[] = []
) {
	const named = ctes.some((name) => name !== undefined);
	const folded = statements.flatMap((s, i) =>
		isComposable(s) || ctes[i] !== undefined ? [i] : []
	);
	if (folded.length < 2 && !named) return yield* db.read(statements);
	const composed: Sql[] = [];
	let withs: string[] = [],
		parts: string[] = [],
		params: Json[] = [];
	const flush = () => {
		if (parts.length > 0)
			composed.push(
				composable({
					text: `${withs.length === 0 ? '' : `WITH ${withs.join(',\n')}\n`}${parts.join('\nUNION ALL\n')}`,
					params
				})
			);
		withs = [];
		parts = [];
		params = [];
	};
	for (const m of folded) {
		const s = statements[m]!;
		// one statement while any member is named: a reference never straddles two
		if (!named && parts.length > 0 && params.length + s.params.length > LIMITS.statement.params)
			flush();
		const offset = params.length;
		const text =
			offset === 0
				? s.text
				: s.text.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + offset}`);
		const name = ctes[m];
		if (name !== undefined) withs.push(`${q(name)} AS (${text})`);
		parts.push(
			`SELECT ${m} AS m, (SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) FROM ${name === undefined ? `(${text})` : q(name)} s) AS j`
		);
		params.push(...s.params);
	}
	flush();
	const others = statements.flatMap((s, i) => (folded.includes(i) ? [] : [[i, s] as const]));
	const res = yield* db.read([...composed, ...others.map(([, s]) => s)]);
	const out: Rows[] = [];
	for (const result of res.slice(0, composed.length))
		for (const row of result.rows) {
			const decoded = yield* Schema.decodeUnknownEffect(
				Schema.Struct({
					m: Schema.Number,
					j: Schema.Array(Schema.Record(Schema.String, Schema.Json))
				})
			)(row).pipe(
				Effect.mapError((error) =>
					DbError.make('22P02', `The composed read answer is invalid: ${error.message}`)
				)
			);
			out[decoded.m] = { rows: decoded.j, affected: decoded.j.length };
		}
	others.forEach(([i], n) => {
		out[i] = res[composed.length + n]!;
	});
	return out;
});
/** This allocation belongs to one act; cache failures as well as successful first answers. */
export const memoReads = Effect.fn('Bolt.memoReads')(function* (db: TenantDb) {
	const statements = new Map<string, Sql>();
	const cache = yield* Cache.make({
		capacity: Infinity,
		lookup: (key: string) => {
			const statement = statements.get(key);
			return statement === undefined
				? Effect.die('memoReads: missing registered statement')
				: db.read([statement]).pipe(Effect.map((rows) => rows[0] ?? { rows: [], affected: 0 }));
		}
	});
	// only the read path is memoized: every other member stays the caller's own (same function identity)
	return {
		...db,
		read: (batch: readonly Sql[]) =>
			Effect.forEach(
				batch,
				(statement) => {
					const key = JSON.stringify([statement.text, statement.params]);
					if (!statements.has(key)) statements.set(key, statement);
					return Cache.get(cache, key);
				},
				{ concurrency: 'unbounded' }
			)
	};
});
class CoalescedRead extends Request.Class<
	{
		statements: readonly Sql[];
	},
	readonly Rows[],
	DbError
> {}
/** Same-macrotask reads cross once; participants synchronize concurrent act steps. */
export const coalescing = Effect.fn('Bolt.coalescing')(function* (
	db: TenantDb,
	participants?: number
) {
	const ready = yield* Latch.make();
	let active = participants ?? 0;
	let waiting: ReadonlySet<Request.Entry<CoalescedRead>> | undefined;
	const resolver = RequestResolver.makeWith<CoalescedRead>({
		batchKey: () => undefined,
		delay:
			participants === undefined
				? Effect.callback<void>((resume) => {
						const scheduled = setTimeout(() => resume(Effect.void), 0);
						return Effect.sync(() => clearTimeout(scheduled));
					})
				: ready.await,
		collectWhile: (entries) => {
			waiting = entries;
			return participants === undefined || entries.size < active;
		},
		runAll: Effect.fn('Bolt.coalescedRead')(function* (
			entries: readonly [Request.Entry<CoalescedRead>, ...Request.Entry<CoalescedRead>[]]
		) {
			waiting = undefined;
			yield* ready.close;
			const rows = yield* readComposed(
				db,
				entries.flatMap((entry) => entry.request.statements)
			);
			let at = 0;
			for (const entry of entries)
				yield* Request.succeed(entry, rows.slice(at, (at += entry.request.statements.length)));
		})
	});
	const memoized = {
		...db,
		read: (statements: readonly Sql[]) =>
			statements.length === 0
				? Effect.succeed([])
				: Effect.request(new CoalescedRead({ statements }), resolver)
	};
	return {
		...memoized,
		done: Effect.gen(function* () {
			active--;
			if (waiting !== undefined && waiting.size >= active) yield* ready.open;
		})
	};
});
/** A many-relation arm asked for `all` holds at most `LIMITS.page.relationArm` rows (rule 9), at any depth. */
function armsFit(
	ir: ReadIR,
	rows: readonly {
		[k: string]: Json;
	}[]
): void {
	if (ir.kind !== 'read' && ir.kind !== 'get') return;
	const walk = (
		sel: SelectIR,
		rs: readonly {
			[k: string]: Json;
		}[]
	) => {
		for (const [rel, r] of Object.entries(sel.relations))
			for (const row of rs) {
				const v = row[rel];
				const isRow = (value: Json): value is { [k: string]: Json } =>
					value !== null && typeof value === 'object' && !jsonArray(value);
				const list = (
					r.many ? (jsonArray(v) ? v : []) : v === null || v === undefined ? [] : [v]
				).filter(isRow);
				if (
					r.many &&
					r.page !== undefined &&
					r.page._tag === 'All' &&
					list.length > LIMITS.page.relationArm
				)
					throw tooLarge(
						`relation '${rel}' holds more than ${LIMITS.page.relationArm} rows; state a limit (rule 9)`
					);
				for (const item of list) {
					const target = typeof item.model === 'string' ? item.model : r.target;
					walk(r.targetSelects?.[target] ?? r.select, [item]);
				}
			}
	};
	walk(ir.select, rows);
}
const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));
/**
 * The one read API's call (`query(request)`; `db.query` as the workspace) as the decoder's member: a read request, the
 * only shape `query` takes. Other members (`aggregate`, `history`, the engine's own `get`, `read`, `after`) pass through.
 */
function decoderCall(member: string, args: readonly Json[]): [string, readonly Json[]] {
	if (member !== 'query' && member !== 'db.query') return [member, args];
	const [request] = args;
	if (args.length !== 1 || !isJsonObject(request))
		throw BoltError.make(
			'invalid',
			'decode',
			'query takes one read request: query({ <model>: { where?, fields?, orderBy?, limit? }, … })'
		);
	return [member === 'db.query' ? 'db.request' : 'request', [request]];
}
/** The host maps the Result decoder at its one wire edge. */
export function lowerRead(m: EngineManifest, member: string, args: readonly Json[]): ReadIR {
	const [decoded, decodedArgs] = decoderCall(member, args);
	return Result.match(decodeRead(catalogOf(m), decoded, decodedArgs), {
		onSuccess: (value) => value,
		onFailure: (error) => {
			throw BoltError.make('invalid', 'decode', error.message, error);
		}
	});
}

/** No acquired Callables/Agents dependency: search bodies run in the guest. */
export const ReadsLive = Layer.effect(
	Reads,
	Effect.gen(function* () {
		const manifest = yield* Manifest;
		const db = yield* TenantDbService;
		const guest = yield* Guest;
		const ai = yield* Ai;
		const crypto = yield* Crypto.Crypto;
		const uuid = crypto
			.randomUUIDv4()
			.pipe(
				Effect.mapError((error) =>
					BoltError.make('unavailable', 'facility', 'Secure random UUID generation failed.', error)
				)
			);
		const held = yield* heldModels(db);
		/** A pure search body (`probe`, `rerank`): 0 crossings, run as the platform. */
		const invoke = Effect.fn('Bolt.searchBody')(function* (
			kind: 'probe' | 'rerank' | 'validation',
			target: string,
			input: Json,
			bindings: Bindings
		) {
			const id = yield* uuid;
			const outcome = yield* guest.invoke(
				{
					id,
					kind,
					target,
					input,
					ctx: {
						actor: { kind: 'system', run: id, by: { platform: 'search' } },
						now: bindings.now,
						today: bindings.today,
						tz: bindings.tz,
						seed: id
					},
					budget: { crossings: 0, readBytes: LIMITS.readBytes }
				},
				{
					cross: (calls) =>
						Effect.succeed(
							calls.map((): CrossAnswer => ({
								ok: false,
								error: { kind: 'bolt', code: 'forbidden', message: 'A search body reads nothing.' }
							}))
						)
				}
			);
			if (outcome.kind === 'failed') return yield* Effect.fail(outcome.error);
			if (outcome.kind === 'refused')
				return yield* Effect.fail(BoltError.make('forbidden', 'guest', outcome.message));
			return outcome.output;
		});
		const make = (over: TenantDb): ReadEngine => {
			const history = (read: ReadIR, reader: Reader, bindings: Bindings) =>
				read.kind === 'history'
					? readHistory(over, manifest, read, reader, bindings)
					: Effect.fail(BoltError.make('invalid', 'decode', 'Expected a history read.'));
			return readEngine({
				db: over,
				manifest,
				held,
				delegate: {
					history,
					transcript: (read, who) => agentRead(over, manifest, read, who),
					inbox: (read, who) => agentRead(over, manifest, read, who),
					conversations: (read, who) => agentRead(over, manifest, read, who)
				},
				index: (model, name, bindings) => {
					const index = manifest.models[model]?.search?.indexes?.[name];
					if (index === undefined) return undefined;
					const target = `${model}.${name}`;
					const probe: IndexBodies['probe'] = Effect.fnUntraced(function* (input, custom) {
						for (const [name, values] of Map.groupBy(custom, (value) => value.name)) {
							const checked = yield* invoke(
								'validation',
								name,
								values.map((value) => value.value),
								bindings
							).pipe(
								Effect.flatMap(
									Schema.decodeUnknownEffect(Schema.Array(Schema.NullOr(Schema.String)))
								),
								Effect.mapError((error) =>
									error instanceof BoltError
										? error
										: BoltError.make('badAnswer', 'guest', error.message, error)
								)
							);
							if (checked.length !== values.length)
								return yield* BoltError.make(
									'badAnswer',
									'guest',
									'A custom validation returns one result per value.'
								);
							const bad = checked.findIndex((message) => message !== null);
							const value = values[bad];
							if (value !== undefined)
								return yield* BoltError.make(
									'invalidInput',
									'decode',
									`${value.path}: ${checked[bad]}`
								);
						}
						return yield* invoke('probe', target, input, bindings).pipe(
							Effect.flatMap((value) =>
								Schema.decodeUnknownEffect(
									Schema.Struct({
										vector: Schema.Array(Schema.Number),
										where: Schema.optionalKey(Schema.Json)
									})
								)(value)
							),
							Effect.mapError((error) =>
								error instanceof BoltError
									? error
									: BoltError.make('badAnswer', 'guest', error.message, error)
							)
						);
					});
					const rerank = (input: Json, rows: readonly RowData[]) =>
						invoke('rerank', target, [input, rows], bindings).pipe(
							Effect.map((scores) => {
								const values = jsonArray(scores) ? scores : [];
								return rows.map((_, at) => {
									const score = values[at];
									return typeof score === 'number' ? score : undefined;
								});
							})
						);
					return index.rerank === true ? { probe, rerank } : { probe };
				},
				embed: (model, text) => {
					const semantic = manifest.models[model]?.search?.semantic;
					if (semantic === undefined)
						return Effect.fail(
							BoltError.make(
								'invalid',
								'decode',
								`'${model}' declares no search.semantic (rule 16)`
							)
						);
					return ai.embed([text], semantic.model, semantic.dim).pipe(
						Effect.mapError((error) =>
							BoltError.make(
								error._tag === 'Unavailable' ? 'unavailable' : error.kind,
								'facility',
								error._tag === 'Unavailable' ? error.reason : error.message,
								error
							)
						),
						Effect.flatMap((vectors) =>
							vectors.length === 1 && vectors[0]?.length === semantic.dim
								? Effect.succeed(vectors[0])
								: Effect.fail(
										BoltError.make(
											'badAnswer',
											'facility',
											'The embedding width differs from its declared dimension.'
										)
									)
						)
					);
				}
			});
		};
		return make(db);
	})
);
