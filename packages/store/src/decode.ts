// Read literals → the read IR. This is decode: an unknown key or operator fails `invalid` with its path, never a
// silently ignored filter. Field names are checked against the model; exposure is the compiler's (it knows who reads).
// Browser-safe.
import { Array as EffectArray, Effect, Predicate, Result } from 'effect';
import { KIND } from '@norbital-ai/std/kind';
import { Decimal } from '@norbital-ai/std/decimal';
import { encodeWire } from '@norbital-ai/std/wire';
import { ELEMENT } from './ir.ts';
import type {
	Arg,
	Bucket,
	Cmp,
	PathTest,
	Operand,
	Order,
	PageIR,
	Pred,
	ReadIR,
	RelSelectIR,
	SelectIR
} from './ir.ts';
import { STORE_LIMITS } from './limits.ts';
import { StoreError } from './errors.ts';
import type { Json } from './values.ts';
import type { Catalog, FieldInfo, KindSpec, ModelInfo } from './catalog.ts';
import { SEMANTIC, SYSTEM_COLUMNS, collectionOf, family, fieldInfo } from './catalog.ts';

/** A value position's operand as a literal writes it; which ones a position admits depends on the value's kind. */
export type WireOperand =
	| { field: string }
	| { param: string }
	| {
			actor:
				| 'id'
				| 'email'
				| 'phone'
				| 'teams'
				| 'teamTree'
				| 'party'
				| 'visitor'
				| 'instance'
				| { scopes: string };
	  };
type Obj = { readonly [k: string]: unknown };
const invalid = (message: string) => Effect.fail(StoreError.of('invalid', 'decode', message));
const WHERE_MAX_DEPTH = STORE_LIMITS.where.depth,
	WHERE_MAX_LIST = STORE_LIMITS.where.list,
	ORDER_MAX_KEYS = STORE_LIMITS.orderKeys;
const OPERAND_KEYS = ['field', 'param', 'actor'];
export const isOperand = (v: unknown): v is WireOperand => {
	if (!Predicate.isObject(v)) return false;
	const ks = Object.keys(v);
	return ks.length === 1 && OPERAND_KEYS.includes(ks[0] ?? '');
};
/** A read compares against values: its caller materializes time before decoding. */
const CLOCK_KEYS = ['today', 'now', 'startOf'];
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `{ member, field }`: a keyed read's reference to an earlier member's values (`MemberRef`). */
const isMemberRef = (v: unknown): v is { readonly member: string; readonly field: string } =>
	Predicate.isObject(v) &&
	Object.keys(v).length === 2 &&
	typeof v.member === 'string' &&
	/^[A-Za-z0-9_:]+$/.test(v.member) &&
	typeof v.field === 'string' &&
	v.field.split('.').every((part) => NAME.test(part));
const isCmp = (op: string): op is Cmp => ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(op);
const ORDERED = new Set(
	Object.entries(KIND)
		.filter(([, entry]) => entry.traits.ordered)
		.map(([kind]) => kind)
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEC = /^-?\d+(\.\d+)?$/;
/** `$search` / `$similar` text, and `$similar`'s nearest rows: 20 unless it says, at most 200. */
const SEARCH_MAX_TEXT = 500,
	SIMILAR_TOP = 20,
	SIMILAR_MAX_TOP = 200;

const model = (cat: Catalog, name: string): Effect.Effect<ModelInfo, StoreError> => {
	const m = cat.models.get(name);
	return m === undefined ? invalid(`unknown model '${name}'`) : Effect.succeed(m);
};
const and = (of: readonly Pred[]): Pred =>
	of.length === 1 && of[0] !== undefined ? of[0] : { t: 'and', of };
/** An object's defined entries: `{ eq: undefined }` is `{}` on the wire, so it is `{}` here too. */
const entries = (o: Obj) => Object.entries(o).filter(([, v]) => v !== undefined);
/** A node that must say something (`{ status: {} }`, `not: {}`) is refused with its path. */
const nonEmpty = (
	o: unknown,
	path: string,
	what: string
): Effect.Effect<[string, unknown][], StoreError> => {
	if (!Predicate.isObject(o)) return invalid(`${path}: ${what}`);
	const es = entries(o);
	return es.length === 0 ? invalid(`${path}: empty; ${what}`) : Effect.succeed(es);
};
const list = (v: unknown, path: string): Effect.Effect<readonly unknown[], StoreError> =>
	!EffectArray.isArray(v)
		? invalid(`${path}: takes a list`)
		: v.length > WHERE_MAX_LIST
			? invalid(`${path}: more than ${WHERE_MAX_LIST} items`)
			: Effect.succeed(v);
const validDate = (v: unknown): v is string =>
	typeof v === 'string' &&
	DATE.test(v) &&
	!Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
	new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

/** The literal a value of `f`'s kind takes, or what it should have been; `null` is refused (`isNull` says it). */
function literalOf(f: FieldInfo, v: unknown): { readonly ok: Json } | string {
	const k = f.kind;
	if (v === null || v === undefined) return 'a value (use isNull for null)';
	if (k === 'int' || k === 'count')
		return typeof v === 'number' && Number.isSafeInteger(v) ? { ok: v } : 'an integer';
	if (k === 'decimal' || k === 'money' || k === 'sum' || k === 'number') {
		if (v instanceof Decimal) return { ok: v.toJSON() };
		if (typeof v === 'number' && Number.isFinite(v)) return { ok: v };
		if (typeof v === 'string' && DEC.test(v)) return { ok: v };
		if (
			Predicate.isObject(v) &&
			Object.keys(v).length === 1 &&
			typeof v.$dec === 'string' &&
			DEC.test(v.$dec)
		)
			return { ok: { $dec: v.$dec } };
		return 'a decimal';
	}
	if (k === 'duration')
		return (typeof v === 'number' && Number.isSafeInteger(v)) ||
			(typeof v === 'string' && /^\d+(s|min|h|d)$/.test(v))
			? { ok: v }
			: 'a duration';
	if (k === 'bool') return typeof v === 'boolean' ? { ok: v } : 'a boolean';
	if (k === 'date') return validDate(v) ? { ok: v } : 'an ISO date';
	if (k === 'instant')
		return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))
			? { ok: v }
			: 'an ISO instant';
	if (k === 'time')
		return typeof v === 'string' && /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v) ? { ok: v } : 'a time';
	if (k === 'id' && f.pg === 'int8')
		return typeof v === 'number' && Number.isSafeInteger(v) ? { ok: v } : 'an integer id';
	if (k === 'id')
		return typeof v === 'string' && (f.pg !== 'uuid' || UUID.test(v)) ? { ok: v } : 'an id';
	if (typeof v !== 'string') return 'text';
	if (f.values !== undefined && !f.values.includes(v)) return `one of ${f.values.join(', ')}`;
	return { ok: v };
}
/** A literal of `f`'s kind at `path`. */
const literal = (f: FieldInfo, v: unknown, path: string): Effect.Effect<Json, StoreError> => {
	const r = literalOf(f, v);
	return typeof r === 'string' ? invalid(`${path}: '${f.name}' takes ${r}`) : Effect.succeed(r.ok);
};
/** Normalize the authored wire shape once; interiors match one discriminator. */
export function taggedOperand(o: WireOperand): Operand {
	if ('field' in o) return { _tag: 'Field', field: o.field };
	if ('param' in o) return { _tag: 'Param', name: o.param };
	return { _tag: 'Actor', of: o.actor };
}

/** Whether a position of `f` (read as `kind`) admits operand `o`, in a list position or a value one. */
function admits(
	info: ModelInfo,
	f: FieldInfo,
	o: WireOperand,
	list: boolean,
	kind: string
): boolean {
	if ('param' in o) return typeof o.param === 'string';
	if (list) {
		if (!('actor' in o)) return false;
		const a: unknown = o.actor;
		return a === 'teams' || a === 'teamTree'
			? f.team === true
			: f.kind === 'id' &&
					Predicate.isObject(a) &&
					typeof a.scopes === 'string' &&
					Object.keys(a).length === 1;
	}
	if ('field' in o) {
		const g =
			typeof o.field === 'string' && !o.field.includes('.') ? info.fields.get(o.field) : undefined;
		return g !== undefined && family(g) === family({ ...f, kind });
	}
	const a = o.actor;
	// an actor id is text too: ported grants compare `{ actor: 'id' }` with a text column
	return a === 'email'
		? f.email === true
		: a === 'phone'
			? f.phone === true
			: a === 'id'
				? f.of === 'sys_user' || f.kind === 'text'
				: a === 'party'
					? f.kind === 'id'
					: a === 'visitor'
						? f.kind === 'text'
						: a === 'instance'
							? f.of === 'sys_integration'
							: false;
}
/** An operand only where its kind admits it (mirrors `Dyn`/`DynList` of the where types). */
const operand = (
	info: ModelInfo,
	f: FieldInfo,
	o: WireOperand,
	path: string,
	list: boolean,
	kind = f.kind
): Effect.Effect<Operand, StoreError> =>
	admits(info, f, o, list, kind)
		? Effect.succeed(taggedOperand(o))
		: invalid(`${path}: '${f.name}' does not take ${JSON.stringify(o)}`);
const val = (
	info: ModelInfo,
	f: FieldInfo,
	v: unknown,
	path: string,
	kind?: string
): Effect.Effect<Arg, StoreError> => {
	if (Predicate.isObject(v) && Object.keys(v).some((k) => CLOCK_KEYS.includes(k)))
		return invalid(
			`${path}: a read takes a value, not ${JSON.stringify(v)}; materialize time before reading`
		);
	return isOperand(v)
		? operand(info, f, v, path, false, kind)
		: Effect.map(literal(kind === undefined ? f : { ...f, kind }, v, path), (value): Arg => ({
				_tag: 'Lit',
				value
			}));
};
/** Tagged operands embedded in a period literal keep their validated discriminator. */
export const isTaggedOperand = (value: unknown): value is Operand => {
	if (!Predicate.isObject(value)) return false;
	switch (value._tag) {
		case 'Field':
			return typeof value.field === 'string';
		case 'Param':
			return typeof value.name === 'string';
		case 'Actor':
			return typeof value.of === 'string'
				? ['id', 'email', 'phone', 'teams', 'teamTree', 'party', 'visitor', 'instance'].includes(
						value.of
					)
				: Predicate.isObject(value.of) &&
						Object.keys(value.of).length === 1 &&
						typeof value.of.scopes === 'string';
		default:
			return false;
	}
};
export const argumentList = (value: Extract<Pred, { t: 'in' }>['args']): value is readonly Json[] =>
	EffectArray.isArray(value);

const point = (v: unknown): v is { readonly lat: number; readonly lng: number } =>
	Predicate.isObject(v) &&
	typeof v.lat === 'number' &&
	typeof v.lng === 'number' &&
	Number.isFinite(v.lat) &&
	Number.isFinite(v.lng);
const periodArg = Effect.fnUntraced(function* (
	info: ModelInfo,
	f: FieldInfo,
	v: unknown,
	path: string
) {
	if (isOperand(v) && 'param' in v) return yield* operand(info, f, v, path, false);
	const lo = f.periodOf === 'date' ? 'from' : 'start',
		hi = f.periodOf === 'date' ? 'to' : 'end';
	if (!Predicate.isObject(v) || !(lo in v) || !(hi in v) || Object.keys(v).length !== 2)
		return yield* invalid(`${path}: takes a period { ${lo}, ${hi} }`);
	const end = Effect.fnUntraced(function* (x: unknown, p: string) {
		const a = yield* val(info, f, x, p, f.periodOf);
		return a._tag === 'Lit' ? a.value : encodeWire(a);
	});
	const a = yield* end(v[lo], `${path}.${lo}`);
	const b = v[hi] === null ? null : yield* end(v[hi], `${path}.${hi}`);
	if (
		typeof a === 'string' &&
		typeof b === 'string' &&
		(f.periodOf === 'date' ? a > b : Date.parse(a) > Date.parse(b))
	)
		return yield* invalid(`${path}: '${lo}' is after '${hi}'`);
	const arg: Arg = { _tag: 'Lit', value: { [lo]: a, [hi]: b } };
	return arg;
});

/** `{ field: value }` is `eq` (a list `in`, null `isNull`); `{ $dec }` is the wire's only tagged literal. */
const shorthand = (f: FieldInfo, ops: unknown): unknown =>
	f.many ||
	(Predicate.isObject(ops) && !(Object.keys(ops).length === 1 && Object.hasOwn(ops, '$dec')))
		? ops
		: ops === null
			? { isNull: true }
			: EffectArray.isArray(ops)
				? { in: ops }
				: { eq: ops };

const boolean = (v: unknown, at: string): Effect.Effect<boolean, StoreError> =>
	typeof v === 'boolean' ? Effect.succeed(v) : invalid(`${at}: takes a boolean`);
const fieldOp = Effect.fnUntraced(function* (
	info: ModelInfo,
	f: FieldInfo,
	op: string,
	v: unknown,
	at: string
) {
	if (op === 'isNull' && !f.many) {
		const pred: Pred = { t: 'null', field: f.name, is: yield* boolean(v, at) };
		return pred;
	}
	if (f.many) {
		if (op === 'isEmpty')
			return { t: 'list', field: f.name, op, arg: yield* boolean(v, at) } satisfies Pred;
		if (op === 'has')
			return { t: 'list', field: f.name, op, arg: yield* literal(f, v, at) } satisfies Pred;
		if (op === 'hasAny' || op === 'hasAll') {
			const xs = yield* list(v, at);
			const arg = yield* Effect.forEach(xs, (x, i) => literal(f, x, `${at}[${i}]`));
			return { t: 'list', field: f.name, op, arg } satisfies Pred;
		}
	} else if (f.kind === 'period') {
		if (op === 'contains')
			return {
				t: 'period',
				field: f.name,
				op,
				arg: yield* val(info, f, v, at, f.periodOf)
			} satisfies Pred;
		if (op === 'overlaps' || op === 'within')
			return {
				t: 'period',
				field: f.name,
				op,
				arg: yield* periodArg(info, f, v, at)
			} satisfies Pred;
	} else if (f.kind === 'point') {
		if (op === 'near') {
			if (
				!EffectArray.isArray(v) ||
				v.length !== 2 ||
				!point(v[0]) ||
				typeof v[1] !== 'number' ||
				!Number.isFinite(v[1]) ||
				v[1] < 0
			)
				return yield* invalid(`${at}: takes [point, metres ≥ 0]`);
			return { t: 'geo', field: f.name, near: [v[0], v[1]] } satisfies Pred;
		}
		if (op === 'within') {
			if (Predicate.isObject(v) && Object.keys(v).length === 1) {
				if (
					EffectArray.isArray(v.bbox) &&
					v.bbox.length === 2 &&
					point(v.bbox[0]) &&
					point(v.bbox[1])
				)
					return {
						t: 'geo',
						field: f.name,
						within: { bbox: [v.bbox[0], v.bbox[1]] }
					} satisfies Pred;
				if (
					EffectArray.isArray(v.polygon) &&
					v.polygon.length >= 3 &&
					v.polygon.length <= WHERE_MAX_LIST &&
					v.polygon.every(point)
				)
					return { t: 'geo', field: f.name, within: { polygon: v.polygon } } satisfies Pred;
			}
			return yield* invalid(`${at}: takes { bbox: [point, point] } or { polygon: ≥ 3 points }`);
		}
	} else if (['json', 'list', 'object', 'record'].includes(f.kind)) {
		if (op === 'contains')
			return { t: 'json', field: f.name, contains: yield* jsonOf(v, at) } satisfies Pred;
		if (op === 'isEmpty')
			return { t: 'json', field: f.name, isEmpty: yield* boolean(v, at) } satisfies Pred;
		// a declared shape takes predicates at its paths
		const shaped =
			f.shape === undefined ? undefined : yield* shapeOp(f.name, f.shape, op, v, [], at);
		if (shaped !== undefined) return shaped;
	} else if (!['file', 'vector', 'custom', 'ref'].includes(f.kind)) {
		if (isCmp(op)) {
			if (
				op !== 'eq' &&
				op !== 'ne' &&
				!ORDERED.has(f.kind) &&
				!(f.kind === 'id' && f.pg === 'int8')
			)
				return yield* invalid(`${at}: '${f.name}' is not ordered`);
			return { t: 'cmp', field: f.name, op, arg: yield* val(info, f, v, at) } satisfies Pred;
		}
		if (op === 'in' || op === 'nin') {
			const args = isMemberRef(v)
				? { _tag: 'Member' as const, member: v.member, field: v.field }
				: isOperand(v)
					? yield* operand(info, f, v, at, true)
					: yield* Effect.forEach(yield* list(v, at), (x, i) => literal(f, x, `${at}[${i}]`));
			return { t: 'in', field: f.name, negated: op === 'nin', args } satisfies Pred;
		}
		if (op === 'like' && f.kind === 'text') {
			if (typeof v !== 'string') return yield* invalid(`${at}: takes a pattern string`);
			return { t: 'like', field: f.name, pattern: v } satisfies Pred;
		}
		if ((op === 'folded' || op === 'digits') && f.kind === 'text') {
			if (typeof v !== 'string') return yield* invalid(`${at}: takes text`);
			return { t: 'text', field: f.name, mode: op, value: v } satisfies Pred;
		}
		if (op === 'olderThan' && f.kind === 'instant') {
			const duration = typeof v === 'string' ? /^(\d+)(s|min|h|d)$/.exec(v) : null;
			const units: Readonly<Record<string, number>> = { s: 1, min: 60, h: 3600, d: 86400 };
			const seconds =
				duration === null ? Number.NaN : Number(duration[1]) * (units[duration[2] ?? ''] ?? 0);
			if (!Number.isSafeInteger(seconds) || seconds < 0)
				return yield* invalid(`${at}: takes a nonnegative duration`);
			return { t: 'age', field: f.name, seconds } satisfies Pred;
		}
	}
	return yield* invalid(`${at}: unknown operator '${op}' on '${f.name}'`);
});
/** A shape's structure under a json value's declared `shape`. */
const shaped = (k: KindSpec): KindSpec =>
	k.kind === 'json' && k.shape !== undefined ? shaped(k.shape) : k;
const isKind = (u: unknown): u is KindSpec => Predicate.isObject(u) && typeof u.kind === 'string';
const SCALAR_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'nin', 'like', 'isNull'];
/**
 * One key of a predicate at `path` inside an inline value of shape `k` (relative to `field`, which is `ELEMENT` inside
 * an `each`): an object's field by name, a list's elements quantified, a scalar by its kind's operators. `undefined`:
 * the key is no operator of this shape.
 */
const shapeOp: (
	field: string,
	shape: KindSpec,
	op: string,
	v: unknown,
	path: readonly string[],
	at: string
) => Effect.Effect<Pred | undefined, StoreError> = Effect.fnUntraced(function* (
	field: string,
	shape: KindSpec,
	op: string,
	v: unknown,
	path: readonly string[],
	at: string
) {
	const k = shaped(shape);
	const test = (t: PathTest): Pred => ({ t: 'path', field, path, pg: 'jsonb', test: t });
	if (op === 'contains') return test({ op: 'contains', arg: yield* jsonOf(v, at) });
	if (op === 'isNull') return test({ op: 'null', is: yield* boolean(v, at) });
	if (k.kind === 'object' || k.kind === 'record') {
		const sub = k.kind === 'object' ? (k.fields?.[op] ?? k.rest) : isKind(k.of) ? k.of : undefined;
		if (sub === undefined) return undefined;
		return yield* shapeWhere(field, sub, v, [...path, op], `${at}`);
	}
	if (k.kind === 'list') {
		if (op === 'isEmpty') return test({ op: 'isEmpty', is: yield* boolean(v, at) });
		if ((op === 'some' || op === 'every' || op === 'none') && isKind(k.of)) {
			const pred = yield* shapeWhere(ELEMENT, k.of, v, [], at);
			return { t: 'each', field, path, q: op, pred } satisfies Pred;
		}
		return undefined;
	}
	if (!SCALAR_OPS.includes(op)) return undefined;
	// a scalar at the path: its kind's literal and operators, compared as its column type would be
	const leaf = fieldInfo(path.at(-1) ?? field, k);
	const cast = leaf.pg === 'jsonb' ? 'jsonb' : leaf.pg;
	const scalar = (t: PathTest): Pred => ({ t: 'path', field, path, pg: cast, test: t });
	if (op === 'in' || op === 'nin') {
		const args = yield* Effect.forEach(yield* list(v, at), (x, i) =>
			literal(leaf, x, `${at}[${i}]`)
		);
		return scalar({ op: 'in', args, negated: op === 'nin' });
	}
	if (op === 'like') {
		if (leaf.pg !== 'text' || typeof v !== 'string')
			return yield* invalid(`${at}: takes a pattern string`);
		return scalar({ op: 'like', arg: v });
	}
	if (isCmp(op)) {
		if (op !== 'eq' && op !== 'ne' && !ORDERED.has(leaf.kind))
			return yield* invalid(`${at}: '${path.join('.')}' is not ordered`);
		return scalar({ op, arg: yield* literal(leaf, v, at) });
	}
	return undefined;
});
/** The scalar a path names inside an inline field (an object's fields, a record's values), or `undefined`. */
export function inlineLeaf(f: FieldInfo, path: readonly string[]): FieldInfo | undefined {
	let k: KindSpec | undefined = f.shape;
	for (const step of path) {
		const at: KindSpec | undefined = k === undefined ? undefined : shaped(k);
		k =
			at?.kind === 'object'
				? (at.fields?.[step] ?? at.rest)
				: at?.kind === 'record' && isKind(at.of)
					? at.of
					: undefined;
	}
	if (
		k === undefined ||
		['object', 'record', 'list', 'json', 'union', 'custom', 'file'].includes(shaped(k).kind)
	)
		return undefined;
	return fieldInfo(path.join('.'), shaped(k));
}
/** A whole predicate at `path` inside an inline value: every key an operator of its shape. */
const shapeWhere = Effect.fnUntraced(function* (
	field: string,
	shape: KindSpec,
	ops: unknown,
	path: readonly string[],
	at: string
) {
	const k = shaped(shape);
	const scalar = !['object', 'record', 'list', 'json'].includes(k.kind);
	const preds = yield* Effect.forEach(
		yield* nonEmpty(
			scalar && !Predicate.isObject(ops) ? { eq: ops } : ops,
			at,
			'takes an operator object'
		),
		([op, v]) =>
			Effect.flatMap(shapeOp(field, k, op, v, path, `${at}.${op}`), (p) =>
				p === undefined
					? invalid(`${at}.${op}: unknown operator '${op}' on '${[field, ...path].join('.')}'`)
					: Effect.succeed(p)
			)
	);
	return and(preds);
});
/** A json value as a literal compares it: anything JSON. */
const jsonOf = (v: unknown, at: string): Effect.Effect<Json, StoreError> =>
	isJson(v) ? Effect.succeed(v) : invalid(`${at}: takes JSON`);
const isJson = (v: unknown): v is Json =>
	v === null ||
	typeof v === 'string' ||
	typeof v === 'boolean' ||
	(typeof v === 'number' && Number.isFinite(v)) ||
	(EffectArray.isArray(v) && v.every(isJson)) ||
	(Predicate.isObject(v) && Object.values(v).every(isJson));
const fieldOps = Effect.fnUntraced(function* (
	info: ModelInfo,
	f: FieldInfo,
	ops: unknown,
	path: string
) {
	const es = yield* nonEmpty(shorthand(f, ops), path, `'${f.name}' takes an operator object`);
	return yield* Effect.forEach(es, ([op, v]) => fieldOp(info, f, op, v, `${path}.${op}`));
});

const AGG = ['sum', 'min', 'max', 'avg'] as const;
const isAgg = (q: string): q is (typeof AGG)[number] => AGG.some((a) => a === q);
const MIN_MAX = ['int', 'decimal', 'money', 'sum', 'count', 'duration', 'date', 'instant'];
const SUMMABLE = ['int', 'decimal', 'money', 'sum', 'count', 'duration'];
/** Normalizes a `Where` literal over model `m`, strictly: the first fault is `invalid` with its path. */
export const where: (
	cat: Catalog,
	m: string,
	w: unknown,
	depth?: number,
	path?: string,
	hops?: number
) => Effect.Effect<Pred, StoreError> = Effect.fnUntraced(function* (
	cat: Catalog,
	m: string,
	w: unknown,
	depth = 0,
	path = 'where',
	hops = 0
) {
	if (depth > WHERE_MAX_DEPTH)
		return yield* invalid(`${path}: nested deeper than ${WHERE_MAX_DEPTH}`);
	if (hops > 8) return yield* invalid(`${path}: crosses more than 8 relations`);
	if (!Predicate.isObject(w)) return yield* invalid(`${path}: a predicate is an object`);
	const info = yield* model(cat, m);
	const of: Pred[] = [];
	const sub = (x: unknown, p: string) =>
		Predicate.isObject(x) && entries(x).length === 0
			? invalid(`${p}: an empty predicate (only a root or a quantifier body may be empty)`)
			: where(cat, m, x, depth + 1, p, hops);
	for (const [key, v] of entries(w)) {
		const at = `${path}.${key}`;
		if (key === 'and' || key === 'or')
			of.push({
				t: key,
				of: yield* Effect.forEach(yield* list(v, at), (x, i) => sub(x, `${at}[${i}]`))
			});
		else if (key === 'not') of.push({ t: 'not', of: yield* sub(v, at) });
		else if (key === '$search') {
			if (info.search.length === 0)
				return yield* invalid(`${at}: '${m}' declares no search.text (rule 16)`);
			if (typeof v !== 'string' || v.trim() === '' || v.length > SEARCH_MAX_TEXT)
				return yield* invalid(`${at}: takes 1–${SEARCH_MAX_TEXT} characters`);
			of.push({ t: 'search', text: v });
		} else if (key === '$similar') {
			if (info.semantic === undefined)
				return yield* invalid(`${at}: '${m}' declares no search.semantic (rule 16)`);
			const o = typeof v === 'string' ? { to: v } : v;
			const to = Predicate.isObject(o) ? o.to : undefined,
				top = Predicate.isObject(o) ? (o.top ?? SIMILAR_TOP) : undefined;
			if (
				!Predicate.isObject(o) ||
				Object.keys(o).some((k) => k !== 'to' && k !== 'top') ||
				typeof to !== 'string' ||
				to.trim() === '' ||
				to.length > SEARCH_MAX_TEXT ||
				typeof top !== 'number' ||
				!Number.isSafeInteger(top) ||
				top < 1 ||
				top > SIMILAR_MAX_TOP
			)
				return yield* invalid(`${at}: takes text or { to, top: 1–${SIMILAR_MAX_TOP} }`);
			of.push({ t: 'similar', to, top });
		} else if (info.many.has(key)) {
			const rel = info.many.get(key);
			if (rel === undefined) continue;
			for (const [q, x] of yield* nonEmpty(
				v,
				at,
				'takes some, none, every, count, sum, min, max or avg'
			)) {
				const qa = `${at}.${q}`;
				if (q === 'some' || q === 'none' || q === 'every')
					of.push({
						t: 'many',
						rel: key,
						target: rel.child,
						q,
						pred: yield* where(cat, rel.child, x, depth + 1, qa, hops + 1)
					});
				else if (q === 'count')
					for (const [op, n] of yield* nonEmpty(x, qa, 'takes eq, ne, lt, lte, gt, gte')) {
						if (!isCmp(op) || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
							return yield* invalid(`${qa}.${op}: count takes eq…gte of an integer ≥ 0`);
						of.push({ t: 'count', rel: key, target: rel.child, op, n });
					}
				else if (isAgg(q)) {
					const es = yield* nonEmpty(x, qa, 'takes { of, eq…gte }');
					const name = Predicate.isObject(x) ? x.of : undefined;
					const g =
						typeof name === 'string' && !name.includes('.')
							? (yield* model(cat, rel.child)).fields.get(name)
							: undefined;
					const kinds = q === 'min' || q === 'max' ? MIN_MAX : SUMMABLE;
					if (g === undefined || g.many || !kinds.includes(g.kind))
						return yield* invalid(`${qa}.of: names a child field of ${kinds.join(', ')}`);
					const cmps = es.filter(([k]) => k !== 'of');
					if (cmps.length === 0) return yield* invalid(`${qa}: compares with eq…gte`);
					for (const [op, lit] of cmps) {
						if (!isCmp(op)) return yield* invalid(`${qa}.${op}: unknown operator`);
						// sum and avg are numbers even of a date-free kind; a duration's literal is its own
						const litKind = q === 'avg' && g.kind !== 'duration' ? { ...g, kind: 'decimal' } : g;
						of.push({
							t: 'agg',
							rel: key,
							target: rel.child,
							fn: q,
							of: g.name,
							op,
							arg: yield* literal(litKind, lit, `${qa}.${op}`)
						});
					}
				} else
					return yield* invalid(
						`${qa}: unknown quantifier '${q}' on '${key}' (some, none, every, count, sum, min, max, avg)`
					);
			}
		} else if (info.one.has(key)) {
			const rel = info.one.get(key);
			if (rel === undefined) continue;
			// `{ company_id: id }` is `eq`, as for a field (one target only: a polymorphic relation names its arm)
			const ops =
				rel.targets.length === 1 && !Predicate.isObject(v)
					? v === null
						? { isNull: true }
						: EffectArray.isArray(v)
							? { in: v }
							: { eq: v }
					: v;
			const es = yield* nonEmpty(ops, at, 'takes id operators or { is }');
			if (rel.targets.length > 1) {
				for (const [arm, x] of es) {
					if (!rel.targets.includes(arm))
						return yield* invalid(`${at}.${arm}: not an arm of '${key}'`);
					of.push(...(yield* refOps(cat, info, key, arm, x, depth, `${at}.${arm}`, hops)));
				}
			} else of.push(...(yield* refOps(cat, info, key, null, ops, depth, at, hops)));
		} else {
			const f = info.fields.get(key);
			if (f === undefined || key.includes('.'))
				return yield* invalid(`${at}: unknown field '${key}' on '${m}'`);
			of.push(...(yield* fieldOps(info, f, v, at)));
		}
	}
	return of.length === 0 ? { t: 'const', value: true } : and(of);
});
const refOps = Effect.fnUntraced(function* (
	cat: Catalog,
	info: ModelInfo,
	rel: string,
	arm: string | null,
	v: unknown,
	depth: number,
	path: string,
	hops: number
) {
	const target = arm ?? info.one.get(rel)?.targets[0] ?? '';
	if (Predicate.isObject(v) && 'is' in v) {
		if (entries(v).length !== 1)
			return yield* invalid(`${path}: takes id operators or { is }, not both`);
		if (!Predicate.isObject(v.is) || entries(v.is).length === 0)
			return yield* invalid(`${path}.is: an empty predicate (use isNull: false)`);
		const pred: Pred = {
			t: 'one',
			rel,
			target,
			pred: yield* where(cat, target, v.is, depth + 1, `${path}.is`, hops + 1)
		};
		return [pred];
	}
	const f = info.fields.get(arm === null ? rel : `${rel}.${arm}`);
	if (f === undefined) return yield* invalid(`${path}: unknown relation '${rel}'`);
	return yield* fieldOps(info, f, v, path);
});

/** In the browser (`bolt.decode`): each top-level condition and sort key is kept or dropped alone. */
export const decodeView = /*#__PURE__*/ Effect.fnUntraced(function* (
	cat: Catalog,
	collection: string,
	q: { where?: unknown; orderBy?: unknown }
) {
	yield* collectionOf(cat, collection);
	const dropped: { path: string; message: string }[] = [];
	const keep = Effect.fnUntraced(function* (
		path: string,
		check: Effect.Effect<unknown, StoreError>
	) {
		const checked = yield* Effect.result(check);
		if (Result.isFailure(checked)) dropped.push({ path, message: checked.failure.message });
		return Result.isSuccess(checked);
	});
	const kept: { [key: string]: Json } = {};
	if (Predicate.isObject(q.where)) {
		for (const [k, v] of entries(q.where))
			if (isJson(v) && (yield* keep(`where.${k}`, where(cat, collection, { [k]: v })))) kept[k] = v;
	} else if (q.where !== undefined)
		dropped.push({ path: 'where', message: 'where: a predicate is an object' });
	const keys =
		q.orderBy === undefined ? [] : EffectArray.isArray(q.orderBy) ? q.orderBy : [q.orderBy];
	const sorts: Json[] = [];
	for (const [i, k] of keys.entries())
		if (isJson(k) && (yield* keep(`orderBy[${i}]`, order([...sorts, k], cat, collection))))
			sorts.push(k);
	const view: { where: Json; orderBy?: Json; dropped: { path: string; message: string }[] } = {
		where: kept,
		...(sorts.length === 0 ? {} : { orderBy: sorts }),
		dropped
	};
	return view;
});

export const page = (
	p: Obj,
	max: number = STORE_LIMITS.page.max
): Effect.Effect<PageIR, StoreError> => {
	if (p.all === true)
		return p.limit !== undefined || p.after !== undefined
			? invalid('`all` takes no limit or cursor')
			: Effect.succeed({ _tag: 'All' });
	const limit = p.limit;
	if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > max)
		return invalid(`a read states { limit } (0–${max}) or { all: true } (rule 9)`);
	if (p.after !== undefined && typeof p.after !== 'string') return invalid('a cursor is a string');
	return Effect.succeed(
		p.after === undefined ? { _tag: 'Limit', limit } : { _tag: 'Limit', limit, after: p.after }
	);
};
const SORTABLE_SYSTEM = new Set(['created_at', 'updated_at']);
const SYSTEM = new Set<string>(SYSTEM_COLUMNS);
const UNSORTABLE = new Set([
	'json',
	'list',
	'object',
	'file',
	'custom',
	'vector',
	'point',
	'period',
	'ref'
]);
const ORDER_MAX_HOPS = 2;
/** A sort key's path and direction: `'f'`, `{ f: dir }`, or `{ rel: { f: dir } }` through at most two one-relations. */
const sortKey = Effect.fnUntraced(function* (x: unknown, i: number) {
	const steps: string[] = [];
	let dotted = false;
	let v: unknown = x;
	for (;;) {
		if (typeof v === 'string' && steps.length === 0 && !v.includes('.')) {
			const key: [string, unknown, boolean] = [v, 'asc', false];
			return key;
		}
		// nearest first: `{ location: { near: { lat, lng } } }`
		if (steps.length > 0 && Predicate.isObject(v) && Object.keys(v).length === 1 && point(v.near)) {
			const key: [string, unknown, boolean] = [steps.join('.'), { near: v.near }, dotted];
			return key;
		}
		const e = Predicate.isObject(v) ? entries(v) : [];
		const [only] = e;
		if (e.length !== 1 || only === undefined)
			return yield* invalid(`orderBy[${i}]: one { field: 'asc' | 'desc' } per key`);
		// `{ 'address.city': 'asc' }` is the path `address.city`, as `{ address: { city: 'asc' } }` is
		dotted ||= only[0].includes('.');
		steps.push(...only[0].split('.'));
		v = only[1];
		if (!Predicate.isObject(v)) {
			const key: [string, unknown, boolean] = [steps.join('.'), v, dotted];
			return key;
		}
		if (steps.length > ORDER_MAX_HOPS)
			return yield* invalid(`orderBy[${i}]: a sort crosses at most ${ORDER_MAX_HOPS} relations`);
	}
});
/**
 * `OrderBy` literals: at most 4 keys, one field each, no field twice, each sortable on its collection; a related key
 * (`{ account: { name: 'asc' } }`) is the path `account.name` in the IR. Readability of each hop is the compiler's.
 */
export const order = Effect.fnUntraced(function* (o: unknown, cat?: Catalog, m?: string) {
	if (o === undefined) {
		const none: Order = [];
		return none;
	}
	const items = EffectArray.isArray(o) ? o : [o];
	if (items.length > ORDER_MAX_KEYS)
		return yield* invalid(`orderBy: at most ${ORDER_MAX_KEYS} keys`);
	const seen = new Set<string>();
	const out: Order[number][] = [];
	for (const [i, x] of items.entries()) {
		const [field, key, dotted] = yield* sortKey(x, i);
		const near = Predicate.isObject(key) && point(key.near) ? key.near : undefined;
		const dir = near === undefined ? key : 'asc';
		if (dir !== 'asc' && dir !== 'desc')
			return yield* invalid(`orderBy[${i}]: '${field}' is asc or desc`);
		if (seen.has(field)) return yield* invalid(`orderBy[${i}]: '${field}' twice`);
		seen.add(field);
		const head = field.split('.')[0] ?? field;
		const inline =
			cat === undefined || m === undefined ? undefined : (yield* model(cat, m)).fields.get(head);
		if (dotted && cat !== undefined && m !== undefined && inline?.shape === undefined)
			return yield* invalid(
				`orderBy[${i}]: one { field: 'asc' | 'desc' } per key; a related key nests its relations`
			);
		if (inline?.shape !== undefined && field.includes('.')) {
			// a scalar path inside an inline value sorts by its text cast to its kind
			const leaf = inlineLeaf(inline, field.split('.').slice(1));
			if (leaf === undefined || UNSORTABLE.has(leaf.kind) || near !== undefined)
				return yield* invalid(`orderBy[${i}]: '${field}' is no scalar path`);
		} else if (cat !== undefined && m !== undefined) {
			const steps = field.split('.');
			let info = yield* model(cat, m);
			for (const s of steps.slice(0, -1)) {
				const rel = info.one.get(s);
				const [target] = rel?.targets ?? [];
				if (rel === undefined || rel.targets.length > 1 || target === undefined)
					return yield* invalid(`orderBy[${i}]: '${s}' is not a one-relation of '${info.name}'`);
				info = yield* model(cat, target);
			}
			const last = steps.at(-1) ?? field;
			const f = last.includes('.') ? undefined : info.fields.get(last);
			if (
				near !== undefined
					? f?.kind !== 'point'
					: f === undefined ||
						f.many === true ||
						UNSORTABLE.has(f.kind) ||
						(SYSTEM.has(last) &&
							!SORTABLE_SYSTEM.has(last) &&
							!(steps.length === 1 && info.key.includes(last)))
			)
				return yield* invalid(
					`orderBy[${i}]: '${field}' is not ${near === undefined ? 'sortable' : 'a point'}`
				);
		}
		out.push(near === undefined ? { field, dir } : { field, dir, near });
	}
	const decoded: Order = out;
	return decoded;
});
export const select: (
	cat: Catalog,
	m: string,
	s: unknown,
	depth?: number
) => Effect.Effect<SelectIR, StoreError> = Effect.fnUntraced(function* (
	cat: Catalog,
	m: string,
	s: unknown,
	depth = 0
) {
	if (s === undefined) {
		const all: SelectIR = { fields: null, relations: {} };
		return all;
	}
	if (!Predicate.isObject(s)) return yield* invalid('select is an object');
	if (depth > 8) return yield* invalid('a select is nested deeper than 8 relations');
	const info = yield* model(cat, m);
	const fields: string[] = [];
	const relations: { [rel: string]: RelSelectIR } = {};
	for (const [key, v] of Object.entries(s)) {
		const one = info.one.get(key),
			many = info.many.get(key);
		if (v === true && info.fields.has(key) && !key.includes('.')) fields.push(key);
		else if (Predicate.isObject(v) && one !== undefined) {
			const [target] = one.targets;
			if (target === undefined) return yield* invalid(`'${key}' points at no table`);
			const targetArms = Object.keys(v).filter((name) => name !== 'select' && name !== 'with');
			if (
				targetArms.length > 0 &&
				(one.targets.length === 1 || v.select !== undefined || v.with !== undefined)
			)
				return yield* invalid(
					`'${key}' takes either a common projection or per-target projections`
				);
			for (const name of targetArms)
				if (!one.targets.includes(name)) return yield* invalid(`'${key}' has no target '${name}'`);
			const targetSelects: { [name: string]: SelectIR } = {};
			for (const name of one.targets) {
				const arm = targetArms.length === 0 ? v : v[name];
				if (arm !== undefined && arm !== true && !Predicate.isObject(arm))
					return yield* invalid(`'${key}.${name}' takes a projection`);
				if (
					Predicate.isObject(arm) &&
					Object.keys(arm).some((field) => field !== 'select' && field !== 'with')
				)
					return yield* invalid(`'${key}.${name}' takes only select and with`);
				const projected = Predicate.isObject(arm) ? selection(arm.select, arm.with) : undefined;
				targetSelects[name] = yield* select(cat, name, projected, depth + 1);
			}
			relations[key] = {
				target,
				...(one.targets.length > 1 ? { targets: one.targets, targetSelects } : {}),
				many: false,
				select: targetSelects[target] ?? { fields: null, relations: {} }
			};
		} else if (Predicate.isObject(v) && many !== undefined) {
			const { select: sub, where: w, orderBy, ...paged } = v;
			relations[key] = {
				target: many.child,
				many: true,
				select: yield* select(cat, many.child, sub ?? {}, depth + 1),
				page: yield* page(paged),
				...(w === undefined ? {} : { where: yield* where(cat, many.child, w) }),
				...(orderBy === undefined ? {} : { order: yield* order(orderBy, cat, many.child) })
			};
		} else return yield* invalid(`cannot select '${key}' of '${m}'`);
	}
	// `select: {}` is the default projection, as its type (`Row<C>`) says
	const decoded: SelectIR =
		fields.length === 0 && Object.values(s).every((value) => value !== true)
			? { fields: null, relations }
			: { fields, relations };
	return decoded;
});

/**
 * A literal's projection: `select`'s fields (and, Bolt's form, relations nested in it), and each relation `with` names
 * — `true` for its default projection, or its arm `{ select?, with?, where?, orderBy?, limit | all }`.
 */
const selection = (s: unknown, w: unknown): unknown => {
	if (w === undefined) return s;
	if (s !== undefined && (!Predicate.isObject(s) || EffectArray.isArray(s))) return s;
	if (!Predicate.isObject(w) || EffectArray.isArray(w)) return w;
	const arms = Predicate.isObject(w)
		? Object.fromEntries(
				Object.entries(w).map(([rel, arm]) => {
					if (arm === true) return [rel, { select: {} }];
					if (!Predicate.isObject(arm)) return [rel, arm];
					const { select: sel, with: nested, ...rest } = arm;
					// Target names remain at this level; `select` decodes each target against its own table.
					if (
						sel === undefined &&
						nested === undefined &&
						Object.keys(rest).some((key) => !['where', 'orderBy', 'limit', 'all'].includes(key))
					)
						return [rel, rest];
					return [rel, { ...rest, select: selection(sel ?? {}, nested) }];
				})
			)
		: w;
	return { ...(Predicate.isObject(s) ? s : {}), ...(Predicate.isObject(arms) ? arms : {}) };
};

/** `read(collection, { where?, select?, with?, orderBy?, search? } & Paged)`. */
export const read = Effect.fn('Store.decode.read')(function* (
	cat: Catalog,
	collection: string,
	q: Obj
) {
	const { where: w, select: sel, with: rels, orderBy, search, firstPer, ...paged } = q;
	const s = selection(sel, rels);
	yield* collectionOf(cat, collection);
	if (search !== undefined && typeof search !== 'string')
		return yield* invalid('search is a string');
	let groups: readonly string[] | undefined;
	if (firstPer !== undefined) {
		if (
			!EffectArray.isArray(firstPer) ||
			firstPer.length === 0 ||
			firstPer.some((field) => typeof field !== 'string' || field.includes('.'))
		)
			return yield* invalid('firstPer names one or more sortable columns on this table');
		groups = (yield* order(firstPer, cat, collection)).map(({ field }) => field);
		if (search !== undefined)
			return yield* invalid('firstPer cannot be combined with search ranking');
	}
	const ir: ReadIR = {
		kind: 'read',
		collection,
		select: yield* select(cat, collection, s),
		page: yield* page(paged),
		...(w === undefined ? {} : { where: yield* where(cat, collection, w) }),
		...(orderBy === undefined ? {} : { order: yield* order(orderBy, cat, collection) }),
		...(search === undefined || search === '' ? {} : { search }),
		...(groups === undefined ? {} : { firstPer: groups })
	};
	return ir;
});
export const get = Effect.fn('Store.decode.get')(function* (
	cat: Catalog,
	collection: string,
	id: string,
	q: Obj = {}
) {
	yield* collectionOf(cat, collection);
	const ir: ReadIR = {
		kind: 'get',
		collection,
		id,
		select: yield* select(cat, collection, selection(q.select, q.with))
	};
	return ir;
});
const UNITS = ['day', 'week', 'month', 'quarter', 'year'] as const;
const isUnit = (unit: unknown): unit is NonNullable<Bucket['unit']> =>
	typeof unit === 'string' && UNITS.some((value) => value === unit);
const names = (v: unknown): Effect.Effect<readonly string[] | undefined, StoreError> =>
	v === undefined
		? Effect.succeed(undefined)
		: EffectArray.isArray(v) && v.every((x) => typeof x === 'string')
			? Effect.succeed(v)
			: invalid('sum, avg, min, max take field lists');
/** `aggregate(collection, { by?, count?, sum?, avg?, min?, max?, where? } & Paged?)`; `by` needs a page. */
export const aggregate = Effect.fn('Store.decode.aggregate')(function* (
	cat: Catalog,
	collection: string,
	q: Obj
) {
	const { where: w, by, count, sum, avg, min, max, ...paged } = q;
	yield* collectionOf(cat, collection);
	const buckets = yield* Effect.forEach(
		by === undefined ? [] : EffectArray.isArray(by) ? by : [by],
		(b): Effect.Effect<Bucket, StoreError> => {
			if (typeof b === 'string') return Effect.succeed({ field: b });
			const [unit, field] = Predicate.isObject(b) ? (Object.entries(b)[0] ?? []) : [];
			return isUnit(unit) && typeof field === 'string'
				? Effect.succeed({ field, unit })
				: invalid('a bucket is a field or { <unit>: field }');
		}
	);
	if (by !== undefined && buckets.length === 0)
		return yield* invalid('by names at least one bucket');
	if (buckets.length > 0 && Object.keys(paged).length === 0)
		return yield* invalid('an aggregate with `by` states { limit } or { all: true } (rule 9)');
	const [s, a, lo, hi] = [
		yield* names(sum),
		yield* names(avg),
		yield* names(min),
		yield* names(max)
	];
	const ir: ReadIR = {
		kind: 'aggregate',
		collection,
		by: buckets,
		...(count === true ? { count: true } : {}),
		...(s === undefined ? {} : { sum: s }),
		...(a === undefined ? {} : { avg: a }),
		...(lo === undefined ? {} : { min: lo }),
		...(hi === undefined ? {} : { max: hi }),
		...(w === undefined ? {} : { where: yield* where(cat, collection, w) }),
		...(buckets.length > 0 ? { page: yield* page(paged) } : {})
	};
	return ir;
});
/** `similar(collection, { to, where?, select?, limit })` over `search.semantic`: `to` is text or `{ record: { id } }`. */
export const semantic = Effect.fn('Store.decode.semantic')(function* (
	cat: Catalog,
	collection: string,
	q: Obj
) {
	const c = yield* collectionOf(cat, collection);
	if (c.model.semantic === undefined)
		return yield* invalid(`'${collection}' declares no search.semantic (rule 16)`);
	const { to, where: w, select: s, ...paged } = q;
	const record = Predicate.isObject(to) && Predicate.isObject(to.record) ? to.record : undefined;
	const id = record?.id;
	const text = typeof to === 'string' && to.trim() !== '' ? to : undefined;
	if (text === undefined && typeof id !== 'string')
		return yield* invalid('similar takes { to: text | { record: { id } } }');
	const p = yield* page(paged);
	if (p._tag !== 'Limit' || p.after !== undefined) return yield* invalid('similar takes { limit }');
	const ir: ReadIR = {
		kind: 'similar',
		collection,
		index: SEMANTIC,
		input: text ?? { record: { id: typeof id === 'string' ? id : '' } },
		limit: p.limit,
		...(w === undefined ? {} : { where: yield* where(cat, collection, w) }),
		...(s === undefined ? {} : { select: yield* select(cat, collection, s) })
	};
	return ir;
});
/** `similar(collection, '<index>', input, { where?, select?, limit })` over one `search.indexes` entry. */
export const similar = Effect.fn('Store.decode.similar')(function* (
	cat: Catalog,
	collection: string,
	index: string,
	input: Json,
	q: Obj
) {
	const c = yield* collectionOf(cat, collection);
	if (!Object.hasOwn(c.model.indexes, index))
		return yield* invalid(`'${collection}' declares no search index '${index}'`);
	const p = yield* page(q);
	if (p._tag !== 'Limit' || p.after !== undefined) return yield* invalid('similar takes { limit }');
	const ir: ReadIR = {
		kind: 'similar',
		collection,
		index,
		input,
		limit: p.limit,
		...(q.where === undefined ? {} : { where: yield* where(cat, collection, q.where) }),
		...(q.select === undefined ? {} : { select: yield* select(cat, collection, q.select) })
	};
	return ir;
});
