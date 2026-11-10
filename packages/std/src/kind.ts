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
	readonly storage?: 'int64';
	readonly many?: true;
	readonly min_items?: number;
	readonly max_items?: number;
	readonly key?: string;
	readonly optional?: true;
	readonly default?: Json;
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
				readonly where?: Where;
				readonly money?: { readonly currency?: string };
		  }
		| { readonly kind: 'count'; readonly of: string; readonly where?: Where }
		| { readonly kind: 'json'; readonly shape?: Kind }
		| {
				readonly kind: 'file';
				readonly accept: readonly string[];
				readonly max: string;
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
				readonly where?: Where;
		  }
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
/** The shared recursive descriptor codec is inert until a boundary uses it. */
export const KindSchema: Schema.Codec<Kind> = /* @__PURE__ */ (() => {
	const Bool = Schema.optionalKey(Schema.Literal(true));
	const Num = Schema.optionalKey(Schema.Number);
	const Str = Schema.optionalKey(Schema.String);
	const Strings = Schema.Array(Schema.String);
	/** A where literal inside a declaration: an object here, decoded against the table by the where decoder when used. */
	const WhereLiteral = Schema.Record(Schema.String, Schema.Json);
	const DatePrecision = Schema.Literals(['year', 'month', 'week', 'day']);
	const Precision = Schema.Literals(['year', 'month', 'week', 'day', 'hour', 'minute']);
	/** What every kind takes: `was` names the field it renames (a migration hint). */
	const common = {
		many: Bool,
		min_items: Num,
		max_items: Num,
		key: Str,
		optional: Bool,
		default: Schema.optionalKey(Schema.Json),
		unique: Bool,
		label: Str,
		help: Str,
		hidden: Bool,
		was: Str,
		storage: Schema.optionalKey(Schema.Literal('int64'))
	};

	/** One field's kind: std's kind language (`@norbital-ai/std/kind`), `was` naming the field it renames. */

	const arm = <K extends string, F extends Schema.Struct.Fields>(kind: K, fields: F) =>
		Schema.Struct({ kind: Schema.Literal(kind), ...common, ...fields });
	const Nested = Schema.suspend((): Schema.Codec<Kind> => KindSchema);
	const Fields = Schema.Record(Schema.String, Nested);
	const ARMS = [
		arm('text', {
			format: Schema.optionalKey(
				Schema.Literals(['email', 'phone', 'url', 'zone', 'markdown', 'cel', 'team'])
			),
			max: Num,
			many: Bool
		}),
		arm('int', { min: Num, max: Num }),
		arm('number', { min: Num, max: Num }),
		arm('decimal', { scale: Schema.Number, precision: Num, min: Num, max: Num }),
		arm('money', { currency: Str, scale: Num }),
		arm('currency', {}),
		arm('bool', {}),
		arm('point', {}),
		arm('date', { precision: Schema.optionalKey(DatePrecision) }),
		arm('instant', { precision: Schema.optionalKey(Precision) }),
		arm('time', { precision: Schema.optionalKey(Schema.Literals(['hour', 'minute'])) }),
		arm('period', { of: Schema.Literal('date'), precision: Schema.optionalKey(DatePrecision) }),
		arm('period', { of: Schema.Literal('instant'), precision: Schema.optionalKey(Precision) }),
		arm('enum', { values: Strings, many: Bool }),
		arm('state', {
			initial: Schema.String,
			states: Schema.Record(
				Schema.String,
				Schema.Struct({
					to: Schema.optionalKey(Strings),
					edit: Schema.optionalKey(Schema.Union([Schema.Literals(['all', 'none']), Strings]))
				})
			)
		}),
		arm('seq', { pattern: Str, per: Schema.optionalKey(Strings) }),
		arm('sum', {
			of: Schema.String,
			where: Schema.optionalKey(WhereLiteral),
			money: Schema.optionalKey(Schema.Struct({ currency: Str }))
		}),
		arm('count', { of: Schema.String, where: Schema.optionalKey(WhereLiteral) }),
		arm('json', { shape: Schema.optionalKey(Nested) }),
		arm('file', { accept: Strings, max: Schema.String }),
		arm('vector', { dim: Schema.Number, metric: Schema.Literals(['l2', 'cosine', 'ip']) }),
		arm('custom', { of: Schema.String, many: Bool }),
		arm('ref', {
			to: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
			inverse: Str,
			owned: Bool,
			onDelete: Schema.optionalKey(Schema.Literals(['restrict', 'cascade', 'setNull'])),
			where: Schema.optionalKey(WhereLiteral)
		}),
		arm('object', { fields: Fields, rest: Schema.optionalKey(Nested) }),
		arm('union', { by: Schema.String, arms: Schema.Record(Schema.String, Fields) }),
		arm('union', { of: Schema.Array(Nested) }),
		arm('record', { of: Nested })
	] as const;
	return Schema.Union(ARMS);
})();

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

/** Every kind: its one-value codec (`many` and `optional` are `inputSchema`'s) and its traits. */
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

/** The element descriptor of a many-valued field, without its list-level options. */
export function item_kind(kind: Kind): Kind;
export function item_kind(kind: OutputKind): OutputKind;
export function item_kind(kind: OutputKind): OutputKind {
	const {
		many: _many,
		optional: _optional,
		default: _default,
		min_items: _min,
		max_items: _max,
		key: _key,
		...item
	} = kind;
	return item;
}

const one = <K extends FieldKind>(kind: K, spec: KindOf<K>): KindCodec => KIND[kind].schema(spec);
const memo = new WeakMap<Kind, KindCodec>();
/**
 * The codec of one kind literal, memoised per spec object: `many` holds a list of
 * the kind's values, `optional` admits null. An input's fields decode as `inputSchema({ kind: 'object', fields })`.
 */
export function inputSchema(spec: Kind): KindCodec {
	const known = memo.get(spec);
	if (known !== undefined) return known;
	const value = one(spec.kind, spec);
	const listed: KindCodec =
		spec.many === true
			? Schema.Array(value).check(
					Schema.makeFilter((items) =>
						(spec.min_items === undefined || items.length >= spec.min_items) &&
						(spec.max_items === undefined || items.length <= spec.max_items)
							? undefined
							: 'has the wrong number of items'
					)
				)
			: value;
	const codec: KindCodec = spec.optional === true ? Schema.NullOr(listed) : listed;
	memo.set(spec, codec);
	return codec;
}

/**
 * The datatypes a JSON Schema may name in `format` (JSON Schema's own annotation for a value's semantic type), each with
 * its exact JSON shape: the keys, value types (`type` and `format` of each key) and required keys a value of it has.
 * A renderer reads a schema naming one as that datatype; one matching a shape exactly, unnamed, is read as it too.
 */
export type DatatypeShape =
	| {
			readonly name: 'period' | 'point';
			readonly kind: Kind;
			readonly properties: Readonly<
				Record<string, { readonly type: readonly string[]; readonly format?: string }>
			>;
			readonly required: readonly string[];
	  }
	| {
			readonly name: 'money' | 'currency';
			readonly kind: Kind;
			readonly type: readonly string[];
	  };
/** Canonical native datatype shapes used to validate semantic JSON Schema formats. */
export const DATATYPE_SHAPES: readonly DatatypeShape[] = [
	{
		name: 'period',
		kind: { kind: 'period', of: 'date' },
		properties: {
			from: { type: ['string'], format: 'date' },
			to: { type: ['null', 'string'], format: 'date' }
		},
		required: ['from', 'to']
	},
	{
		name: 'period',
		kind: { kind: 'period', of: 'instant' },
		properties: {
			start: { type: ['string'], format: 'date-time' },
			end: { type: ['null', 'string'], format: 'date-time' }
		},
		required: ['start', 'end']
	},
	{
		name: 'point',
		kind: { kind: 'point' },
		properties: { lat: { type: ['number'] }, lng: { type: ['number'] } },
		required: ['lat', 'lng']
	},
	{ name: 'money', kind: { kind: 'money' }, type: ['number'] },
	{ name: 'currency', kind: { kind: 'currency' }, type: ['string'] }
];
/** JSON Schema's own string formats and the text formats a renderer reads; any other `format` must name a datatype. */
const STRING_FORMATS = new Set([
	'date',
	'date-time',
	'time',
	'duration',
	'email',
	'idn-email',
	'hostname',
	'idn-hostname',
	'ipv4',
	'ipv6',
	'uri',
	'uri-reference',
	'iri',
	'iri-reference',
	'uuid',
	'uri-template',
	'json-pointer',
	'relative-json-pointer',
	'regex',
	'url',
	'phone',
	'zone',
	'markdown',
	'cel'
]);
type SchemaNode = { readonly [key: string]: unknown };
const isNode = (value: unknown): value is SchemaNode =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const typesOf = (node: SchemaNode): string[] => {
	const type = node['type'];
	return typeof type === 'string'
		? [type]
		: Array.isArray(type)
			? type.filter((t): t is string => typeof t === 'string')
			: [];
};
const sameSet = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((item) => b.includes(item));
const listed = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
const describe = (types: readonly string[], format: unknown) =>
	`${types.length === 0 ? 'untyped' : types.join('|')}${typeof format === 'string' ? ` (${format})` : ''}`;

/** How a node naming an object datatype differs from its shape: missing, extra and mistyped keys, required keys. */
function shapeDifferences(
	node: SchemaNode,
	shape: Extract<DatatypeShape, { properties: unknown }>
): string[] {
	const properties = isNode(node['properties']) ? node['properties'] : {};
	const required = Array.isArray(node['required'])
		? node['required'].filter((r): r is string => typeof r === 'string')
		: [];
	const differences: string[] = [];
	if (!sameSet(typesOf(node), ['object']))
		differences.push(`type is ${describe(typesOf(node), undefined)}, not object`);
	const missing = Object.keys(shape.properties).filter((key) => !(key in properties));
	const extra = Object.keys(properties).filter((key) => !(key in shape.properties));
	if (missing.length) differences.push(`missing ${listed(missing)}`);
	if (extra.length) differences.push(`extra ${listed(extra)}`);
	for (const [key, expected] of Object.entries(shape.properties)) {
		const actual = properties[key];
		if (!isNode(actual)) continue;
		if (!sameSet(typesOf(actual), expected.type) || actual['format'] !== expected.format)
			differences.push(
				`'${key}' is ${describe(typesOf(actual), actual['format'])}, not ${describe(expected.type, expected.format)}`
			);
	}
	if (!sameSet(required, shape.required))
		differences.push(`required is [${listed(required)}], not [${listed(shape.required)}]`);
	if (node['additionalProperties'] !== undefined && node['additionalProperties'] !== false)
		differences.push('admits additional properties');
	return differences;
}

/**
 * Every datatype naming error in a JSON Schema document, by JSON Pointer from its root: a `format` naming no datatype
 * (on a string, none of JSON Schema's or the text formats either), and a node naming a datatype whose shape is not
 * exactly that datatype's. Matching a shape without naming it is not checked here: a renderer reads it at run time.
 */
export function datatypeIssues(schema: unknown, at = ''): string[] {
	if (!isNode(schema)) return [];
	const issues: string[] = [];
	const format = schema['format'];
	if (typeof format === 'string') {
		const types = typesOf(schema);
		const string = types.length > 0 && types.every((t) => t === 'string' || t === 'null');
		const named = DATATYPE_SHAPES.filter((shape) => shape.name === format);
		if (named.length === 0) {
			if (!(string && STRING_FORMATS.has(format)))
				issues.push(
					`${at || '/'}: format '${format}' names no datatype (${[...new Set(DATATYPE_SHAPES.map((s) => s.name))].join(', ')})`
				);
		} else {
			// a period's end names pick which period it means (`start`/`end`: an instant period), as a renderer reads it
			const properties = isNode(schema['properties']) ? schema['properties'] : {};
			const instant = 'start' in properties || 'end' in properties;
			const shape =
				named.find(
					(candidate) =>
						candidate.name !== 'period' ||
						(candidate.kind.kind === 'period' && (candidate.kind.of === 'instant') === instant)
				) ?? named[0]!;
			const differences =
				'properties' in shape
					? shapeDifferences(schema, shape)
					: sameSet(types, shape.type)
						? []
						: [`type is ${describe(types, undefined)}, not ${shape.type.join('|')}`];
			if (differences.length > 0)
				issues.push(
					`${at || '/'}: '${format}' does not match its shape: ${differences.join('; ')}`
				);
		}
	}
	const child = (key: string, value: unknown) =>
		issues.push(...datatypeIssues(value, `${at}/${key}`));
	for (const key of ['properties', '$defs', 'definitions', 'patternProperties']) {
		const map = schema[key];
		if (isNode(map))
			for (const [name, value] of Object.entries(map)) child(`${key}/${name}`, value);
	}
	for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains'])
		child(key, schema[key]);
	for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
		const list = schema[key];
		if (Array.isArray(list)) list.forEach((value, index) => child(`${key}/${index}`, value));
	}
	return issues;
}
