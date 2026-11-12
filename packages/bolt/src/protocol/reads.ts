// Bolt's reads beside the store's (`@norbital-ai/store`: read, get, aggregate, similar): history, a read request (one
// layer map over several roots), the transform's `after`, and the shell's agent and inbox reads; a declared (dynamic)
// read and a revision `get`; and the one decoder of a read call off the wire (D15).
import { Effect, Predicate, Result, Schema } from 'effect';
import {
	aggregate,
	catalog_for,
	exposure_of,
	get as storeGet,
	read as storeRead,
	semantic,
	similar,
	order,
	page,
	where,
	type Catalog,
	type ListRead,
	type StoreError,
	type Pred,
	type ReadIR as StoreReadIR,
	type RelSelectIR,
	type SelectIR
} from '@norbital-ai/store';
import { BoltError, from_store } from './errors.ts';
import type { Json } from '../decl/values.ts';
import type { ExposureSpec } from '../decl/model.ts';
import {
	decode_read_request,
	plan_read_request,
	READ_LIMIT,
	type LayerRequestJson
} from './read-request.ts';

type Obj = { readonly [k: string]: unknown };
const invalid = (message: string) => BoltError.make('invalid', 'decode', message);

/** `{ instant } | { revision } | { before }` of `history` (rule 17). */
type HistoryAt =
	| { readonly _tag: 'Instant'; readonly instant: string }
	| { readonly _tag: 'Revision'; readonly revision: number }
	| { readonly _tag: 'Before'; readonly before: string };
/** Every read a crossing carries (wire discriminant `kind`, D15): the store's, and Bolt's own. */
export type ReadIR =
	| StoreReadIR
	| {
			readonly kind: 'history';
			readonly model: string;
			/** The output whose root fields each revision shows (`default` when absent). */
			readonly output?: string | undefined;
			readonly id: string;
			readonly at?: HistoryAt | undefined;
			readonly full?: true | undefined;
			readonly view?: true | undefined;
	  }
	/** A read request: each root's read, answered together in one crossing, the answer keyed by root. */
	| { readonly kind: 'request'; readonly roots: readonly RequestRoot[] }
	/** The transform's `query.after`: stored rows overlaid with this batch. */
	| {
			readonly kind: 'after';
			readonly model: string;
			readonly where: Pred;
			readonly query?: ListRead | undefined;
	  }
	/** The agent panel's messages of one conversation in `seq` order. */
	| {
			readonly kind: 'transcript';
			readonly model: 'sys_message';
			readonly conversation: string;
			readonly thread: boolean;
			/** An automation run's inference transcript: read-only. */
			readonly automation?: true | undefined;
			readonly from?: number | undefined;
	  }
	/** The shell inbox: own notices, with an optional caller-filtered open request list. */
	| {
			readonly kind: 'inbox';
			readonly model: 'sys_notification';
			readonly member: string;
			readonly requests?: true | undefined;
	  }
	/** The agent panel's conversation list: one member's own conversations, most recently active first. */
	| {
			readonly kind: 'conversations';
			readonly model: 'sys_conversation';
			readonly member: string;
			/** Native row fetch uses the same visibility and projection as the list. */
			readonly id?: string;
	  }
	/** Automation runs as the caller may see them (rule 56), newest first: one automation's, or one run by id. */
	| {
			readonly kind: 'runs';
			readonly model: 'sys_run';
			readonly limit: number;
			readonly automation?: string | undefined;
			readonly id?: string | undefined;
			/** Without each run's input, result and attempts: a list's columns. */
			readonly brief?: true | undefined;
	  };

/**
 * One root of a read request: its read (a page, an aggregate or a search), or with `as_of` the history fold of each
 * record its `where` pins, as a page of the `fields` asked for.
 */
export type RequestRoot =
	| { readonly root: string; readonly read: ReadIR }
	| {
			readonly root: string;
			readonly as_of: readonly Extract<ReadIR, { kind: 'history' }>[];
			readonly fields?: readonly string[] | undefined;
	  };

/** Each root's declared paths as `plan_read_request` checks them, from the catalog (the built-in layer's included). */
const declared = new WeakMap<Catalog, { readonly [root: string]: ExposureSpec }>();
const declarationsOf = (cat: Catalog) => {
	let out = declared.get(cat);
	if (out === undefined) {
		type Paths = { [path: string]: { fields: 'all' } };
		const paths: { [root: string]: Paths } = {};
		for (const root of cat.exposures.keys()) paths[root] = { [root]: { fields: 'all' } };
		for (const path of cat.layers.keys()) {
			const [root] = path.split('.', 1);
			const at = root === undefined ? undefined : paths[root];
			if (at !== undefined) at[path] = { fields: 'all' };
		}
		const named = (root: string): { [output: string]: Paths } =>
			Object.fromEntries(
				[...(cat.outputs.get(root) ?? [])].map(([output, info]) => [
					output,
					Object.fromEntries(
						[root, ...info.layers.keys()].map((path) => [path, { fields: 'all' as const }])
					)
				])
			);
		out = Object.fromEntries(
			Object.entries(paths).map(([root, read]) => [
				root,
				{ outputs: { default: read, ...named(root) } }
			])
		);
		declared.set(cat, out);
	}
	return out;
};
/** The ids a root `where` pins (`{ id: { eq } }` or `{ id: { in } }`): what an `as_of` read folds. */
function pinned(w: Json | undefined): readonly string[] | undefined {
	if (!Predicate.isObject(w) || Object.keys(w).length !== 1 || !Predicate.isObject(w['id']))
		return undefined;
	const { eq, in: list } = w['id'];
	if (typeof eq === 'string') return [eq];
	return Array.isArray(list) && list.every((x) => typeof x === 'string') ? list : undefined;
}
type RequestJson = { readonly [path: string]: LayerRequestJson };
/**
 * A read request scoped in three tiers, per path: the policy's (or author's) scope, a prefilter, then the caller's.
 * `where`s AND, `fields` intersect, `limit` is the smallest; any other option the later tier states wins, so no tier
 * widens one before it. ui's author scope composes the same way (`@norbital-ai/ui` `compose`).
 */
export function compose(
	policy: RequestJson,
	prefilter: RequestJson,
	user: RequestJson
): RequestJson {
	const paths = new Set([...Object.keys(policy), ...Object.keys(prefilter), ...Object.keys(user)]);
	return Object.fromEntries(
		[...paths].map((path): [string, LayerRequestJson] => {
			const tiers = [policy[path], prefilter[path], user[path]].flatMap((t) =>
				t === undefined ? [] : [t]
			);
			const wheres = tiers.flatMap((t) => (t.where === undefined ? [] : [t.where]));
			const [firstWhere] = wheres;
			const fields = tiers.flatMap((t) => (t.fields === undefined ? [] : [t.fields]));
			const limits = tiers.flatMap((t) => (t.limit === undefined ? [] : [t.limit]));
			const merged = tiers.reduce((a: LayerRequestJson, t) => ({ ...a, ...t }), {});
			const { where: _w, fields: _f, limit: _l, ...rest } = merged;
			return [
				path,
				{
					...rest,
					...(firstWhere === undefined
						? {}
						: { where: wheres.length === 1 ? firstWhere : { and: wheres } }),
					...(fields.length === 0
						? {}
						: { fields: fields.reduce((a, b) => a.filter((f) => b.includes(f))) }),
					...(limits.length === 0 ? {} : { limit: Math.min(...limits) })
				}
			];
		})
	);
}
/** A store normalizer's refusal as Bolt's. */
const store = <A>(effect: Effect.Effect<A, StoreError>): Effect.Effect<A, BoltError> =>
	Effect.mapError(effect, from_store);
/**
 * A read request (`query({ ... })`) as one IR: decoded exactly, its paths checked against the declarations, each root
 * lowered with its named layers nested (a ref layer replaces its FK with the row or `null`, a many-layer lists or
 * measures its rows per parent row). Every list defaults to `READ_LIMIT`; authority is the reader's scope, per path.
 */
export const request = Effect.fn('Bolt.read.request')(function* (
	base: Catalog,
	json: Json | undefined
): Effect.fn.Return<ReadIR, BoltError> {
	const decoded = decode_read_request(json);
	if (Result.isFailure(decoded)) return yield* invalid(decoded.failure);
	const plan = plan_read_request(decoded.success, declarationsOf(base));
	if (Result.isFailure(plan)) return yield* invalid(plan.failure);
	const roots = yield* Effect.forEach(Object.entries(plan.success), ([root, layers]) =>
		Effect.gen(function* (): Effect.fn.Return<RequestRoot, BoltError> {
			const top = layers[root];
			if (top === undefined) return yield* invalid(`'${root}' has no root read layer`);
			// the root's output: its fields and layers replace the default ones for this root's reads
			const cat = yield* store(catalog_for(base, root, top.output));
			const output = top.output === undefined ? {} : { output: top.output };
			const below = Object.keys(layers).filter((path) => path !== root);
			const only = (what: string) =>
				below.length > 0
					? Effect.fail(invalid(
							`'${root}': ${what} names no layers (${below.join(', ')}); remove those keys from this read, or read the layers in a separate read without aggregate/as_of`
						))
					: Effect.void;
			const layerWhere = Effect.fnUntraced(function* (
				model: string,
				layer: LayerRequestJson
			): Effect.fn.Return<Pred | undefined, BoltError> {
				const w = layer.where === undefined ? undefined : yield* store(where(cat, model, layer.where));
				const text: Pred | undefined =
					typeof layer.search === 'string' && layer.search !== ''
						? { t: 'search', text: layer.search }
						: undefined;
				return w === undefined ? text : text === undefined ? w : { t: 'and', of: [w, text] };
			});
			const sub = (path: string, model: string): Effect.Effect<SelectIR, BoltError> =>
				Effect.gen(function* (): Effect.fn.Return<SelectIR, BoltError> {
					const fields = layers[path]?.fields;
					const info = cat.models.get(model);
					const relations: { [rel: string]: RelSelectIR } = {};
					for (const child of below.filter((p) => p.slice(0, p.lastIndexOf('.')) === path)) {
						const rel = child.slice(child.lastIndexOf('.') + 1), layer = layers[child];
						if (layer === undefined) return yield* invalid(`'${child}' has no read layer`);
						const one = info?.one.get(rel),
							many = info?.many.get(rel);
						const target = one?.targets[0] ?? many?.child;
						if (target === undefined) return yield* invalid(`'${child}' is no relation of ${model}`);
						const filter = yield* layerWhere(target, layer);
						if (one !== undefined) {
							if (layer.aggregate !== undefined)
								return yield* invalid(`'${child}' is a ref layer: it takes no aggregate`);
							relations[rel] = {
								target,
								many: false,
								select: yield* sub(child, target),
								...(filter === undefined ? {} : { where: filter })
							};
							continue;
						}
						const limit = layer.limit ?? READ_LIMIT;
						const measured =
							layer.aggregate === undefined
								? undefined
								: yield* store(
										aggregate(cat, target, {
											...layer.aggregate,
											...(layer.aggregate.by === undefined ? {} : { limit })
										})
									);
						relations[rel] = {
							target,
							many: true,
							select: yield* sub(child, target),
							page: yield* store(page({ limit })),
							...(filter === undefined ? {} : { where: filter }),
							...(layer.order_by === undefined
								? {}
								: { order: yield* store(order(layer.order_by, cat, target)) }),
							...(measured?.kind === 'aggregate'
								? {
										aggregate: {
											by: measured.by,
											...(measured.count === undefined ? {} : { count: measured.count }),
											...(measured.sum === undefined ? {} : { sum: measured.sum }),
											...(measured.avg === undefined ? {} : { avg: measured.avg }),
											...(measured.min === undefined ? {} : { min: measured.min }),
											...(measured.max === undefined ? {} : { max: measured.max })
										}
									}
								: {})
						};
					}
					// `{}` reads every field the layer exposes (decision 8)
					return fields === undefined
						? { fields: null, whole: true, relations }
						: { fields: ['id', ...fields], relations };
				});
			const asOf = top.as_of;
			if (asOf !== undefined) {
				yield* only('an as_of read');
				const ids = pinned(top.where);
				if (ids === undefined)
					return yield* invalid(
						`'${root}': as_of folds the records its where pins: { id: { eq } } or { id: { in } }`
					);
				// ponytail: an as_of read folds pinned ids, root fields only; fold a whole page when a view needs it
				return {
					root,
					as_of: ids.map((id) => ({
						kind: 'history',
						model: root,
						...output,
						id,
						at: { _tag: 'Instant', instant: asOf },
						full: true
					})),
					...(top.fields === undefined ? {} : { fields: top.fields })
				};
			}
			if (top.aggregate !== undefined) {
				yield* only('an aggregate root');
				const { by } = top.aggregate;
				return {
					root,
					read: {
						...(yield* store(
							aggregate(cat, root, {
								...top.aggregate,
								...(top.where === undefined ? {} : { where: top.where }),
								...(by === undefined ? {} : { limit: top.limit ?? READ_LIMIT }),
								...(by === undefined || top.after === undefined ? {} : { after: top.after })
							})
						)),
						...output
					}
				};
			}
			const select = yield* sub(root, root);
			const limit = top.limit ?? READ_LIMIT;
			if (Predicate.isObject(top.search)) {
				const entries = Object.entries(top.search);
				const [index, input] = entries[0] ?? [];
				if (entries.length !== 1 || index === undefined || input === undefined)
					return yield* invalid(`'${root}': search names one index: { <index>: input }`);
				const options = { ...(top.where === undefined ? {} : { where: top.where }), limit };
				const ir = yield* store(
					index === 'semantic'
						? semantic(cat, root, { ...options, to: input })
						: similar(cat, root, index, input, options)
				);
				return { root, read: { ...ir, select, ...output } };
			}
			const listed: ListRead = {
				kind: 'read',
				model: root,
				...output,
				select,
				page: yield* store(page({ limit, ...(top.after === undefined ? {} : { after: top.after }) })),
				// a root page counts every row it matches (`total`) in the same statement
				total: true,
				...(top.where === undefined ? {} : { where: yield* store(where(cat, root, top.where)) }),
				...(top.order_by === undefined ? {} : { order: yield* store(order(top.order_by, cat, root)) }),
				...(typeof top.search === 'string' && top.search !== '' ? { search: top.search } : {})
			};
			return { root, read: listed };
		})
	);
	return { kind: 'request', roots };
});

/** `read(model, { where?, select?, order_by?, search? } & Paged)`: the engine's own page read (never off the wire). */
export const read = (cat: Catalog, model: string, q: Obj): Effect.Effect<ReadIR, BoltError> =>
	store(storeRead(cat, model, q));
/** `get(model, id, { select?, revision? })`; L-BOLT-181: a revision get is the history fold, not a table read. */
export const get = Effect.fn('Bolt.read.get')(function* (
	cat: Catalog,
	model: string,
	id: string,
	q: Obj = {}
): Effect.fn.Return<ReadIR, BoltError> {
	if (q.revision === undefined) return yield* store(storeGet(cat, model, id, q));
	yield* store(exposure_of(cat, model));
	// ponytail: `select` does not narrow a revision get
	if (typeof q.revision !== 'number' || !Number.isInteger(q.revision)) return yield* invalid('revision is an integer');
	return {
		kind: 'history',
		model,
		id,
		at: { _tag: 'Revision', revision: q.revision },
		full: true
	};
});

const HistoryPoint = Schema.Union([
	Schema.Struct({ instant: Schema.String }),
	Schema.Struct({ revision: Schema.Number }),
	Schema.Struct({ before: Schema.String })
]);
const historyOptions = Schema.decodeUnknownEffect(Schema.Struct({
	at: Schema.optionalKey(HistoryPoint),
	output: Schema.optionalKey(Schema.String),
	view: Schema.optionalKey(Schema.Literal(true))
}), { onExcessProperty: 'error' });
export function history_at(at: typeof HistoryPoint.Type): NonNullable<Extract<ReadIR, { kind: 'history' }>['at']> {
	if ('instant' in at) return { _tag: 'Instant', instant: at.instant };
	if ('revision' in at) return { _tag: 'Revision', revision: at.revision };
	return { _tag: 'Before', before: at.before };
}
/** One boundary for read calls; helpers above normalize already-known parts of a read or grant. */
export const decodeRead = Effect.fn('Bolt.read.decode')(function* (
	cat: Catalog,
	member: string,
	args: readonly Json[]
): Effect.fn.Return<ReadIR, BoltError> {
		const model = String(args[0]),
			[, a, b, d] = args;
		const object = (value: Json | undefined): Obj => (Predicate.isObject(value) ? value : {});
		switch (member.replace(/^db\./, '')) {
			case 'read':
				return yield* read(cat, model, object(a));
			case 'get':
				return yield* get(cat, model, String(a), object(b));
			case 'aggregate': {
				// `output` names the reader's view, as a request root's does
				const { output, ...options } = object(a);
				return typeof output === 'string'
					? {
							...(yield* store(aggregate(yield* store(catalog_for(cat, model, output)), model, options))),
							output
						}
					: yield* store(aggregate(cat, model, options));
			}
			case 'similar':
				return yield* store(
					a !== null && typeof a === 'object'
						? semantic(cat, model, object(a))
						: similar(cat, model, String(a), b ?? null, object(d))
				);
			case 'after': {
				const query = b === undefined ? undefined : yield* read(cat, model, { ...object(b), where: a });
				return {
					kind: 'after',
					model,
					where: yield* store(where(cat, model, a)),
					...(query?.kind === 'read' ? { query } : {})
				};
			}
			case 'history': {
				const options = yield* historyOptions(b === undefined ? {} : b).pipe(
					Effect.mapError((error) => invalid(error.message))
				);
				return {
					kind: 'history',
					model,
					id: String(a),
					...(options.view === true ? { view: true } : {}),
					...(options.at == null ? {} : { at: history_at(options.at) }),
					...(typeof options.output === 'string' ? { output: options.output } : {})
				};
			}
			case 'request':
				return yield* request(cat, args[0]);
			default:
				return yield* invalid(`'${member}' is not a read`);
		}
});
