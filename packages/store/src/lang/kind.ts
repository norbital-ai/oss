// kind (D7): the one field-kind table. The kind literal a model, an input or a shape declares (structurally, so ui
// and store need no bolt dependency), its traits, and its Schema: `input_schema(spec)` is the one validator of input and
// stored values (callables, write flatten, IR literals, configuration, feed rows, AI output kinds). A value is JSON: a
// decimal is its exact text, a date `YYYY-MM-DD`, an instant ISO UTC `…Z`; arithmetic is Effect's `BigDecimal` and `DateTime`.
import { DateTime, Effect, Option, Predicate, Schema, SchemaGetter, BigDecimal } from 'effect';
import type { Json } from '../values.ts';
export type { Json };

/** JSON Schema data shared by kind projections and renderers; references are never executable code. */
export type JsonSchema = boolean | JsonSchemaObject;
type JsonSchemaObject = {
	readonly [keyword: string]: Json | JsonSchema | readonly JsonSchema[] | undefined;
	readonly $schema?: string;
	readonly $ref?: string;
	readonly type?: string | readonly string[];
	readonly format?: string;
	readonly title?: string;
	readonly description?: string;
	readonly unit?: string;
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly additionalProperties?: JsonSchema;
	readonly required?: readonly string[];
	readonly items?: JsonSchema;
	readonly prefixItems?: readonly JsonSchema[];
	readonly allOf?: readonly JsonSchema[];
	readonly anyOf?: readonly JsonSchema[];
	readonly oneOf?: readonly JsonSchema[];
	readonly if?: JsonSchema;
	readonly then?: JsonSchema;
	readonly else?: JsonSchema;
	readonly not?: JsonSchema;
	readonly enum?: readonly Json[];
	readonly const?: Json;
	readonly default?: Json;
	readonly readOnly?: boolean;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly exclusiveMinimum?: number;
	readonly exclusiveMaximum?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly minProperties?: number;
	readonly maxProperties?: number;
	readonly 'x-norbital'?: {
		readonly datatype?: string;
		readonly section?: string;
		readonly advanced?: boolean;
		readonly order?: number;
	};
};

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
						readonly stamp?: string;
					};
				};
		  }
		| { readonly kind: 'seq'; readonly pattern?: `${string}{${string}}${string}`; readonly per?: readonly string[] }
		| {
				readonly kind: 'sum';
				readonly of: `${string}.${string}`;
				readonly where?: Where;
				readonly money?: { readonly currency?: string };
		  }
		| { readonly kind: 'count'; readonly of: string; readonly where?: Where }
		| { readonly kind: 'json'; readonly shape?: Kind }
		| {
				readonly kind: 'file';
				readonly accept: readonly `${string}/${string}`[];
				readonly max: `${bigint}KiB` | `${bigint}MiB` | `${bigint}GiB`;
		  }
		| { readonly kind: 'vector'; readonly dim: number; readonly metric: 'l2' | 'cosine' | 'ip' }
		| { readonly kind: 'custom'; readonly of: string; readonly many?: true }
		/** A relation: an id of one table, or `{ model, id }` of one of several (polymorphic). */
		| {
				readonly kind: 'ref';
				readonly to: string | readonly string[];
				readonly inverse?: string;
				readonly owned?: true;
				readonly on_delete?: 'restrict' | 'cascade' | 'set_null';
				readonly where?: Where;
		  }
		| { readonly kind: 'object'; readonly fields: Fields; readonly rest?: Kind }
		| {
				readonly kind: 'union';
				readonly by: string;
				readonly arms: { readonly [tag: string]: Fields };
		  }
		/** Untagged: the first scalar arm the value decodes against. */
		| { readonly kind: 'union'; readonly of: readonly ScalarKind[] }
		| { readonly kind: 'record'; readonly of: Kind }
	);
/** The arms an untagged union may hold: scalars, so a value's kind names its arm. */
type ScalarKind = Extract<
	Kind,
	{ readonly kind: 'bool' | 'int' | 'number' | 'decimal' | 'text' | 'enum' | 'date' | 'instant' | 'time' }
>;
/** Common descriptor metadata is shared by values and row-bearing outputs. */
const descriptor_common = /* @__PURE__ */ (() => {
	const Bool = Schema.optionalKey(Schema.Literal(true));
	const Num = Schema.optionalKey(Schema.Number);
	const Str = Schema.optionalKey(Schema.String);
	return {
		many: Bool,
		min_items: Num,
		max_items: Num,
		key: Str,
		optional: Bool,
		default: Schema.optionalKey(Schema.Json),
		label: Str,
		help: Str,
		hidden: Bool,
		was: Str,
		storage: Schema.optionalKey(Schema.Literal('int64'))
	};
})();
const descriptor_arm = <K extends string, F extends Schema.Struct.Fields>(kind: K, fields: F) => {
	const members = { kind: Schema.Literal(kind), ...descriptor_common, ...fields };
	return Schema.StructWithRest(Schema.Struct(members), [
		Schema.Record(Schema.String.check(Schema.makeFilter((key) => !Object.hasOwn(members, key))), Schema.Never)
	]);
};

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
	const Nested = Schema.suspend((): Schema.Codec<Kind> => KindSchema);
	const Fields = Schema.Record(Schema.String, Nested);
	const text_arm = descriptor_arm('text', {
		format: Schema.optionalKey(Schema.Literals(['email', 'phone', 'url', 'zone', 'markdown', 'cel', 'team'])),
		max: Num,
		many: Bool
	});
	const int_arm = descriptor_arm('int', { min: Num, max: Num });
	const number_arm = descriptor_arm('number', { min: Num, max: Num });
	const decimal_arm = descriptor_arm('decimal', { scale: Schema.Number, precision: Num, min: Num, max: Num });
	const bool_arm = descriptor_arm('bool', {});
	const date_arm = descriptor_arm('date', { precision: Schema.optionalKey(DatePrecision) });
	const instant_arm = descriptor_arm('instant', { precision: Schema.optionalKey(Precision) });
	const time_arm = descriptor_arm('time', { precision: Schema.optionalKey(Schema.Literals(['hour', 'minute'])) });
	const enum_arm = descriptor_arm('enum', { values: Strings, many: Bool, transitions: Schema.optionalKey(Schema.Record(Schema.String, Strings)) });
	const ARMS = [
		text_arm,
		int_arm,
		number_arm,
		decimal_arm,
		descriptor_arm('money', { currency: Str, scale: Num }),
		descriptor_arm('currency', {}),
		bool_arm,
		descriptor_arm('point', {}),
		date_arm,
		instant_arm,
		time_arm,
		descriptor_arm('period', { of: Schema.Literal('date'), precision: Schema.optionalKey(DatePrecision) }),
		descriptor_arm('period', { of: Schema.Literal('instant'), precision: Schema.optionalKey(Precision) }),
		enum_arm,
		descriptor_arm('state', {
			initial: Schema.String,
			states: Schema.Record(
				Schema.String,
				Schema.StructWithRest(
					Schema.Struct({ to: Schema.optionalKey(Strings), stamp: Str }),
					[Schema.Record(Schema.String.check(Schema.makeFilter((key) => key !== 'to' && key !== 'stamp')), Schema.Never)]
				)
			)
		}),
		descriptor_arm('seq', {
			pattern: Schema.optionalKey(Schema.TemplateLiteral([Schema.String, '{', Schema.String, '}', Schema.String])),
			per: Schema.optionalKey(Strings)
		}),
		descriptor_arm('sum', {
			of: Schema.TemplateLiteral([Schema.String, '.', Schema.String]),
			where: Schema.optionalKey(WhereLiteral),
			money: Schema.optionalKey(Schema.Struct({ currency: Str }))
		}),
		descriptor_arm('count', { of: Schema.String, where: Schema.optionalKey(WhereLiteral) }),
		descriptor_arm('json', { shape: Schema.optionalKey(Nested) }),
		descriptor_arm('file', {
			accept: Schema.Array(Schema.TemplateLiteral([Schema.String, '/', Schema.String])),
			max: Schema.TemplateLiteral([Schema.BigInt, Schema.Literals(['KiB', 'MiB', 'GiB'])])
		}),
		descriptor_arm('vector', { dim: Schema.Number, metric: Schema.Literals(['l2', 'cosine', 'ip']) }),
		descriptor_arm('custom', { of: Schema.String, many: Bool }),
		descriptor_arm('ref', {
			to: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
			inverse: Str,
			owned: Bool,
			on_delete: Schema.optionalKey(Schema.Literals(['restrict', 'cascade', 'set_null'])),
			where: Schema.optionalKey(WhereLiteral)
		}),
		descriptor_arm('object', { fields: Fields, rest: Schema.optionalKey(Nested) }),
		descriptor_arm('union', { by: Schema.String, arms: Schema.Record(Schema.String, Fields) }),
		descriptor_arm('union', {
			of: Schema.Array(
				Schema.Union([text_arm, int_arm, number_arm, decimal_arm, bool_arm, date_arm, instant_arm, time_arm, enum_arm])
			)
		}),
		descriptor_arm('record', { of: Nested })
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
/** Output descriptors add caller-readable rows at the same recursive object/record/union positions. */
export const OutputKindSchema: Schema.Codec<OutputKind> = /* @__PURE__ */ (() => {
	const Nested = Schema.suspend((): Schema.Codec<OutputKind> => OutputKindSchema);
	const Fields = Schema.Record(Schema.String, Nested);
	return Schema.Union([
		KindSchema,
		descriptor_arm('row', { of: Schema.String }),
		descriptor_arm('object', { fields: Fields, rest: Schema.optionalKey(Nested) }),
		descriptor_arm('record', { of: Nested }),
		descriptor_arm('union', { by: Schema.String, arms: Schema.Record(Schema.String, Fields) })
	]);
})();
/** A stored file's handle: id, name, MIME type, and its size when known. */
export type FileRef = {
	readonly id: string;
	readonly name: string;
	readonly mime: string;
	readonly size?: number;
};
const FileRefSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	mime: Schema.String,
	size: Schema.optionalKey(Schema.Int)
});
/** A file field's input: a stored ref, or an upload's answer (`bytes`, `sha256` beside it) decoded to the same ref. */
const FileInput = Schema.Struct({
	...FileRefSchema.fields,
	bytes: Schema.optionalKey(Schema.Int),
	sha256: Schema.optionalKey(Schema.String)
}).pipe(
	Schema.decodeTo(FileRefSchema, {
		decode: SchemaGetter.transform(({ bytes, sha256: _sha256, ...ref }) =>
			bytes === undefined || ref.size !== undefined ? ref : { ...ref, size: bytes }
		),
		encode: SchemaGetter.transform((ref: FileRef) => ref)
	})
);
/** A bounded image preview; omit the options to download the original stored file. */
export type FileUrlOptions = { readonly preview?: 64 | 512 | 1024 };
/** A latitude and longitude in degrees. */
export type Point = { readonly lat: number; readonly lng: number };
/** A where literal as it travels (the IR decoder reads it). */
export type Where = { readonly [key: string]: Json };
/** A value: JSON; a decimal is its exact text. */
export type Value = Json;
/** A kind's codec: decodes the wire (or an authored literal) into a `Value`, encodes back to the wire. */
export type KindCodec = Schema.Codec<Value, Json>;
/** What operators and views may do with a kind's values. */
type Traits = {
	readonly numeric: boolean;
	readonly ordered: boolean;
	readonly summable: boolean;
	readonly sortable: boolean;
};

const DECIMAL = /^-?\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?$/;
const EMAIL = /^[^@\s]+@[^@\s]+$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The id kind's spelling: any UUID version, the nil id included, either hex case; SQL readers interpolate its source. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IdValue = /*#__PURE__*/ (() =>
	Schema.String.check(Schema.isPattern(UUID_PATTERN, { message: 'expected an id' })))();

/** The date kind's spelling: an actual Gregorian day `YYYY-MM-DD`. */
export const is_plain_date = (value: unknown): value is string =>
	typeof value === 'string' &&
	DATE.test(value) &&
	Option.exists(DateTime.make(value), (day) => DateTime.formatIsoDateUtc(day) === value);

/**
 * A decimal's exact text, without the exponent `BigDecimal.format` writes for a very small or large value: the wire and
 * Postgres numeric spell it in plain digits.
 */
export const decimal_text = (value: BigDecimal.BigDecimal): string => {
	const { value: units, scale } = BigDecimal.normalize(value);
	const sign = units < 0n ? '-' : '',
		digits = (units < 0n ? -units : units).toString();
	if (scale <= 0) return `${sign}${digits}${'0'.repeat(-scale)}`;
	const padded = digits.padStart(scale + 1, '0');
	return `${sign}${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
};
/** A decimal: its exact text, or a finite number as its shortest digits (`0.1` → `'0.1'`). */
const DecimalValue = /*#__PURE__*/ (() =>
	Schema.Union([
		Schema.String.check(Schema.isPattern(DECIMAL, { message: 'expected a decimal' })),
		Schema.Finite
	]).pipe(
		Schema.decodeTo(Schema.String, {
			decode: SchemaGetter.transform((v: string | number) =>
				typeof v === 'number' ? decimal_text(BigDecimal.fromNumberUnsafe(v)) : v
			),
			encode: SchemaGetter.transform((d: string): string | number => d)
		})
	))();
/** A calendar day `YYYY-MM-DD`. */
const DateValue = /*#__PURE__*/ Schema.String.check(
	Schema.makeFilter(is_plain_date, { message: 'expected a date (YYYY-MM-DD)' })
);
/** An instant any ISO form names, as canonical UTC (`…T…:…:….sssZ`). */
const InstantValue = /*#__PURE__*/ (() =>
	Schema.String.check(
		Schema.makeFilter((s: string) => Option.isSome(DateTime.make(s)), {
			message: 'expected an instant'
		})
	).pipe(
		Schema.decodeTo(Schema.String.check(Schema.isPattern(UTC)), {
			decode: SchemaGetter.transform((s: string) => DateTime.formatIso(DateTime.makeUnsafe(s))),
			encode: SchemaGetter.transform((i: string): string => i)
		})
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
		const s = input_schema(k);
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
		return Schema.StructWithRest(named, [Schema.Record(extra, input_schema(rest))]);
	}
	const literal: KindCodec = Schema.Literal(tag.value),
		tagged: [string, Field] = [tag.by, literal];
	return Schema.Struct(Object.fromEntries([...entries, tagged]));
};

type Entry<K extends FieldKind> = {
	readonly schema: (spec: KindOf<K>) => KindCodec;
	readonly json?: (spec: KindOf<K>) => Json;
	readonly view: (spec: KindOf<K>, context: KindView) => JsonSchema;
	readonly describe?: (spec: KindOf<K>, context: KindDescription) => Json;
	readonly label?: (spec: KindOf<K>, many: string) => string;
	readonly signature?: (spec: KindOf<K>) => string;
	readonly traits: Traits;
};
type KindView = {
	readonly common: Pick<JsonSchemaObject, 'title' | 'description'>;
	readonly object: (fields: Fields, rest?: Kind) => JsonSchemaObject;
	readonly project: (spec: Kind) => JsonSchema;
};
type KindDescription = {
	readonly optional: string;
	readonly project: (spec: Kind) => Json;
	readonly custom: (name: string) => Kind | undefined;
};
const NUMBER: Traits = { numeric: true, ordered: true, summable: true, sortable: true };
const ORDERED: Traits = { numeric: false, ordered: true, summable: false, sortable: true };
const PLAIN: Traits = { numeric: false, ordered: false, summable: false, sortable: true };
const OPAQUE: Traits = { numeric: false, ordered: false, summable: false, sortable: false };

/** Every kind owns its codec, traits, model/view projections and descriptive spellings. */
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
		json: (k) => ({ type: 'string', ...(k.max === undefined ? {} : { maxLength: Number(k.max) }) }),
		view: (k, { common }) => ({
			...common,
			type: 'string',
			...(k.format === undefined ? {} : { format: k.format }),
			...(k.max === undefined ? {} : { maxLength: k.max })
		}),
		traits: ORDERED
	},
	int: {
		schema: (k) => numeric(Schema.Int.check(inRange(k))), json: () => ({ type: 'integer' }),
		view: (k, { common }) => ({
			...common,
			type: 'integer',
			...(k.min === undefined ? {} : { minimum: k.min }),
			...(k.max === undefined ? {} : { maximum: k.max })
		}), traits: NUMBER
	},
	number: {
		schema: (k) => numeric(Schema.Finite.check(inRange(k))), json: () => ({ type: 'number' }),
		view: (k, { common }) => ({
			...common,
			type: 'number',
			...(k.min === undefined ? {} : { minimum: k.min }),
			...(k.max === undefined ? {} : { maximum: k.max })
		}),
		describe: (k, { optional }) => `number${k.min === undefined && k.max === undefined ? '' : ` ${k.min ?? ''}..${k.max ?? ''}`}${optional}`,
		traits: NUMBER
	},
	decimal: {
		schema: () => DecimalValue, json: () => ({ type: ['number', 'string'] }),
		view: (k, { common }) => ({
			...common,
			type: 'number',
			...(k.min === undefined ? {} : { minimum: k.min }),
			...(k.max === undefined ? {} : { maximum: k.max })
		}), traits: NUMBER
	},
	money: {
		schema: () => DecimalValue, json: () => ({ type: ['number', 'string'] }),
		view: (_k, { common }) => ({ ...common, type: 'number', format: 'money' }), traits: NUMBER
	},
	sum: {
		schema: () => DecimalValue, view: (_k, { common }) => ({ ...common, type: 'number' }),
		signature: (k) => `sum<${k.of}>`, traits: NUMBER
	},
	count: {
		schema: () => numeric(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
		view: (_k, { common }) => ({ ...common, type: 'integer' }),
		signature: (k) => `count<${k.of}>`,
		traits: NUMBER
	},
	currency: { schema: () => Schema.String, view: (_k, { common }) => ({ ...common, type: 'string', format: 'currency' }), traits: PLAIN },
	bool: { schema: () => Schema.Boolean, json: () => ({ type: 'boolean' }), view: (_k, { common }) => ({ ...common, type: 'boolean' }), traits: PLAIN },
	date: { schema: () => DateValue, json: () => ({ type: 'string', format: 'date' }), view: (_k, { common }) => ({ ...common, type: 'string', format: 'date' }), traits: ORDERED },
	instant: { schema: () => InstantValue, json: () => ({ type: 'string', format: 'date-time' }), view: (_k, { common }) => ({ ...common, type: 'string', format: 'date-time' }), traits: ORDERED },
	time: {
		schema: () =>
			Schema.String.check(Schema.isPattern(TIME, { message: 'expected a time (HH:MM)' })),
		view: (_k, { common }) => ({ ...common, type: 'string', format: 'time' }),
		traits: ORDERED
	},
	period: {
		schema: (k) => period(k.of),
		view: (k, { common }) => {
			const date = k.of === 'date', format = date ? 'date' : 'date-time',
				[from, to] = date ? ['from', 'to'] : ['start', 'end'];
			return { ...common, type: 'object', format: 'period', properties: {
				[from]: { type: 'string', format }, [to]: { type: ['string', 'null'], format }
			}, required: [from, to] };
		},
		signature: (k) => `period<${k.of}>`, traits: OPAQUE
	},
	enum: {
		schema: (k) => Schema.Literals(k.values), json: (k) => ({ enum: [...k.values] }),
		view: (k, { common }) => ({ ...common, type: 'string', enum: k.values }),
		describe: (k, { optional }) => `enum ${k.values.join(' | ')}${optional}`,
		label: (k, many) => `enum ${k.values.join(' | ')}${many}`, traits: PLAIN
	},
	state: {
		schema: (k) => Schema.Literals(Object.keys(k.states)),
		view: (k, { common }) => ({ ...common, type: 'string', enum: Object.keys(k.states) }),
		label: (k) => `state ${Object.keys(k.states).join(' | ')}`, traits: PLAIN
	},
	seq: {
		schema: (k) => (k.pattern === undefined ? Schema.Int : Schema.String),
		view: (_k, { common }) => ({ ...common, type: 'string' }), traits: PLAIN
	},
	json: {
		schema: (k) => (k.shape === undefined ? Schema.Json : input_schema(k.shape)),
		view: (k, { common, project }) => {
			const shape = k.shape === undefined ? undefined : project(k.shape);
			return shape === undefined || typeof shape === 'boolean' ? common : { ...shape, ...common };
		},
		traits: OPAQUE
	},
	/** A custom field's shape is its declaration's (the caller resolves `of`); bare, any JSON. */
	custom: {
		schema: () => Schema.Json,
		view: (k, { common }) => ({ ...common, 'x-norbital': { datatype: k.of } }),
		describe: (k, { custom, optional, project }) => {
			const shape = custom(k.of);
			return shape === undefined ? `${k.of}${optional}` : project(shape);
		},
		signature: (k) => `custom<${k.of}>`, traits: OPAQUE
	},
	ref: {
		schema: (k) =>
			typeof k.to === 'string'
				? Schema.String
				: Schema.Struct({ model: Schema.Literals(k.to), id: Schema.String }),
		json: (k) => typeof k.to === 'string' ? { type: 'string' } : { type: 'object' },
		view: (k, { common }) => typeof k.to === 'string' ? { ...common, type: 'string' } : { ...common, type: 'object' },
		describe: (k, { optional }) => `id of ${typeof k.to === 'string' ? k.to : k.to.join(' | ')}${optional}`,
		traits: PLAIN
	},
	file: {
		schema: () => FileInput,
		view: (_k, { common }) => ({ ...common, type: 'object' }),
		label: (_k, many) => `file reference, as a message lists it${many}`,
		traits: OPAQUE
	},
	point: {
		schema: () => Schema.Struct({ lat: numeric(Schema.Finite), lng: numeric(Schema.Finite) }),
		view: (_k, { common }) => ({ ...common, type: 'object', format: 'point',
			properties: { lat: { type: 'number' }, lng: { type: 'number' } }, required: ['lat', 'lng'] }),
		traits: OPAQUE
	},
	vector: {
		schema: (k) =>
			Schema.Array(numeric(Schema.Finite)).check(
				Schema.isBetweenLength(k.dim, k.dim, { message: `expected ${k.dim} numbers` })
			),
		json: () => ({ type: 'array', items: { type: 'number' } }),
		view: (k, { common }) => ({ ...common, type: 'array', items: { type: 'number' }, minItems: k.dim, maxItems: k.dim }),
		traits: OPAQUE
	},
	object: {
		schema: (k) => fieldsSchema(k.fields, undefined, k.rest),
		view: (k, { object }) => object(k.fields, k.rest),
		describe: (k, { project }) => Object.fromEntries(Object.entries(k.fields).map(([name, field]) => [name, project(field)])),
		json: (k) => {
			const fields = Object.entries(k.fields);
			return {
				type: 'object',
				additionalProperties: k.rest === undefined ? false : json_schema(k.rest),
				properties: Object.fromEntries(fields.map(([name, field]) => [name, json_schema(field)])),
				required: fields.filter(([, field]) => field.optional !== true && field.default === undefined).map(([name]) => name)
			};
		},
		traits: OPAQUE
	},
	union: {
		schema: (k) =>
			'arms' in k
				? Schema.Union(
						Object.entries(k.arms).map(([value, fields]) =>
							fieldsSchema(fields, { by: k.by, value })
						)
					)
				: Schema.Union(k.of.map(input_schema)),
		view: (k, { common, project, object }) => 'of' in k
			? { ...common, anyOf: k.of.map(project) }
			: { ...common, anyOf: Object.entries(k.arms).map(([tag, fields]) => {
				const arm = object(fields);
				return { ...arm, properties: { ...arm.properties, [k.by]: { type: 'string', const: tag } },
					required: [...new Set([k.by, ...(arm.required ?? [])])] };
			}) },
		signature: (k) => 'of' in k ? 'union<undefined>' : 'union',
		json: (k) => ({
			anyOf: 'of' in k ? k.of.map(json_schema) : Object.entries(k.arms).map(([tag, fields]) =>
				json_schema({ kind: 'object', fields: { ...fields, [k.by]: { kind: 'enum', values: [tag] } } })
			)
		}),
		traits: OPAQUE
	},
	record: {
		schema: (k) => Schema.Record(Schema.String, input_schema(k.of)),
		json: (k) => ({ type: 'object', additionalProperties: json_schema(k.of) }),
		view: (k, { common, project }) => ({ ...common, type: 'object', additionalProperties: project(k.of) }),
		signature: (k) => `record<${'of' in k.of ? String(k.of.of) : k.of.kind}>`,
		traits: OPAQUE
	}
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
const jsonOf = <K extends FieldKind>(kind: K, spec: KindOf<K>): Json => KIND[kind].json?.(spec) ?? {};
const viewOf = <K extends FieldKind>(kind: K, spec: KindOf<K>, context: KindView): JsonSchema => KIND[kind].view(spec, context);
const descriptionOf = <K extends FieldKind>(kind: K, spec: KindOf<K>, context: KindDescription): Json =>
	KIND[kind].describe?.(spec, context) ?? `${kind}${context.optional}`;
const labelOf = <K extends FieldKind>(kind: K, spec: KindOf<K>, many: string): string =>
	KIND[kind].label?.(spec, many) ?? `${kind}${many}`;
const signatureOf = <K extends FieldKind>(kind: K, spec: KindOf<K>): string => KIND[kind].signature?.(spec) ?? kind;
/** A renderer owns structure/visibility; the shared kind entry owns its schema projection. */
export const view_schema = (spec: Kind, context: KindView): JsonSchema => viewOf(spec.kind, spec, context);
/** An input descriptor in words, retaining resolved custom shapes and list bounds. */
export function describe_kind(spec: Kind, custom: (name: string) => Kind | undefined = () => undefined): Json {
	const optional = spec.optional === true ? ' (optional)' : '';
	if (spec.many === true) {
		const size = spec.min_items !== undefined && spec.min_items === spec.max_items ? `${spec.min_items} ` : '';
		const item = describe_kind(item_kind(spec), custom);
		return typeof item === 'string' ? `list of ${size}${item}${optional}` : { [`list of ${size}`]: item };
	}
	return descriptionOf(spec.kind, spec, { optional, custom, project: (kind) => describe_kind(kind, custom) });
}
/** A stored field's compact label; relationship targets remain the owning catalogue's responsibility. */
export const kind_label = (spec: Kind): string => labelOf(spec.kind, spec, spec.many === true ? ' (list)' : '');
/** The compact argument spelling used by declaration signatures. */
export const kind_signature = (spec: Kind): string => signatureOf(spec.kind, spec);
/** A kind's model-facing JSON Schema. Opaque kinds stay unconstrained; codecs still validate submitted values. */
export function json_schema(spec: Kind): Json {
	if (spec.many !== true) return jsonOf(spec.kind, spec);
	return {
		type: 'array',
		items: json_schema(item_kind(spec)),
		...(typeof spec.key !== 'string' ? {} : {
			description: `Keyed by "${spec.key}": an item's path is …/<its ${spec.key}>, never its index.`
		})
	};
}
const memo = new WeakMap<Kind, KindCodec>();
/**
 * The codec of one kind literal, memoised per spec object: `many` holds a list of
 * the kind's values, `optional` admits null. An input's fields decode as `input_schema({ kind: 'object', fields })`.
 */
export function input_schema(spec: Kind): KindCodec {
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
type DatatypeShape =
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
export function datatype_issues(schema: unknown, at = ''): string[] {
	if (!isNode(schema)) return [];
	const issues: string[] = [];
	const format = schema['format'];
	if (typeof format === 'string') {
		const types = typesOf(schema);
		const string = types.length > 0 && types.every((t) => t === 'string' || t === 'null');
		const named = DATATYPE_SHAPES.filter((shape) => shape.name === format);
		const [fallback] = named;
		if (fallback === undefined) {
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
				) ?? fallback;
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
		issues.push(...datatype_issues(value, `${at}/${key}`));
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

/** Stored instant fields filled when a newly created row enters its initial state. */
export type InitialStampFields<Fields> = {
	[K in keyof Fields]: Fields[K] extends { kind: 'state'; initial: infer Initial; states: infer States }
		? Initial extends keyof States
			? States[Initial] extends { stamp: infer Field extends string } ? Field : never
			: never
		: never;
}[keyof Fields];

const array = (value: unknown): value is readonly unknown[] => Array.isArray(value);
/**
 * Structural equality of JSON-shaped values, preserving array order. Not Effect's `Equal.equals`: it memoises outer
 * results per object pair, so a draft compared, edited through its proxy and compared again would read the stale answer.
 */
export function equal_json(a: unknown, b: unknown): boolean {
	const x = a, y = b;
	if (x === y) return true;
	if (array(x) || array(y))
		return array(x) && array(y) && x.length === y.length && x.every((value, index) => equal_json(value, y[index]));
	if (!Predicate.isReadonlyObject(x) || !Predicate.isReadonlyObject(y)) return false;
	const entries = (value: Readonly<Record<string, unknown>>) =>
		Object.entries(value).filter(([, item]) => item !== undefined);
	const left = entries(x);
	const right = new Map(entries(y));
	return left.length === right.size && left.every(([key, value]) => right.has(key) && equal_json(value, right.get(key)));
}
