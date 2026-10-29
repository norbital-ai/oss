// Bolt's reads beside the store's (`@norbital-ai/store`: read, get, aggregate, similar): history, a read request (one
// layer map over several roots), the transform's `after`, and the shell's agent and inbox reads; a declared (dynamic)
// read and a revision `get`; and the one decoder of a read call off the wire (D15).
import { Predicate, Result, Schema } from 'effect';
import {
	aggregate,
	catalogFor,
	exposureOf,
	get as storeGet,
	read as storeRead,
	semantic,
	similar,
	order,
	page,
	where,
	type Catalog,
	type ListRead,
	type Pred,
	type ReadIR as StoreReadIR,
	type RelSelectIR,
	type SelectIR
} from '@norbital-ai/store';
import { BoltError, storeSync } from './errors.ts';
import type { Json } from '../decl/values.ts';
import type { ExposureSpec } from '../decl/model.ts';
import {
	decodeReadRequest,
	planReadRequest,
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
	  }
	/** A read request: each root's read, answered together in one crossing, the answer keyed by root. */
	| { readonly kind: 'request'; readonly roots: readonly RequestRoot[] }
	/** The transform's `db.after`: stored rows overlaid with this batch. */
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
 * One root of a read request: its read (a page, an aggregate or a search), or with `asOf` the history fold of each
 * record its `where` pins, as a page of the `fields` asked for.
 */
export type RequestRoot =
	| { readonly root: string; readonly read: ReadIR }
	| {
			readonly root: string;
			readonly asOf: readonly Extract<ReadIR, { kind: 'history' }>[];
			readonly fields?: readonly string[] | undefined;
	  };

/** Each root's declared paths as `planReadRequest` checks them, from the catalog (the built-in layer's included). */
const declared = new WeakMap<Catalog, { readonly [root: string]: ExposureSpec }>();
const declarationsOf = (cat: Catalog) => {
	let out = declared.get(cat);
	if (out === undefined) {
		type Paths = { [path: string]: { fields: 'all' } };
		const paths: { [root: string]: Paths } = {};
		for (const root of cat.exposures.keys()) paths[root] = { [root]: { fields: 'all' } };
		for (const path of cat.layers.keys()) {
			const at = paths[path.split('.', 1)[0]!];
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
			Object.entries(paths).map(([root, read]) => [root, { read, outputs: named(root) }])
		);
		declared.set(cat, out);
	}
	return out;
};
/** The ids a root `where` pins (`{ id: { eq } }` or `{ id: { in } }`): what an `asOf` read folds. */
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
			const fields = tiers.flatMap((t) => (t.fields === undefined ? [] : [t.fields]));
			const limits = tiers.flatMap((t) => (t.limit === undefined ? [] : [t.limit]));
			const merged = tiers.reduce((a: LayerRequestJson, t) => ({ ...a, ...t }), {});
			const { where: _w, fields: _f, limit: _l, ...rest } = merged;
			return [
				path,
				{
					...rest,
					...(wheres.length === 0
						? {}
						: { where: wheres.length === 1 ? wheres[0]! : { and: wheres } }),
					...(fields.length === 0
						? {}
						: { fields: fields.reduce((a, b) => a.filter((f) => b.includes(f))) }),
					...(limits.length === 0 ? {} : { limit: Math.min(...limits) })
				}
			];
		})
	);
}
/**
 * A read request (`query({ ... })`) as one IR: decoded exactly, its paths checked against the declarations, each root
 * lowered with its named layers nested (a ref layer replaces its FK with the row or `null`, a many-layer lists or
 * measures its rows per parent row). Every list defaults to `READ_LIMIT`; authority is the reader's scope, per path.
 */
export function request(base: Catalog, json: Json | undefined): ReadIR {
	const decoded = decodeReadRequest(json);
	if (Result.isFailure(decoded)) throw invalid(decoded.failure);
	const plan = planReadRequest(decoded.success, declarationsOf(base));
	if (Result.isFailure(plan)) throw invalid(plan.failure);
	const roots = Object.entries(plan.success).map(([root, layers]): RequestRoot => {
		const top = layers[root]!;
		// the root's output: its fields and layers replace the default ones for this root's reads
		const cat = storeSync(catalogFor(base, root, top.output));
		const output = top.output === undefined ? {} : { output: top.output };
		const below = Object.keys(layers).filter((path) => path !== root);
		const only = (what: string) => {
			if (below.length > 0)
				throw invalid(
					`'${root}': ${what} names no layers (${below.join(', ')}); remove those keys from this read, or read the layers in a separate read without aggregate/asOf`
				);
		};
		const sub = (path: string, model: string): SelectIR => {
			const fields = layers[path]?.fields;
			const info = cat.models.get(model);
			const relations: { [rel: string]: RelSelectIR } = {};
			for (const child of below.filter((p) => p.slice(0, p.lastIndexOf('.')) === path)) {
				const rel = child.slice(child.lastIndexOf('.') + 1),
					layer = layers[child]!;
				const one = info?.one.get(rel),
					many = info?.many.get(rel);
				const target = one?.targets[0] ?? many?.child;
				if (target === undefined) throw invalid(`'${child}' is no relation of ${model}`);
				const filter = layerWhere(target, layer);
				if (one !== undefined) {
					if (layer.aggregate !== undefined)
						throw invalid(`'${child}' is a ref layer: it takes no aggregate`);
					relations[rel] = {
						target,
						many: false,
						select: sub(child, target),
						...(filter === undefined ? {} : { where: filter })
					};
					continue;
				}
				const limit = layer.limit ?? READ_LIMIT;
				const measured =
					layer.aggregate === undefined
						? undefined
						: storeSync(
								aggregate(cat, target, {
									...layer.aggregate,
									...(layer.aggregate.by === undefined ? {} : { limit })
								})
							);
				relations[rel] = {
					target,
					many: true,
					select: sub(child, target),
					page: storeSync(page({ limit })),
					...(filter === undefined ? {} : { where: filter }),
					...(layer.orderBy === undefined
						? {}
						: { order: storeSync(order(layer.orderBy, cat, target)) }),
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
		};
		const layerWhere = (model: string, layer: LayerRequestJson): Pred | undefined => {
			const w = layer.where === undefined ? undefined : storeSync(where(cat, model, layer.where));
			const text: Pred | undefined =
				typeof layer.search === 'string' && layer.search !== ''
					? { t: 'search', text: layer.search }
					: undefined;
			return w === undefined ? text : text === undefined ? w : { t: 'and', of: [w, text] };
		};
		if (top.asOf !== undefined) {
			only('an asOf read');
			const ids = pinned(top.where);
			if (ids === undefined)
				throw invalid(
					`'${root}': asOf folds the records its where pins: { id: { eq } } or { id: { in } }`
				);
			// ponytail: an asOf read folds pinned ids, root fields only; fold a whole page when a view needs it
			return {
				root,
				asOf: ids.map((id) => ({
					kind: 'history',
					model: root,
					...output,
					id,
					at: { _tag: 'Instant', instant: top.asOf! },
					full: true
				})),
				...(top.fields === undefined ? {} : { fields: top.fields })
			};
		}
		if (top.aggregate !== undefined) {
			only('an aggregate root');
			const { by } = top.aggregate;
			return {
				root,
				read: {
					...storeSync(
						aggregate(cat, root, {
							...top.aggregate,
							...(top.where === undefined ? {} : { where: top.where }),
							...(by === undefined ? {} : { limit: top.limit ?? READ_LIMIT }),
							...(by === undefined || top.after === undefined ? {} : { after: top.after })
						})
					),
					...output
				}
			};
		}
		const select = sub(root, root);
		const limit = top.limit ?? READ_LIMIT;
		if (Predicate.isObject(top.search)) {
			const entries = Object.entries(top.search);
			const [index, input] = entries[0] ?? [];
			if (entries.length !== 1 || index === undefined || input === undefined)
				throw invalid(`'${root}': search names one index: { <index>: input }`);
			const options = { ...(top.where === undefined ? {} : { where: top.where }), limit };
			const ir =
				index === 'semantic'
					? storeSync(semantic(cat, root, { ...options, to: input }))
					: storeSync(similar(cat, root, index, input, options));
			return { root, read: { ...ir, select, ...output } };
		}
		const listed: ListRead = {
			kind: 'read',
			model: root,
			...output,
			select,
			page: storeSync(page({ limit, ...(top.after === undefined ? {} : { after: top.after }) })),
			// a root page counts every row it matches (`total`) in the same statement
			total: true,
			...(top.where === undefined ? {} : { where: storeSync(where(cat, root, top.where)) }),
			...(top.orderBy === undefined ? {} : { order: storeSync(order(top.orderBy, cat, root)) }),
			...(typeof top.search === 'string' && top.search !== '' ? { search: top.search } : {})
		};
		return { root, read: listed };
	});
	return { kind: 'request', roots };
}

/** `read(model, { where?, select?, orderBy?, search? } & Paged)`: the engine's own page read (never off the wire). */
export function read(cat: Catalog, model: string, q: Obj): ReadIR {
	return storeSync(storeRead(cat, model, q));
}
/** `get(model, id, { select?, revision? })`; L-BOLT-181: a revision get is the history fold, not a table read. */
export function get(cat: Catalog, model: string, id: string, q: Obj = {}): ReadIR {
	if (q.revision === undefined) return storeSync(storeGet(cat, model, id, q));
	storeSync(exposureOf(cat, model));
	// ponytail: `select` does not narrow a revision get
	if (!Number.isInteger(q.revision)) throw invalid('revision is an integer');
	return {
		kind: 'history',
		model,
		id,
		at: { _tag: 'Revision', revision: q.revision as number },
		full: true
	};
}

/** The wire decoder retains each normalizer's exact message in its Result failure. */
class DecodeError extends Schema.TaggedError<DecodeError>()('DecodeError', {
	message: Schema.String,
	cause: Schema.optional(Schema.Defect())
}) {}
export const decode = <A>(read: () => A): Result.Result<A, DecodeError> =>
	Result.try({
		try: read,
		catch: (cause) =>
			new DecodeError({ message: cause instanceof Error ? cause.message : String(cause), cause })
	});
export function historyAt(at: unknown): NonNullable<Extract<ReadIR, { kind: 'history' }>['at']> {
	if (typeof at === 'string') return { _tag: 'Instant', instant: at };
	if (typeof at === 'number') return { _tag: 'Revision', revision: at };
	if (Predicate.isObject(at)) {
		if (typeof at.instant === 'string') return { _tag: 'Instant', instant: at.instant };
		if (typeof at.revision === 'number') return { _tag: 'Revision', revision: at.revision };
		if (typeof at.before === 'string') return { _tag: 'Before', before: at.before };
	}
	throw invalid('history takes { at: instant | revision | { before } }');
}
/** One boundary for read calls; helpers above normalize already-known parts of a read or grant. */
export function decodeRead(
	cat: Catalog,
	member: string,
	args: readonly Json[]
): Result.Result<ReadIR, DecodeError> {
	return decode(() => {
		const model = String(args[0]),
			[, a, b, d] = args;
		const object = (value: Json | undefined): Obj => (Predicate.isObject(value) ? value : {});
		switch (member.replace(/^db\./, '')) {
			case 'read':
				return read(cat, model, object(a));
			case 'get':
				return get(cat, model, String(a), object(b));
			case 'aggregate':
				return storeSync(aggregate(cat, model, object(a)));
			case 'similar':
				return storeSync(
					a !== null && typeof a === 'object'
						? semantic(cat, model, object(a))
						: similar(cat, model, String(a), b ?? null, object(d))
				);
			case 'after': {
				const query = b === undefined ? undefined : read(cat, model, { ...object(b), where: a });
				return {
					kind: 'after',
					model,
					where: storeSync(where(cat, model, a)),
					...(query?.kind === 'read' ? { query } : {})
				};
			}
			case 'history': {
				// the third argument is `{ at?, output? }`, or (from older pages) the `at` value itself
				const options: { readonly at?: Json | undefined; readonly output?: Json | undefined } =
					Predicate.isObject(b) && ('at' in b || 'output' in b) ? b : { at: b };
				return {
					kind: 'history',
					model,
					id: String(a),
					...(options.at == null ? {} : { at: historyAt(options.at) }),
					...(typeof options.output === 'string' ? { output: options.output } : {})
				};
			}
			case 'request':
				return request(cat, args[0]);
			default:
				throw invalid(`'${member}' is not a read`);
		}
	});
}
