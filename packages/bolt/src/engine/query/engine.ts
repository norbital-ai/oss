// The read engine (A4, rule 12): one batch = one pipelined round trip. Identical reads run once; a similarity read's
// probe runs before the round trip and its re-rank after. Nothing is clamped (rule 9): `all` past its cap is `tooLarge`.
import {
	Cache,
	Crypto,
	Effect,
	Latch,
	Request,
	RequestResolver,
	Result,
	Layer,
	Schema
} from 'effect';
import type { Bindings, Reader, RowData, Rows, Sql } from '../contracts.ts';
import type { Pred, ReadIR, SelectIR } from '../../protocol/ir-types.ts';
import type { EngineManifest } from '../manifest.ts';
import type { ReadsShape as ReadEngine } from '../services.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { outboundState } from '../integrations/outbound.ts';
import { approvable, heldCollections, rowApproval } from '../approvals/lock.ts';
import { LIMITS } from '../contracts.ts';
import { DbError, type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { Reads, Manifest, Activation, Guest } from '../services.ts';
import { TenantDb as TenantDbService } from '../db/tenant-db.ts';
import { Ai } from '../ports.ts';
import * as irDecoder from '../../protocol/ir.ts';
import { projectionContext, readProjector } from './read-projector.ts';
import { readQuery } from '../callables/index.ts';
import { agentRead } from '../agent/reads.ts';
import { readHistory } from './history.ts';
import type { Json } from '../../decl/values.ts';
import type { Catalog } from '../../protocol/catalog.ts';
import { collectionOf, defaultFields, q, SEMANTIC, storedFields } from '../../protocol/catalog.ts';
import { catalogOf } from '../access/pred.ts';
import { where } from '../../protocol/ir.ts';
import { composable, isComposable, type Compiled } from './sql.ts';
import {
	compile as compileSource,
	compileGets as compileSourceGets,
	encodeCursor,
	type QuerySourceOptions
} from './sql.ts';
/** A declared similarity's attached bodies, run in the guest: `probe` picks the vector, `rerank` re-measures a page. */
export type SimilarityBodies = {
	probe(input: Json): Effect.Effect<
		{
			field: string;
			vector: readonly number[];
			where?: Json;
		},
		EngineError
	>;
	rerank?: (
		input: Json,
		rows: readonly RowData[]
	) => Effect.Effect<readonly (number | undefined)[], EngineError>;
};
type ReadEngineConfig = {
	/** Native write planning only: qualified prospective model sources. Never supplied by a guest. */
	querySources?: QuerySourceOptions;
	/** Trusted native projection after row/column authorization, before caller delivery. */
	projection?: (
		read: ReadIR,
		answer: Json,
		reader: Reader,
		bindings: Bindings
	) => Effect.Effect<Json, EngineError>;
	db: TenantDb;
	manifest: EngineManifest;
	/** Collections open approval requests held when the engine started (`$approval` beyond today's grants). */
	held?: ReadonlySet<string>;
	similarity?: (
		collection: string,
		name: string,
		bindings: Bindings
	) => SimilarityBodies | undefined;
	/** Reads another area answers: `history` (§5.2), `query` (a guest invocation), `after` (the write compiler), `transcript` (the agent). */
	delegate?: Partial<
		Record<
			'history' | 'query' | 'after' | 'transcript' | 'inbox' | 'conversations',
			(read: ReadIR, reader: Reader, bindings: Bindings) => Effect.Effect<Json, EngineError>
		>
	>;
	/** The byte cap of an `all` read: 8 MiB on `/q` (the default), 4 MiB per guest crossing. */
	allBytes?: number;
	/** `search.semantic`'s probe (L-BOLT-123): one text embedded on the collection's model class; absent → `/semantic` and `similar({ to: text })` are `unavailable`. */
	embed?: (collection: string, text: string) => Effect.Effect<readonly number[], EngineError>;
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
type Plan = {
	compiled?: Compiled;
	similar?: {
		bodies: SimilarityBodies;
		input: Json;
		limit: number;
		keep?: ReadonlySet<string>;
	};
	answer?: Effect.Effect<Json, EngineError>;
};
export function readEngine(config: ReadEngineConfig): ReadEngine & {
	catalog: Catalog;
} {
	const compile = (
		cat: Catalog,
		ir: ReadIR,
		reader: Reader,
		bindings: Bindings,
		probe?: Parameters<typeof compileSource>[4]
	) => checkedRead(() => compileSource(cat, ir, reader, bindings, probe, sources));
	const compileGets = (
		cat: Catalog,
		collection: string,
		ids: readonly string[],
		select: SelectIR,
		reader: Reader,
		bindings: Bindings
	) =>
		checkedRead(() => compileSourceGets(cat, collection, ids, select, reader, bindings, sources));
	const cat = catalogOf(config.manifest);
	// a request opens only on a collection today's grants route, or one an earlier release's request still holds
	const approvals = new Set([...approvable(config.manifest, cat), ...(config.held ?? [])]);
	const sources: QuerySourceOptions = { ...config.querySources, approvals };
	const allBytes = config.allBytes ?? LIMITS.page.allBytes;
	const requiresProjection = Object.values(config.manifest.collections).some(
		(spec) =>
			(
				spec.read as {
					projection?: unknown;
				}
			).projection !== undefined
	);
	const plan = Effect.fn('Bolt.plan')(function* (ir: ReadIR, reader: Reader, bindings: Bindings) {
		if (
			ir.kind === 'history' ||
			ir.kind === 'query' ||
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
			return { answer: d(ir, reader, bindings) };
		}
		if (
			(ir.kind === 'read' && ir.page._tag === 'Limit' && ir.page.limit === 0) ||
			(ir.kind === 'similar' && ir.limit === 0)
		)
			return { answer: Effect.succeed(ir.kind === 'read' ? { rows: [], next: null } : []) };
		// `$similar` in a predicate: every distinct (collection, text) embedded once, together, before the statement
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
			walk(ir.where, ir.collection);
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
			ir = { ...ir, where: put(ir.where, ir.collection) };
		}
		// L-BOLT-123: `/semantic <text>` and `similar(c, { to })` over `search.semantic`
		const embed = Effect.fnUntraced(function* (text: string) {
			if (collectionOf(cat, ir.collection).model.semantic === undefined)
				return yield* Effect.fail(
					BoltError.make(
						'invalid',
						'decode',
						`'${ir.collection}' declares no search.semantic (rule 16)`
					)
				);
			if (config.embed === undefined)
				return yield* Effect.fail(
					BoltError.make(
						'unavailable',
						'facility',
						'this host embeds no text: semantic search is unavailable'
					)
				);
			return yield* config.embed(ir.collection, text);
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
		if (ir.kind === 'similar' && ir.similarity === SEMANTIC) {
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
		const bodies = config.similarity?.(ir.collection, ir.similarity, bindings);
		if (bodies === undefined)
			return yield* Effect.fail(
				BoltError.make(
					'invalid',
					'decode',
					`'${ir.collection}' has no similarity '${ir.similarity}'`
				)
			);
		const probe = yield* bodies.probe(ir.input);
		const candidates =
			bodies.rerank === undefined
				? 1
				: (collectionOf(cat, ir.collection).similarity[ir.similarity]?.candidates ?? 4);
		const take = ir.limit * candidates;
		if (take > LIMITS.page.max)
			return yield* Effect.fail(
				tooLarge(
					`similar asks the index for ${take} rows (limit × candidates ≤ ${LIMITS.page.max})`
				)
			);
		const w: Pred | undefined =
			probe.where === undefined
				? undefined
				: yield* checkedRead(() => where(cat, ir.collection, probe.where));
		if (reader.as === 'caller' && w !== undefined)
			yield* checkedRead(() =>
				guardProjectedOperands(config.manifest, {
					kind: 'read',
					collection: ir.collection,
					where: w,
					select: ir.select ?? { fields: null, relations: {} },
					page: { _tag: 'Limit', limit: ir.limit }
				})
			);
		// a rerank measures the whole row: a narrowed select is widened for it and narrowed back after (hook:reads)
		const want = bodies.rerank === undefined ? null : (ir.select?.fields ?? null);
		const c = collectionOf(cat, ir.collection);
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
				field: probe.field,
				vector: probe.vector,
				...(w === undefined ? {} : { where: w }),
				take
			}),
			similar: {
				bodies,
				input: ir.input,
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
		const js = rows.map(
			(r) =>
				r.j as {
					[k: string]: Json;
				}
		);
		yield* checkedRead(() => armsFit(ir, js));
		if (c.kind === 'one' || c.kind === 'agg') return js[0] ?? null;
		if (ir.kind === 'similar' && p.similar === undefined) return js; // search.semantic: nearest first, already limited
		if (p.similar !== undefined) {
			const { bodies, input, limit, keep } = p.similar;
			if (bodies.rerank === undefined) return js.slice(0, limit);
			const scores = yield* bodies.rerank(input, js);
			// scored rows ascending; an `undefined` score keeps index order behind them (stable sort)
			const order = js
				.map((row, i) => ({ row, s: scores[i] ?? Infinity }))
				.sort((x, y) => x.s - y.s);
			return order
				.slice(0, limit)
				.map((x) =>
					keep === undefined
						? x.row
						: Object.fromEntries(Object.entries(x.row).filter(([k]) => keep.has(k)))
				);
		}
		if (c.limit === 'all') {
			const of = 'collection' in ir ? ` of ${String(ir.collection)}` : '';
			if (js.length > LIMITS.page.all)
				return yield* Effect.fail(
					tooLarge(`the read${of} matches more than ${LIMITS.page.all} rows; page it (rule 9)`)
				);
			if (JSON.stringify(js).length > allBytes)
				return yield* Effect.fail(
					tooLarge(`the read${of} is larger than ${allBytes} bytes; page it (rule 9)`)
				);
			return { rows: js, next: null };
		}
		const more = js.length > c.limit!;
		const page = js.slice(0, c.limit!);
		const last = page.at(-1);
		const next =
			more && last !== undefined ? encodeCursor(c.hash, last.$k as (string | null)[]) : null;
		return { rows: page.map(({ $k: _, ...row }) => row), next };
	});
	return {
		catalog: cat,
		run: Effect.fn('Bolt.read')(function* (
			batch: readonly ReadIR[],
			reader: Reader,
			bindings: Bindings
		) {
			if (reader.as === 'caller' && requiresProjection && config.projection === undefined)
				return yield* Effect.fail(
					BoltError.make(
						'unavailable',
						'deliver',
						'This native reader must enforce its declared JSON projections.'
					)
				);
			const keys = batch.map((ir) => JSON.stringify(ir));
			const unique = [...new Set(keys)];
			const irs = unique.map((k) => batch[keys.indexOf(k)]!);
			if (reader.as === 'caller')
				for (const ir of irs) yield* checkedRead(() => guardProjectedOperands(config.manifest, ir));
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
			for (const g of Map.groupBy(gets, ([ir]) =>
				JSON.stringify([ir.collection, ir.select])
			).values()) {
				if (g.length < 2) continue;
				mergedSql.push(
					composable(
						yield* compileGets(
							cat,
							g[0]![0].collection,
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
					merged.has(k) ? Effect.succeed({}) : plan(ir, reader, bindings)
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
			const results =
				statements.length === 0 ? [] : yield* readComposed(config.db, statements, ctes);
			let i = 0;
			const answers = yield* Effect.all(
				plans.map(
					Effect.fnUntraced(function* (p: Plan, k: number) {
						const at = merged.get(k);
						return yield* Effect.gen(function* () {
							if (at === undefined)
								return yield* p.answer ?? finish(p, irs[k]!, results[i++]!.rows);
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
			const delivered =
				reader.as !== 'caller' || config.projection === undefined
					? answers
					: yield* Effect.all(
							answers.map((answer, index) =>
								config.projection!(irs[index]!, answer, reader, bindings)
							),
							{ concurrency: 'unbounded' }
						);
			const exposed =
				reader.as !== 'caller'
					? delivered
					: yield* Effect.all(
							delivered.map(
								Effect.fnUntraced(function* (answer: Json, index: number) {
									const ir = irs[index]!;
									if ((ir.kind !== 'get' && ir.kind !== 'read') || answer === null) return answer;
									const object = (value: Json): value is RowData =>
										value !== null && typeof value === 'object' && !Array.isArray(value);
									const rows =
										ir.kind === 'get'
											? [answer]
											: object(answer) && Array.isArray(answer['rows'])
												? answer['rows']
												: [];
									const records = rows
										.filter(object)
										.filter((row) => typeof row['id'] === 'string');
									const ids = records.map((row) => String(row['id']));
									// §4.2: a record an outbound rule sends from carries each rule's latest delivery as `$outbound`
									const states = yield* outboundState(
										config.manifest,
										config.db,
										ir.collection,
										ids
									);
									// rule 46b: the statement read the open request holding each row as a raw `$approval` (sql.ts `root`)
									const names = approvals.has(ir.collection)
										? rowApproval(config.manifest)
										: undefined;
									if (states === undefined && names === undefined) return answer;
									const attach = (row: Json): Json => {
										if (!object(row) || typeof row['id'] !== 'string') return row;
										const { $approval: raw, ...rest } = row;
										const approval = raw === undefined || raw === null ? undefined : names?.(raw);
										return {
											...rest,
											...(states === undefined ? {} : { $outbound: states.get(row['id']) ?? {} }),
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
		})
	};
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
	return TenantDbService.typed({
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
	});
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
						const scheduled = setImmediate(() => resume(Effect.void));
						return Effect.sync(() => clearImmediate(scheduled));
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
	return {
		...TenantDbService.typed({
			...db,
			read: (statements: readonly Sql[]) =>
				statements.length === 0
					? Effect.succeed([])
					: Effect.request(new CoalescedRead({ statements }), resolver)
		}),
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
				const list = (r.many ? v : v === null || v === undefined ? [] : [v]) as {
					[k: string]: Json;
				}[];
				if (
					r.many &&
					r.page !== undefined &&
					r.page._tag === 'All' &&
					list.length > LIMITS.page.relationArm
				)
					throw tooLarge(
						`relation '${rel}' holds more than ${LIMITS.page.relationArm} rows; state a limit (rule 9)`
					);
				walk(r.select, list);
			}
	};
	walk(ir.select, rows);
}
/** Raw predicates and aggregates must not infer data withheld by a JSON projection. */
function guardProjectedOperands(manifest: EngineManifest, read: ReadIR): void {
	const protectedFields = (collection: string): readonly string[] =>
		(
			manifest.collections[collection]?.read as
				| {
						projection?: {
							fields: readonly string[];
						};
				  }
				| undefined
		)?.projection?.fields ?? [];
	const check = (collection: string, field: string) => {
		if (protectedFields(collection).includes(field))
			throw BoltError.make(
				'forbidden',
				'decode',
				'Projected JSON columns cannot be used as raw read operands.'
			);
	};
	const predicate = (collection: string, value: Pred): void => {
		if (value.t === 'and' || value.t === 'or') {
			for (const child of value.of) predicate(collection, child);
		} else if (value.t === 'not') predicate(collection, value.of);
		else if (value.t === 'one' || value.t === 'many') predicate(value.target, value.pred);
		else if ('field' in value) check(collection, value.field);
		else if (value.t === 'agg') check(value.target, value.of);
	};
	if ('where' in read && read.where !== undefined) predicate(read.collection, read.where);
	if ('order' in read && read.order !== undefined)
		for (const order of read.order) check(read.collection, order.field);
	if (read.kind === 'aggregate')
		for (const field of [
			...read.by.map((bucket) => bucket.field),
			...(read.sum ?? []),
			...(read.avg ?? []),
			...(read.min ?? []),
			...(read.max ?? [])
		])
			check(read.collection, field);
	const select = (selected: SelectIR): void => {
		for (const relation of Object.values(selected.relations)) {
			if (relation.where !== undefined) predicate(relation.target, relation.where);
			for (const order of relation.order ?? []) check(relation.target, order.field);
			select(relation.select);
		}
	};
	if ('select' in read && read.select !== undefined) select(read.select);
}

/** The host maps the Result decoder at its one wire edge. */
export function lowerRead(m: EngineManifest, member: string, args: readonly Json[]): ReadIR {
	return Result.match(irDecoder.decodeRead(catalogOf(m), member, args), {
		onSuccess: (value) => value,
		onFailure: (error) => {
			throw BoltError.make('invalid', 'decode', error.message, error);
		}
	});
}
const failedRead = (error: EngineError): import('../contracts.ts').CrossAnswer => ({
	ok: false,
	error: {
		kind: 'bolt',
		code: error instanceof BoltError ? error.code : 'internal',
		message: error instanceof Error ? error.message : String(error)
	}
});

/** No acquired Callables/Agents dependency: every query and projection gets a read-only guest bridge. */
export const ReadsLive = Layer.effect(
	Reads,
	Effect.gen(function* () {
		const manifest = yield* Manifest;
		const db = yield* TenantDbService;
		const guest = yield* Guest;
		const activation = yield* Activation;
		const ai = yield* Ai;
		const crypto = yield* Crypto.Crypto;
		const uuid = crypto.randomUUIDv4.pipe(
			Effect.mapError((error) =>
				BoltError.make('unavailable', 'facility', 'Secure random UUID generation failed.', error)
			)
		);
		type CallerReads = ReadEngine & {
			projectionBody: (
				collection: string,
				record: RowData,
				fields: readonly string[],
				reader: Reader,
				bindings: Bindings
			) => Effect.Effect<Json, EngineError>;
		};
		const held = yield* heldCollections(db);
		const make = (over: TenantDb, stack: ReadonlySet<string> = new Set()): CallerReads => {
			const invoke = Effect.fn('Bolt.readBody')(function* (
				kind: 'query' | 'projection' | 'similarity' | 'rerank',
				target: string,
				input: Json,
				reader: Reader,
				bindings: Bindings,
				fields?: readonly string[]
			) {
				const id = yield* uuid;
				const actor =
					reader.as === 'caller'
						? reader.authority.actor
						: { kind: 'system' as const, run: id, by: { platform: 'similarity' } };
				const outcome = yield* guest.invoke(
					{
						id,
						kind,
						target,
						input,
						ctx: {
							actor,
							now: bindings.now,
							today: bindings.today,
							tz: bindings.tz,
							seed: id,
							...(reader.as === 'caller'
								? { policies: reader.authority.policies, admin: reader.authority.admin }
								: {}),
							...(fields === undefined ? {} : { fields })
						},
						budget: {
							cpuMs: LIMITS.guestCpuMs,
							crossings: kind === 'similarity' || kind === 'rerank' ? 0 : LIMITS.crossings.sync,
							readBytes: LIMITS.readBytes
						}
					},
					{
						cross: (calls) =>
							Effect.forEach(
								calls,
								(call) => {
									if (call._tag !== 'read')
										return Effect.succeed(
											failedRead(
												BoltError.make('forbidden', 'deliver', 'Read projections are read-only.')
											)
										);
									return make(over, stack)
										.run([call.read], reader, { ...bindings, params: call.params })
										.pipe(
											Effect.map((values) => ({ ok: true as const, value: values[0] ?? null })),
											Effect.catch((error) => Effect.succeed(failedRead(error)))
										);
								},
								{ concurrency: 'unbounded' }
							)
					}
				);
				if (outcome.kind === 'failed') {
					if (kind === 'rerank' && outcome.error.code === 'missingBody') return null;
					return yield* Effect.fail(outcome.error);
				}
				if (outcome.kind === 'refused')
					return yield* Effect.fail(BoltError.make('forbidden', 'deliver', outcome.message));
				return outcome.output;
			});
			const history = (read: ReadIR, reader: Reader, bindings: Bindings) =>
				read.kind === 'history'
					? readHistory(over, manifest, read, reader, bindings)
					: Effect.fail(BoltError.make('invalid', 'decode', 'Expected a history read.'));
			const raw = readEngine({ db: over, manifest, delegate: { history } });
			const projection = readProjector({
				manifest,
				context: projectionContext(raw),
				invoke: (collection, record, fields, reader, bindings) => {
					const key = `${collection}/${String(record['id'])}`;
					if (stack.has(key))
						return Effect.fail(
							BoltError.make('forbidden', 'deliver', 'Recursive protected input reads are refused.')
						);
					const nested = new Set([...stack, key]);
					return make(over, nested).projectionBody(collection, record, fields, reader, bindings);
				}
			});
			const query = Effect.fn('Bolt.query')(function* (
				read: ReadIR,
				reader: Reader,
				bindings: Bindings
			) {
				if (read.kind !== 'query' || reader.as !== 'caller')
					return yield* Effect.fail(
						BoltError.make('unsupported', 'decode', 'a collection query is read as a caller')
					);
				return yield* readQuery(
					{
						manifest,
						guest,
						read: (batch, who, context) => make(over, stack).run(batch, who, context)
					},
					{
						collection: read.collection,
						query: read.query,
						input: read.input,
						authority: reader.authority,
						bindings,
						invocationId: yield* uuid,
						from: 'Client'
					}
				);
			});
			const engine = readEngine({
				db: over,
				manifest,
				held,
				projection,
				delegate: {
					history,
					query,
					transcript: (read, who) => agentRead(over, manifest, read, who),
					inbox: (read, who) => agentRead(over, manifest, read, who),
					conversations: (read, who) => agentRead(over, manifest, read, who)
				},
				similarity: (collection, name, bindings) => {
					if (manifest.collections[collection]?.similarity?.[name] === undefined) return undefined;
					const reader: Reader = { as: 'workspace' };
					const probe = (input: Json) =>
						invoke('similarity', `${collection}.${name}`, input, reader, bindings).pipe(
							Effect.flatMap((value) =>
								Schema.decodeUnknownEffect(
									Schema.Struct({
										field: Schema.String,
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
					const rerank = (input: Json, rows: readonly RowData[]) =>
						invoke('rerank', `${collection}.${name}`, [input, rows], reader, bindings).pipe(
							Effect.map((scores) =>
								rows.map((_, index) =>
									Array.isArray(scores) && typeof scores[index] === 'number'
										? scores[index]
										: undefined
								)
							)
						);
					return { probe, rerank };
				},
				embed: (collection, text) => {
					const semantic = manifest.models[collection]?.search?.semantic;
					if (semantic === undefined)
						return Effect.fail(
							BoltError.make(
								'invalid',
								'decode',
								`'${collection}' declares no search.semantic (rule 16)`
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
			return {
				...engine,
				projectionBody: (
					collection: string,
					record: RowData,
					fields: readonly string[],
					reader: Reader,
					bindings: Bindings
				) =>
					activation.projections.has(collection)
						? invoke('projection', collection, record, reader, bindings, fields)
						: Effect.fail(
								BoltError.make(
									'unavailable',
									'deliver',
									'Native read projection requires its compiled guest body.'
								)
							)
			};
		};
		return make(db);
	})
);
