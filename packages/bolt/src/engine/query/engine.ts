// The read engine (A4): one batch = one pipelined round trip. Identical reads run once; an index search's
// probe runs before the round trip and its re-rank after. Nothing is clamped: `all` past its cap is `too_large`.
import { uuid } from '../port.ts';
import {
	Cache,
	Context,
	Crypto,
	Effect,
	Latch,
	Request,
	RequestResolver,
	Layer,
	Predicate,
	Schema
} from 'effect';
import type { Authority, Bindings, CrossAnswer, Reader, RowData, Rows, Sql } from '../contracts.ts';
import type { Order, Pred, SelectIR } from '@norbital-ai/store';
import { decodeRead, type ReadIR } from '../../protocol/reads.ts';
import type { EngineManifest } from '../manifest.ts';
import type { Entry, ReadsShape as ReadEngine, ReadsShape } from '../services.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { syncState } from '../sync/index.ts';
import { approvable, heldModels, rowApproval } from '../approvals/lock.ts';
import { LIMITS } from '../contracts.ts';
import { DbError, type EngineError } from '../errors.ts';
import { BoltError, from_store } from '../../protocol/errors.ts';
import { Reads, Manifest, Guest } from '../services.ts';
import { SqlReadCapture, TenantDb as TenantDbService } from '../db/tenant-db.ts';
import { Ai } from '../ports.ts';

import { decodeInput, type Decoded } from '../callables/decode.ts';

import { agentRead } from '../agent/reads.ts';
import { runList } from '../runs/rows.ts';
import { read_history } from './history.ts';
import { ReadSnapshots, readSnapshot } from './snapshot.ts';
import { decodeValue } from '../db/rows.ts';
import type { Json } from '../../decl/values.ts';
import {
	exposure_of,
	compile as compileSource,
	compile_gets as compileSourceGets,
	default_fields,
	encode_cursor,
	OVER,
	total_of,
	q,
	SEMANTIC,
	stored_fields,
	where,
	type Catalog,
	type Compiled,
	type Probe
} from '@norbital-ai/store';
import { catalog_of } from '../access/pred.ts';
import { viewOutput } from '../access/authority.ts';
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
	/** What must settle before a read reads `held`. */
	ready?: Effect.Effect<void, DbError>;
	index?: (model: string, name: string, bindings: Bindings) => IndexBodies | undefined;
	/** Reads another area answers: `history`, `transcript` (the agent). */
	delegate?: Partial<
		Record<
			'history' | 'transcript' | 'inbox' | 'conversations' | 'runs',
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
	/** `search.semantic`'s probe: one text embedded on the model's model class; absent → `/semantic` and `similar({ to: text })` are `unavailable`. */
	embed?: (model: string, text: string) => Effect.Effect<readonly number[], EngineError>;
};
const checkedRead = <A>(read: () => A) =>
	Effect.try({
		try: read,
		catch: (error) =>
			error instanceof BoltError
				? error
				: BoltError.make(
						'bad_answer',
						'decode',
						error instanceof Error ? error.message : String(error),
						error
					)
	});
const too_large = (message: string) => BoltError.make('too_large', 'deliver', message);
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
 * caller's read arms on each of them cross. A read request touches what each of its roots' reads does.
 */
export function readTargets(cat: Catalog, ir: ReadIR, authority?: Authority): ReadonlySet<string> {
	if (ir.kind === 'request')
		return new Set(
			ir.roots.flatMap((r) =>
				('read' in r ? [r.read] : r.as_of).flatMap((x: ReadIR) => [
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
		const info = cat.models.get(model);
		for (const target of info?.label_link?.targets ?? []) add(target);
		if (info?.record_label?.stored === false)
			for (const path of info.record_label.paths) {
				const [field = path, leaf] = path.split('.');
				if (leaf !== undefined) for (const target of info.one.get(field)?.targets ?? []) add(target);
			}
		const grant = authority === undefined || authority.admin ? undefined : authority.models[model];
		for (const arm of Object.values(grant?.read ?? {}).flatMap((paths) =>
			Object.values(paths).flat()
		))
			pred(arm.where);
	}
	add(ir.model);
	if (ir.kind === 'transcript') add('sys_conversation');
	if (ir.kind === 'runs') add('sys_user');
	if (ir.kind === 'conversations') {
		add('sys_message');
		add('sys_user');
		add('sys_envoy');
	}
	if (ir.kind === 'inbox' && ir.requests) {
		add('bolt_approvals');
		add('sys_user');
	}
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
const decodeSemanticInput = Schema.decodeUnknownEffect(
	Schema.Union([Schema.String, Schema.Struct({ record: Schema.Struct({ id: Schema.String }) })])
);
const isRow = (v: Json): v is { readonly [k: string]: Json } =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const decodeCursorKey = Schema.decodeUnknownEffect(Schema.Array(Schema.NullOr(Schema.String)));

export function read_engine(config: ReadEngineConfig): ReadEngine & {
	catalog: Catalog;
} {
	const options = (reader: Reader, bindings: Bindings) =>
		readOptions(reader, bindings, { sources: config.querySources?.sources, approvals, allBytes });
	const compile = (cat: Catalog, ir: ReadIR, reader: Reader, bindings: Bindings, probe?: Probe) =>
		ir.kind === 'read' || ir.kind === 'get' || ir.kind === 'aggregate' || ir.kind === 'similar'
			? compileSource(cat, ir, options(reader, bindings), probe).pipe(Effect.mapError(from_store))
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
			Effect.mapError(from_store)
		);
	const cat = catalog_of(config.manifest);
	// a request opens only on a model today's grants route, or one an earlier release's request still holds
	const approvals = new Set(approvable(config.manifest, cat));
	const allBytes = config.allBytes ?? LIMITS.page.allBytes;
	const plan = Effect.fn('Bolt.plan')(function* (
		ir: ReadIR,
		reader: Reader,
		bindings: Bindings,
		from: Entry
	) {
		if (config.ready !== undefined) yield* config.ready;
		for (const model of config.held ?? []) approvals.add(model);
		if (ir.kind === 'request')
			return yield* BoltError.make('internal', 'decode', 'a read request is answered by its roots');
		if (ir.kind === 'after')
			return yield* BoltError.make('internal', 'decode', 'an after read is answered by the write compiler');
		if (
			ir.kind === 'history' ||
			ir.kind === 'transcript' ||
			ir.kind === 'inbox' ||
			ir.kind === 'conversations' ||
			ir.kind === 'runs'
		) {
			const d = config.delegate?.[ir.kind];
			if (d === undefined)
				return yield* BoltError.make('unsupported', 'decode', `this host answers no '${ir.kind}' read`);
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
			const embed = config.embed;
			if (embed === undefined)
				return yield* BoltError.make('unavailable', 'facility', 'this host embeds no text: $similar is unavailable');
			const probes = new Map<string, Effect.Effect<readonly number[], EngineError>>();
			const walk = (p: Pred, c: string): void => {
				if (p.t === 'and' || p.t === 'or') p.of.forEach((x) => walk(x, c));
				else if (p.t === 'not') walk(p.of, c);
				else if (p.t === 'one' || p.t === 'many') walk(p.pred, p.target);
				else if (p.t === 'similar' && !probes.has(`${c}\n${p.to}`))
					probes.set(`${c}\n${p.to}`, embed(c, p.to));
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
			const put = (p: Pred, c: string): Pred => {
				if (p.t === 'and' || p.t === 'or') return { ...p, of: p.of.map((x) => put(x, c)) };
				if (p.t === 'not') return { ...p, of: put(p.of, c) };
				if (p.t === 'one' || p.t === 'many') return { ...p, pred: put(p.pred, p.target) };
				if (p.t !== 'similar') return p;
				const vector = vectors.get(`${c}\n${p.to}`);
				if (vector === undefined) throw BoltError.make('corrupt', 'decode', 'The similarity predicate has no embedding.');
				return { ...p, vector };
			};
			const predicate = ir.where, model = ir.model;
			const where = yield* Effect.try({ try: () => put(predicate, model), catch: (error) =>
				error instanceof BoltError ? error : BoltError.make('corrupt', 'decode', 'The similarity predicate did not assemble.', error) });
			ir = { ...ir, where };
		}
		// `/semantic <text>` and `similar(c, { to })` over `search.semantic`
		const embed = Effect.fnUntraced(function* (text: string) {
			if (
				(yield* exposure_of(cat, ir.model).pipe(Effect.mapError(from_store))).model.semantic ===
				undefined
			)
				return yield* BoltError.make('invalid', 'decode', `'${ir.model}' declares no search.semantic`);
			if (config.embed === undefined)
				return yield* BoltError.make('unavailable', 'facility', 'this host embeds no text: semantic search is unavailable');
			return yield* config.embed(ir.model, text);
		});
		if (ir.kind === 'read' && ir.search !== undefined && /^\/semantic(\s|$)/.test(ir.search)) {
			const text = ir.search.replace(/^\/semantic\s*/, '');
			if (text === '')
				return yield* BoltError.make('invalid', 'decode', '/semantic needs something to search for');
			return {
				compiled: yield* compile(cat, ir, reader, bindings, {
					field: SEMANTIC,
					vector: yield* embed(text),
					take: 0
				})
			};
		}
		if (ir.kind === 'similar' && ir.index === SEMANTIC) {
			const to = yield* decodeSemanticInput(ir.input).pipe(
				Effect.mapError(() =>
					BoltError.make('invalid_input', 'decode', 'search.semantic takes text or { record: { id } }')
				)
			);
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
			return yield* BoltError.make('invalid', 'decode', `'${ir.model}' has no search index '${ir.index}'`);
		const decoded = decodeInput(spec.input, ir.input, config.manifest.custom_fields ?? {});
		if (decoded.problems.length > 0)
			return yield* BoltError.make(
				'invalid_input',
				'decode',
				decoded.problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ')
			);
		const input = decoded.value ?? null;
		const probe = yield* bodies.probe(input, decoded.custom ?? []);
		const candidates =
			bodies.rerank === undefined
				? 1
				: ((yield* exposure_of(cat, ir.model).pipe(Effect.mapError(from_store))).model.indexes[
						ir.index
					]?.candidates ?? 4);
		const take = ir.limit * candidates;
		if (take > LIMITS.page.max)
			return yield* too_large(`the search asks the index for ${take} rows (limit × candidates ≤ ${LIMITS.page.max})`);
		const w: Pred | undefined =
			probe.where === undefined
				? undefined
				: yield* where(cat, ir.model, probe.where).pipe(Effect.mapError(from_store));
		// a rerank measures the whole row: a narrowed select is widened for it and narrowed back after (hook:reads)
		const selected = bodies.rerank === undefined ? undefined : ir.select;
		const want = selected?.fields ?? null;
		const c = yield* exposure_of(cat, ir.model).pipe(Effect.mapError(from_store));
		const wide =
			selected === undefined || want === null
				? ir
				: {
						...ir,
						select: {
							...selected,
							fields: [
								...new Set([
									...want,
									...(reader.as === 'caller' ? default_fields(c) : stored_fields(c.model))
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
				...(selected === undefined || want === null
					? {}
					: {
							keep: new Set([
								'id',
								'$distance',
								'$approval',
								...want,
								...Object.keys(selected.relations)
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
		const c = p.compiled;
		if (c === undefined) return yield* BoltError.make('corrupt', 'decode', 'The statement read has no compiled plan.');
		const counted = total_of(rows.map((r) => r['j'] ?? null));
		const total = counted.total === undefined ? {} : { total: counted.total };
		const answered = counted.rows.filter(isRow);
		// the database stopped at the read's byte budget (`budgeted`): the marker is no row
		const over = answered.at(-1)?.[OVER] === true;
		const js = over ? answered.slice(0, -1) : answered;
		const of = 'model' in ir ? ` of ${String(ir.model)}` : '';
		yield* checkedRead(() => armsFit(ir, js));
		if (c.kind === 'one' || c.kind === 'agg') return js[0] ?? null;
		if (ir.kind === 'similar' && over)
			return yield* too_large(`the search${of} is larger than ${allBytes} bytes`);
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
				return yield* too_large(`the read${of} matches more than ${LIMITS.page.all} rows; page it`);
			if (over)
				return yield* too_large(`the read${of} is larger than ${allBytes} bytes; page it`);
			return { rows: js, next: null, ...total };
		}
		// a page ends early at one crossing's bytes, its cursor after the last row that fits
		if (over && js.length === 0)
			return yield* too_large(`a row${of} is larger than ${LIMITS.crossingBytes} bytes; select fewer fields`);
		if (c.limit === null) return yield* BoltError.make('corrupt', 'decode', 'The paged read has no limit.');
		const more = over || js.length > c.limit;
		const page = js.slice(0, c.limit);
		const last = page.at(-1);
		const next =
			more && last !== undefined
				? encode_cursor(
						c.hash,
						yield* decodeCursorKey(last['$k']).pipe(
							Effect.mapError(() => BoltError.make('corrupt', 'decode', 'A paged row has no cursor key.'))
						)
					)
				: null;
		return { rows: page.map(({ $k: _, ...row }) => row), next, ...total };
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
					? ir.roots.flatMap((r): readonly ReadIR[] => ('read' in r ? [r.read] : r.as_of))
					: [ir];
			const values = yield* run(batch.flatMap(parts), reader, bindings, from);
			let at = 0;
			const next = (): Json => {
				const value = values[at++];
				if (value === undefined) throw BoltError.make('corrupt', 'decode', 'The read request returned no root answer.');
				return value;
			};
			return yield* Effect.try({ try: () => batch.map((ir): Json => {
				if (ir.kind !== 'request') return next();
				return Object.fromEntries(
					ir.roots.map((r) => {
						if ('read' in r) return [r.root, next()];
						const keep = r.fields === undefined ? undefined : new Set(['id', ...r.fields]);
						const rows = r.as_of.flatMap((): Json[] => {
							const row = next();
							if (!Predicate.isObject(row)) return [];
							return [
								keep === undefined
									? row
									: Object.fromEntries(Object.entries(row).filter(([k]) => keep.has(k)))
							];
						});
						return [r.root, { rows, next: null, total: rows.length }];
					})
				);
			}), catch: (error) => error instanceof BoltError ? error : BoltError.make('corrupt', 'decode', 'The read request did not assemble.', error) });
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
		const distinct = new Map<string, ReadIR>();
		const keys = batch.map((ir) => {
			const key = JSON.stringify(ir);
			if (!distinct.has(key)) distinct.set(key, ir);
			return key;
		});
		const unique = [...distinct.keys()];
		const irs = [...distinct.values()];
		// `get`s of one shape merge into one lateral statement
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
			const first = g[0];
			if (g.length < 2 || first === undefined) continue;
			mergedSql.push(
				composable(
					yield* compileGets(
						cat,
						first[0].model,
						g.map(([ir]) => ir.id),
						first[0].select,
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
				: [((ir) => (ir !== undefined && 'cte' in ir ? ir.cte : undefined))(irs[k])]
		);
		const base = statements.length;
		statements.push(...mergedSql);
		const snapshots = yield* ReadSnapshots;
		const snapshotIndex = snapshots !== undefined && statements.length > 0 ? statements.length : undefined;
		if (snapshotIndex !== undefined)
			statements.push({ text: 'SELECT pg_current_snapshot()::text AS snapshot', params: [] });
		const results = statements.length === 0 ? [] : yield* read_composed(config.db, statements, ctes);
		if (snapshotIndex !== undefined && snapshots !== undefined) {
			const result = results[snapshotIndex];
			if (result === undefined) return yield* BoltError.make('corrupt', 'decode', 'The read batch returned no snapshot.');
			const value = yield* decodeValue(Schema.String, result);
			const snapshot = yield* Effect.try({ try: () => readSnapshot(value), catch: (error) =>
				error instanceof BoltError ? error : BoltError.make('corrupt', 'decode', 'The read snapshot did not decode.', error) });
			for (const [index, ir] of irs.entries())
				if (plans[index]?.compiled !== undefined || merged.has(index)) snapshots.set(JSON.stringify(ir), snapshot);
		}
		let i = 0;
		const answers = yield* Effect.all(
			plans.map(
				Effect.fnUntraced(function* (p: Plan, k: number) {
					const at = merged.get(k);
					const ir = irs[k];
					if (ir === undefined) return yield* BoltError.make('corrupt', 'decode', 'The read plan has no source.');
					return yield* Effect.gen(function* () {
						if (at === undefined) {
							if (p.answer !== undefined) return yield* p.answer;
							const result = results[i++];
							if (result === undefined) return yield* BoltError.make('corrupt', 'decode', 'The read returned no statement answer.');
							return yield* finish(p, ir, result.rows);
						}
						const result = results[base + at.s]?.rows[at.n];
						if (result === undefined) return yield* BoltError.make('corrupt', 'decode', 'The grouped get returned no row envelope.');
						const { j } = yield* Schema.decodeUnknownEffect(Schema.Struct({ j: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)) }))(result).pipe(
							Effect.mapError((error) => BoltError.make('corrupt', 'decode', 'The grouped get returned an invalid row.', error)));
						yield* checkedRead(() => armsFit(ir, j === null ? [] : [j]));
						return j;
					}).pipe(
						Effect.catch((e) =>
							Effect.gen(function* () {
								// a keyed read's member names itself in its cap (`ctx.read({ … })`)
								const member = 'member' in ir && typeof ir.member === 'string' ? ir.member : undefined;
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
		// every reader's root rows carry `$sync` and the open request holding them as `$approval`
		const exposed = yield* Effect.all(
			answers.map(
				Effect.fnUntraced(function* (answer: Json, index: number) {
					const ir = irs[index];
					if (ir === undefined) return yield* BoltError.make('corrupt', 'decode', 'The answer has no source read.');
					if ((ir.kind !== 'get' && ir.kind !== 'read' && ir.kind !== 'similar') || answer === null)
						return answer;
					const rows =
						ir.kind === 'get'
							? [answer]
							: Predicate.isObject(answer) && jsonArray(answer['rows'])
								? answer['rows']
								: [];
					const records = rows
						.filter((row) => Predicate.isObject(row))
						.filter((row) => typeof row['id'] === 'string');
					const ids = records.map((row) => String(row['id']));
					// `$sync` summarizes each sync's latest state per connection: failure before pending before acknowledged.
					// Delivery status is advisory; its worker must not invalidate a business read.
					const states = yield* syncState(config.manifest, config.db, ir.model, ids).pipe(
						Effect.provideService(SqlReadCapture, undefined)
					);
					// the statement read the open request holding each row as a raw `$approval` (sql.ts `root`)
					const names = approvals.has(ir.model) ? rowApproval : undefined;
					if (states === undefined && names === undefined) return answer;
					const attach = (row: Json): Json => {
						if (!Predicate.isObject(row) || typeof row['id'] !== 'string') return row;
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
						: Predicate.isObject(answer)
							? { ...answer, rows: rows.map(attach) }
							: answer;
				})
			),
			{ concurrency: 'unbounded' }
		);
		const out: Json[] = [];
		for (const key of keys) {
			const answer = exposed[unique.indexOf(key)];
			if (answer === undefined) return yield* BoltError.make('corrupt', 'decode', 'The read batch returned no answer.');
			out.push(answer);
		}
		return out;
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
export const read_composed = Effect.fn('Bolt.read_composed')(function* (
	db: TenantDb,
	statements: readonly Sql[],
	ctes: readonly (string | undefined)[] = []
) {
	const named = ctes.some((name) => name !== undefined);
	const folded = statements.flatMap((s, i) =>
		isComposable(s) || ctes[i] !== undefined ? [i] : []
	);
	if (folded.length < 2 && !named) {
		const result = yield* db.read(statements);
		if (result.length !== statements.length || result.some((row) => row === undefined))
			return yield* Effect.fail(DbError.make('22P02', 'The read batch returned an incomplete answer.'));
		return result;
	}
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
		const s = statements[m];
		if (s === undefined) return yield* Effect.fail(DbError.make('22P02', 'The composed read has no source statement.'));
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
	if (res.length !== composed.length + others.length)
		return yield* Effect.fail(DbError.make('22P02', 'The composed read returned the wrong number of answers.'));
	const out: Rows[] = [];
	for (const result of res.slice(0, composed.length)) {
		if (result === undefined)
			return yield* Effect.fail(DbError.make('22P02', 'The composed read returned no statement answer.'));
		for (const row of result.rows) {
			const decoded = yield* Schema.decodeUnknownEffect(
				Schema.Struct({
					m: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: statements.length - 1 })),
					j: Schema.Array(Schema.Record(Schema.String, Schema.Json))
				})
			)(row).pipe(
				Effect.mapError((error) =>
					DbError.make('22P02', `The composed read answer is invalid: ${error.message}`)
				)
			);
			if (out[decoded.m] !== undefined)
				return yield* Effect.fail(DbError.make('22P02', 'The composed read returned a duplicate answer.'));
			out[decoded.m] = { rows: decoded.j, affected: decoded.j.length };
		}
	}
	for (const [n, [i]] of others.entries()) {
		const result = res[composed.length + n];
		if (result === undefined) return yield* Effect.fail(DbError.make('22P02', 'The read returned no statement answer.'));
		out[i] = result;
	}
	const answers: Rows[] = [];
	for (const index of statements.keys()) {
		const result = out[index];
		if (result === undefined) return yield* Effect.fail(DbError.make('22P02', 'The composed read omitted a statement answer.'));
		answers.push(result);
	}
	return answers;
});
/** This allocation belongs to one act; cache failures as well as successful first answers. */
export const memo_reads = Effect.fn('Bolt.memo_reads')(function* (db: TenantDb) {
	const statements = new Map<string, Sql>();
	const cache = yield* Cache.make({
		capacity: Infinity,
		lookup: (key: string) => {
			const statement = statements.get(key);
			if (statement === undefined) return Effect.die('memo_reads: missing registered statement');
			return Effect.gen(function* () {
				const rows = yield* db.read([statement]);
				const row = rows[0];
				if (rows.length !== 1 || row === undefined)
					return yield* Effect.fail(DbError.make('22P02', 'The memoized read returned no statement answer.'));
				return row;
			});
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
			const rows = yield* read_composed(
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
/** A many-relation arm asked for `all` holds at most `LIMITS.page.relationArm` rows, at any depth. */
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
				const list = (
					r.many ? (jsonArray(v) ? v : []) : v === null || v === undefined ? [] : [v]
				).filter((value) => Predicate.isObject(value));
				if (
					r.many &&
					r.page !== undefined &&
					r.page._tag === 'All' &&
					list.length > LIMITS.page.relationArm
				)
					throw too_large(
						`relation '${rel}' holds more than ${LIMITS.page.relationArm} rows; state a limit`
					);
				for (const item of list) {
					const target = typeof item.model === 'string' ? item.model : r.target;
					walk(r.targetSelects?.[target] ?? r.select, [item]);
				}
			}
	};
	walk(ir.select, rows);
}
/**
 * The one read API's call (`query(request)`; `db.query` as the workspace) as the decoder's member: a read request, the
 * only shape `query` takes. Other members (`aggregate`, `history`, the engine's own `get`, `read`, `after`) pass through.
 */
function decoderCall(member: string, args: readonly Json[]): Effect.Effect<[string, readonly Json[]], BoltError> {
	if (member !== 'query' && member !== 'db.query') return Effect.succeed<[string, readonly Json[]]>([member, args]);
	const [request] = args;
	if (args.length !== 1 || !Predicate.isObject(request))
		return Effect.fail(
			BoltError.make(
				'invalid',
				'decode',
				'query takes one read request: query({ <model>: { where?, fields?, order_by?, limit? }, … })'
			)
		);
	return Effect.succeed<[string, readonly Json[]]>([member === 'db.query' ? 'db.request' : 'request', [request]]);
}
/** The host's one wire edge: every decode refusal is `invalid`. */
export const lower_read = Effect.fn('Bolt.lower_read')(function* (
	m: EngineManifest,
	member: string,
	args: readonly Json[]
): Effect.fn.Return<ReadIR, BoltError> {
	const [decoded, decodedArgs] = yield* decoderCall(member, args);
	return yield* decodeRead(catalog_of(m), decoded, decodedArgs).pipe(
		Effect.mapError((error) => BoltError.make('invalid', 'decode', error.message, error))
	);
});

/** One record as the caller's generic views read it: through its view output (`default` when held). */
export const viewGet = (m: EngineManifest, authority: Authority, model: string, id: string) =>
	Effect.map(lower_read(m, 'get', [model, id]), (read): ReadIR => {
		const output = viewOutput(m, authority, model);
		return read.kind === 'get' && output !== undefined ? { ...read, output } : read;
	});
/** Whether the caller may read that record, as an approval's reader asks: a refusal is a no. */
export const readableBy = (
	read: ReadsShape['run'],
	m: EngineManifest,
	authority: Authority,
	b: Bindings
) => (model: string, id: string) =>
	viewGet(m, authority, model, id).pipe(
		Effect.flatMap((ir) => read([ir], { as: 'caller', authority }, b)),
		Effect.map(([row]) => row !== null && row !== undefined),
		Effect.catchTag('BoltError', () => Effect.succeed(false))
	);

/** No acquired Callables/Agents dependency: search bodies run in the guest. */
export const ReadsLive = Layer.effect(
	Reads,
	Effect.gen(function* () {
		const manifest = yield* Manifest;
		const db = yield* TenantDbService;
		const guest = yield* Guest;
		const ai = yield* Ai;
		const crypto = yield* Crypto.Crypto;
		const newId = uuid(crypto);
		const held = new Set<string>();
		db.owe(
			heldModels(db).pipe(
				Effect.map((models) => {
					for (const model of models) held.add(model);
				}),
				Effect.mapError((error) =>
					error instanceof DbError ? error : DbError.make('XX000', error.message)
				)
			)
		);
		/** A pure search body (`probe`, `rerank`): 0 crossings, run as the platform. */
		const invoke = Effect.fn('Bolt.searchBody')(function* (
			kind: 'probe' | 'rerank' | 'validation',
			target: string,
			input: Json,
			bindings: Bindings
		) {
			const id = yield* newId;
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
				return yield* BoltError.make('forbidden', 'guest', outcome.message);
			return outcome.output;
		});
		const make = (over: TenantDb): ReadEngine => {
			const history = (read: ReadIR, reader: Reader, bindings: Bindings) =>
				read.kind === 'history'
					? read_history(over, manifest, read, reader, bindings)
					: Effect.fail(BoltError.make('invalid', 'decode', 'Expected a history read.'));
			return read_engine({
				db: over,
				manifest,
				held,
				ready: db.ready,
				delegate: {
					history,
					transcript: (read, who) => agentRead(over, manifest, read, who),
					inbox: (read, who) => agentRead(over, manifest, read, who),
					conversations: (read, who) => agentRead(over, manifest, read, who),
					runs: (read, who) =>
						read.kind !== 'runs' || who.as !== 'caller'
							? Effect.fail(BoltError.make('invalid', 'decode', 'Expected a caller runs read.'))
							: runList(over, who.authority, read.limit, read.automation, read.id, read.brief).pipe(
									Effect.map((rows) => ({
										rows,
										next: null
									}))
								)
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
										: BoltError.make('bad_answer', 'guest', error.message, error)
								)
							);
							if (checked.length !== values.length)
								return yield* BoltError.make(
									'bad_answer',
									'guest',
									'A custom validation returns one result per value.'
								);
							const bad = checked.findIndex((message) => message !== null);
							const value = values[bad];
							if (value !== undefined)
								return yield* BoltError.make(
									'invalid_input',
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
									: BoltError.make('bad_answer', 'guest', error.message, error)
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
								`'${model}' declares no search.semantic`
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
											'bad_answer',
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
