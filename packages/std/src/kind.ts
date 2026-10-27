// std/kind (D7): the one field-kind table. The kind literal a model, an input or a shape declares (structurally, so ui
// and std need no bolt dependency), its traits, and its Schema: `inputSchema(spec)` is the one validator of input and
// stored values (callables, write flatten, IR literals, configuration, feed rows, AI output kinds). A decoded value is
// JSON with std's `Decimal` for decimals; its encoding is the wire's (std/wire): `{ $dec }`, ISO dates and instants.
import { Effect, Schema, SchemaGetter } from 'effect';
import { Decimal } from './decimal.ts';
import { Instant, PlainDate } from './date.ts';
import type { Json } from './wire.ts';
export type { Json };

/** The unit a date is picked in and snapped to, with weeks beginning on Monday. */
export type DatePrecision = 'year' | 'month' | 'week' | 'day';
/** The unit a time is picked in and snapped to. */
export type TimePrecision = 'hour' | 'minute';
/** Calendar or clock granularity for an instant field, selecting the unit its picker offers and snaps values to. */
export type Precision = DatePrecision | TimePrecision;

type Common = {
	readonly optional?: true;
	readonly default?: unknown;
	readonly unique?: true;
	readonly label?: string;
	readonly help?: string;
	readonly hidden?: true;
	/** The name this field had before: a migration renames the column instead of dropping it. */
	readonly was?: string;
};
type Range = { readonly min?: number; readonly max?: number };
/** A kind literal: every stored and input kind with its options, one arm per `kind`. */
export type Kind = Common &
	(
		| {
				readonly kind: 'text';
				readonly format?: 'email' | 'phone' | 'url' | 'zone' | 'markdown' | 'cel' | 'team';
				readonly max?: number;
				readonly many?: true;
		  }
		| ({ readonly kind: 'int' } & Range)
		| ({ readonly kind: 'number' } & Range)
		| ({ readonly kind: 'decimal'; readonly scale: number; readonly precision?: number } & Range)
		| { readonly kind: 'money'; readonly currency?: string; readonly scale?: number }
		| { readonly kind: 'currency' }
		| { readonly kind: 'bool' }
		| { readonly kind: 'duration' }
		| { readonly kind: 'point' }
		| { readonly kind: 'date'; readonly precision?: DatePrecision }
		| { readonly kind: 'instant'; readonly precision?: Precision }
		| { readonly kind: 'time'; readonly precision?: TimePrecision }
		| { readonly kind: 'period'; readonly of: 'date'; readonly precision?: DatePrecision }
		| { readonly kind: 'period'; readonly of: 'instant'; readonly precision?: Precision }
		| {
				readonly kind: 'enum';
				readonly values: readonly string[];
				readonly many?: true;
				/** The states one value may move to; a write naming another transition is refused. */
				readonly transitions?: Readonly<Record<string, readonly string[]>>;
		  }
		| {
				readonly kind: 'state';
				readonly initial: string;
				readonly states: {
					readonly [state: string]: {
						readonly to?: readonly string[];
						readonly edit?: 'all' | 'none' | readonly string[];
					};
				};
		  }
		| { readonly kind: 'seq'; readonly pattern?: string; readonly per?: readonly string[] }
		| {
				readonly kind: 'sum';
				readonly of: string;
				readonly where?: object;
				readonly money?: { readonly currency?: string };
		  }
		| { readonly kind: 'count'; readonly of: string; readonly where?: object }
		| { readonly kind: 'json'; readonly shape?: Kind }
		| {
				readonly kind: 'file';
				readonly accept: readonly string[];
				readonly max: string;
				readonly multiple?: true;
		  }
		| { readonly kind: 'vector'; readonly dim: number; readonly metric: 'l2' | 'cosine' | 'ip' }
		| { readonly kind: 'custom'; readonly of: string; readonly many?: true }
		/** A relation: an id of one table, or `{ model, id }` of one of several (polymorphic). */
		| {
				readonly kind: 'ref';
				readonly to: string | readonly string[];
				readonly inverse?: string;
				readonly owned?: true;
				readonly onDelete?: 'restrict' | 'cascade' | 'setNull';
				readonly where?: object;
		  }
		| { readonly kind: 'id'; readonly of: string; readonly where?: Where }
		| ({ readonly kind: 'list'; readonly of: Kind; readonly key?: string } & Range)
		| { readonly kind: 'object'; readonly fields: Fields; readonly rest?: Kind }
		| {
				readonly kind: 'union';
				readonly by: string;
				readonly arms: { readonly [tag: string]: Fields };
		  }
		/** Untagged: the first scalar arm the value decodes against. */
		| { readonly kind: 'union'; readonly of: readonly Kind[] }
		| { readonly kind: 'record'; readonly of: Kind }
	);
/** Named kinds: an object's, an input's or a custom field's fields. */
export type Fields = { readonly [name: string]: Kind };
/** The name of a kind. */
export type FieldKind = Kind['kind'];
/** The literal of one kind. */
export type KindOf<K extends FieldKind> = Extract<Kind, { readonly kind: K }>;
/** Output metadata may name rows. The owning workspace resolves row descriptors before using an input codec. */
export type OutputKind =
	| Kind
	| (Common &
			(
				| { readonly kind: 'row'; readonly of: string }
				| {
						readonly kind: 'list';
						readonly of: OutputKind;
						readonly min?: number;
						readonly max?: number;
				  }
				| {
						readonly kind: 'object';
						readonly fields: { readonly [name: string]: OutputKind };
						readonly rest?: OutputKind;
				  }
				| { readonly kind: 'record'; readonly of: OutputKind }
				| {
						readonly kind: 'union';
						readonly by: string;
						readonly arms: { readonly [tag: string]: { readonly [name: string]: OutputKind } };
				  }
			));
/** A stored file's handle: id, name, MIME type, and its size when known. */
export type FileRef = {
	readonly id: string;
	readonly name: string;
	readonly mime: string;
	readonly size?: number;
};
/** A bounded image preview; omit the options to download the original stored file. */
export type FileUrlOptions = { readonly preview?: 64 | 512 | 1024 };
/** A latitude and longitude in degrees. */
export type Point = { readonly lat: number; readonly lng: number };
/** A where literal as it travels (the IR decoder reads it). */
export type Where = { readonly [key: string]: Json };
/** A decoded value: JSON, with std's `Decimal` for a decimal, money or sum value. */
export type Value =
	null | boolean | number | string | Decimal | readonly Value[] | { readonly [key: string]: Value };
/** A kind's codec: decodes the wire (or an authored literal) into a `Value`, encodes back to the wire. */
export type KindCodec = Schema.Codec<Value, Json>;
/** What operators and views may do with a kind's values. */
export type Traits = {
	readonly numeric: boolean;
	readonly ordered: boolean;
	readonly summable: boolean;
	readonly sortable: boolean;
};

const DECIMAL = /^-?\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The canonical ID value, without retaining the field-kind catalogue. */
export const IdValue = /*#__PURE__*/ (() =>
	Schema.String.check(Schema.isPattern(UUID, { message: 'expected an id' })))();

/** A finite double as a decimal of exactly its shortest digits (`0.1` → `0.1`, `1.5e-7` → `0.00000015`). */
function decimalOfNumber(n: number): Decimal {
	const m = /(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(n));
	return Decimal.fromNumber(n, Math.max(0, (m?.[1]?.length ?? 0) - Number(m?.[2] ?? 0)));
}
const calendarDay = (s: string) => {
	const t = DATE.test(s) ? Date.parse(`${s}T00:00:00Z`) : Number.NaN;
	return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};

const DecimalSelf = /*#__PURE__*/ Schema.declare(
	(u: unknown): u is Decimal => u instanceof Decimal,
	{
		title: 'Decimal'
	}
);
/** A decimal: `{ $dec }` on the wire, or an authored decimal text or finite number; encoded as `{ $dec }`. */
const DecimalValue = /*#__PURE__*/ (() =>
	Schema.Union([
		Schema.Struct({
			$dec: Schema.String.check(Schema.isPattern(DECIMAL, { message: 'expected a decimal' }))
		}),
		Schema.String.check(Schema.isPattern(DECIMAL, { message: 'expected a decimal' })),
		Schema.Finite
	]).pipe(
		Schema.decodeTo(DecimalSelf, {
			decode: SchemaGetter.transform((v: { readonly $dec: string } | string | number) =>
				typeof v === 'number' ? decimalOfNumber(v) : Decimal.of(typeof v === 'string' ? v : v.$dec)
			),
			encode: SchemaGetter.transform((d: Decimal) => d.toJSON())
		})
	))();
/** A calendar day `YYYY-MM-DD`, as std's branded `PlainDate`. */
const DateValue = /*#__PURE__*/ (() =>
	Schema.String.check(
		Schema.makeFilter(calendarDay, { message: 'expected a date (YYYY-MM-DD)' })
	).pipe(
		Schema.decodeTo(
			Schema.declare((u: unknown): u is PlainDate => typeof u === 'string' && calendarDay(u), {
				title: 'PlainDate'
			}),
			{
				decode: SchemaGetter.transform((s: string) => PlainDate(s)),
				encode: SchemaGetter.transform((d: PlainDate): string => d)
			}
		)
	))();
/** An instant any ISO form names, as std's canonical UTC `Instant` (`…T…:…:….sssZ`). */
const InstantValue = /*#__PURE__*/ (() =>
	Schema.String.check(
		Schema.makeFilter((s: string) => !Number.isNaN(Date.parse(s)), {
			message: 'expected an instant'
		})
	).pipe(
		Schema.decodeTo(
			Schema.declare((u: unknown): u is Instant => typeof u === 'string' && UTC.test(u), {
				title: 'Instant'
			}),
			{
				decode: SchemaGetter.transform((s: string) => Instant(new Date(Date.parse(s)))),
				encode: SchemaGetter.transform((i: Instant): string => i)
			}
		)
	))();
/** A date period `{ from, to | null }` (inclusive) or an instant period `{ start, end | null }` (closed-open); a missing end is open. */
const open = <S extends KindCodec>(s: S) =>
	Schema.NullOr(s).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)));
const period = (of: 'date' | 'instant'): KindCodec =>
	of === 'date'
		? Schema.Struct({ from: DateValue, to: open(DateValue) }).check(
				Schema.makeFilter((p) =>
					p.to === null || p.from <= p.to ? undefined : `'from' is after 'to'`
				)
			)
		: Schema.Struct({ start: InstantValue, end: open(InstantValue) }).check(
				Schema.makeFilter((p) =>
					p.end === null || p.start < p.end ? undefined : `'start' is after 'end'`
				)
			);
const inRange = (k: Range) =>
	Schema.makeFilter((n: number) =>
		(k.min === undefined || n >= k.min) && (k.max === undefined || n <= k.max)
			? undefined
			: 'is out of range'
	);
/** JSON has one zero; normalise its numeric codecs before a value crosses the wire. */
const numeric = (schema: Schema.Codec<number, number>) =>
	schema.pipe(
		Schema.decodeTo(schema, {
			decode: SchemaGetter.transform((value: number) => (value === 0 ? 0 : value)),
			encode: SchemaGetter.transform((value: number) => (value === 0 ? 0 : value))
		})
	);
/** An object of named kinds: an optional or defaulted field may be absent or null. */
type Field = KindCodec | Schema.optionalKey<KindCodec>;
const fieldsSchema = (
	fields: Fields,
	tag?: { readonly by: string; readonly value: string },
	rest?: Kind
): KindCodec => {
	const entries = Object.entries(fields).map(([name, k]): [string, Field] => {
		const s = inputSchema(k);
		if (k.optional !== true && k.default === undefined)
			return [
				name,
				s.check(Schema.makeFilter((value) => (value !== null ? undefined : 'is required')))
			];
		const absent: KindCodec = k.optional === true ? s : Schema.NullOr(s);
		return [name, Schema.optionalKey(absent)];
	});
	if (tag === undefined) {
		if (entries.length === 0 && rest === undefined)
			return Schema.Record(Schema.String, Schema.Never);
		const named = Schema.Struct(Object.fromEntries(entries));
		if (rest === undefined) return named;
		// Native index signatures include fixed keys; a Kind's rest describes undeclared own keys only.
		const extra = Schema.String.check(
			Schema.makeFilter((key: string) => !Object.hasOwn(fields, key))
		);
		return Schema.StructWithRest(named, [Schema.Record(extra, inputSchema(rest))]);
	}
	const literal: KindCodec = Schema.Literal(tag.value),
		tagged: [string, Field] = [tag.by, literal];
	return Schema.Struct(Object.fromEntries([...entries, tagged]));
};

type Entry<K extends FieldKind> = {
	readonly schema: (spec: KindOf<K>) => KindCodec;
	readonly traits: Traits;
};
const NUMBER: Traits = { numeric: true, ordered: true, summable: true, sortable: true };
const ORDERED: Traits = { numeric: false, ordered: true, summable: false, sortable: true };
const PLAIN: Traits = { numeric: false, ordered: false, summable: false, sortable: true };
const OPAQUE: Traits = { numeric: false, ordered: false, summable: false, sortable: false };

/** Every kind: its one-value codec (`many`, `multiple` and `optional` are `inputSchema`'s) and its traits. */
export const KIND: { readonly [K in FieldKind]: Entry<K> } = {
	text: {
		schema: (k) =>
			Schema.String.check(
				Schema.makeFilter((s: string) =>
					k.max !== undefined && s.length > k.max
						? `is over ${k.max} characters`
						: k.format === 'email' && !EMAIL.test(s)
							? 'expected an email address'
							: undefined
				)
			),
		traits: ORDERED
	},
	int: { schema: (k) => numeric(Schema.Int.check(inRange(k))), traits: NUMBER },
	number: { schema: (k) => numeric(Schema.Finite.check(inRange(k))), traits: NUMBER },
	decimal: { schema: () => DecimalValue, traits: NUMBER },
	money: { schema: () => DecimalValue, traits: NUMBER },
	sum: { schema: () => DecimalValue, traits: NUMBER },
	count: {
		schema: () => numeric(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
		traits: NUMBER
	},
	/** Whole seconds. */
	duration: { schema: () => numeric(Schema.Int), traits: NUMBER },
	currency: { schema: () => Schema.String, traits: PLAIN },
	bool: { schema: () => Schema.Boolean, traits: PLAIN },
	date: { schema: () => DateValue, traits: ORDERED },
	instant: { schema: () => InstantValue, traits: ORDERED },
	time: {
		schema: () =>
			Schema.String.check(Schema.isPattern(TIME, { message: 'expected a time (HH:MM)' })),
		traits: ORDERED
	},
	period: { schema: (k) => period(k.of), traits: OPAQUE },
	enum: { schema: (k) => Schema.Literals(k.values), traits: PLAIN },
	state: { schema: (k) => Schema.Literals(Object.keys(k.states)), traits: PLAIN },
	seq: { schema: (k) => (k.pattern === undefined ? Schema.Int : Schema.String), traits: PLAIN },
	id: {
		schema: () => IdValue,
		traits: PLAIN
	},
	json: {
		schema: (k) => (k.shape === undefined ? Schema.Json : inputSchema(k.shape)),
		traits: OPAQUE
	},
	/** A custom field's shape is its declaration's (the caller resolves `of`); bare, any JSON. */
	custom: { schema: () => Schema.Json, traits: OPAQUE },
	ref: {
		schema: (k) =>
			typeof k.to === 'string'
				? Schema.String
				: Schema.Struct({ model: Schema.Literals(k.to), id: Schema.String }),
		traits: PLAIN
	},
	file: {
		schema: () =>
			Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				mime: Schema.String,
				size: Schema.optionalKey(Schema.Int)
			}),
		traits: OPAQUE
	},
	point: {
		schema: () => Schema.Struct({ lat: numeric(Schema.Finite), lng: numeric(Schema.Finite) }),
		traits: OPAQUE
	},
	vector: {
		schema: (k) =>
			Schema.Array(numeric(Schema.Finite)).check(
				Schema.isBetweenLength(k.dim, k.dim, { message: `expected ${k.dim} numbers` })
			),
		traits: OPAQUE
	},
	list: {
		schema: (k) =>
			Schema.Array(inputSchema(k.of)).check(
				Schema.makeFilter((xs) =>
					(k.min === undefined || xs.length >= k.min) && (k.max === undefined || xs.length <= k.max)
						? undefined
						: 'has the wrong number of items'
				)
			),
		traits: OPAQUE
	},
	object: { schema: (k) => fieldsSchema(k.fields, undefined, k.rest), traits: OPAQUE },
	union: {
		schema: (k) =>
			'arms' in k
				? Schema.Union(
						Object.entries(k.arms).map(([value, fields]) =>
							fieldsSchema(fields, { by: k.by, value })
						)
					)
				: Schema.Union(k.of.map(inputSchema)),
		traits: OPAQUE
	},
	record: { schema: (k) => Schema.Record(Schema.String, inputSchema(k.of)), traits: OPAQUE }
};

const one = <K extends FieldKind>(kind: K, spec: KindOf<K>): KindCodec => KIND[kind].schema(spec);
const memo = new WeakMap<Kind, KindCodec>();
/**
 * The codec of one kind literal, memoised per spec object: `many` (text, enum, custom) and `multiple` (file) are lists of
 * the kind's values, `optional` admits null. An input's fields decode as `inputSchema({ kind: 'object', fields })`.
 */
export function inputSchema(spec: Kind): KindCodec {
	const known = memo.get(spec);
	if (known !== undefined) return known;
	const value = one(spec.kind, spec);
	const listed: KindCodec =
		('many' in spec && spec.many === true) || ('multiple' in spec && spec.multiple === true)
			? Schema.Array(value)
			: value;
	const codec: KindCodec = spec.optional === true ? Schema.NullOr(listed) : listed;
	memo.set(spec, codec);
	return codec;
}
