// The built-in layer's rows as the adapters answer them (`db/wire.ts` `parse`; H2): a row's type is derived from its
// model declaration in `src/system` — its key, fields, computed fields and FKs — and its Schema is built from the same
// declaration, so neither is a hand copy. A Schema is named for its table: a malformed row is refused naming it.
import { Schema } from 'effect';
import type { FieldKind } from '../../decl/fields.ts';
import type { ComputedKind, ModelSpec } from '../../decl/model.ts';
import type { Json } from '../../decl/values.ts';
import { SYSTEM, type SystemNames } from '../../system/index.ts';

type Models = SystemNames['models'];
type Relationships = SystemNames['relationships'];
/** A built-in layer model: every one is a system table (`table` is the layer's alone). */
type SystemModel = keyof Models & string;

// ── a column's wire value: what `parse` makes of the Postgres type `schema/ddl.ts` gives the field ──
type Wire<K> = K extends { many: true }
	? readonly string[]
	: K extends { kind: 'enum'; values: readonly (infer V)[] }
		? V
		: K extends { kind: 'int' | 'count' | 'duration' }
			? number
			: K extends { kind: 'seq'; pattern: string }
				? string
				: K extends { kind: 'seq' }
					? number
					: K extends { kind: 'bool' }
						? boolean
						: K extends { kind: 'json' | 'file' | 'custom' | 'object' | 'list' }
							? Json
							: string;
type Cell<K> = K extends { optional: true } ? Wire<K> | null : Wire<K>;
type Computed<K> =
	(K extends { kind: 'int' } ? number : K extends { kind: 'bool' } ? boolean : string) | null;
type ComputedOf<M> = M extends { computed: infer C } ? C : {};
type Key<M> = M extends { table: { primary: 'identity' } }
	? { readonly id: number }
	: M extends { table: { primary: 'text' | 'uuid' } }
		? { readonly id: string }
		: {};
type Fks<N extends string> = {
	readonly [
		R in keyof Relationships as R extends `${N}.${infer F}` ? F : never
	]: Relationships[R] extends { optional: true } ? string | null : string;
};
type Flat<T> = { readonly [P in keyof T]: T[P] };
/** A system table's row: its key column (unless a field is the key), fields, computed fields and FK columns. */
export type Row<N extends SystemModel> = Flat<
	Key<Models[N]> & { readonly [F in keyof Models[N]['fields']]: Cell<Models[N]['fields'][F]> } & {
		readonly [C in keyof ComputedOf<Models[N]>]: Computed<ComputedOf<Models[N]>[C]>;
	} & Fks<N>
>;

// ── the same derivation at run time ──
const WIRE = {
	text: Schema.String,
	int: Schema.Number,
	decimal: Schema.String,
	money: Schema.String,
	currency: Schema.String,
	bool: Schema.Boolean,
	duration: Schema.Number,
	date: Schema.String,
	instant: Schema.String,
	time: Schema.String,
	period: Schema.String,
	enum: Schema.String,
	state: Schema.String,
	seq: Schema.Number,
	sum: Schema.String,
	count: Schema.Number,
	json: Schema.Json,
	object: Schema.Record(Schema.String, Schema.Json),
	list: Schema.Array(Schema.Json),
	file: Schema.Json,
	point: Schema.String,
	vector: Schema.String,
	custom: Schema.Json
} satisfies { readonly [K in FieldKind['kind']]: Schema.Top };
const wire = (k: FieldKind): Schema.Top =>
	'many' in k && k.many === true
		? Schema.Array(Schema.String)
		: k.kind === 'enum'
			? Schema.Literals(k.values)
			: k.kind === 'seq' && k.pattern !== undefined
				? Schema.String
				: WIRE[k.kind];
const COMPUTED: { readonly [K in ComputedKind]: Schema.Top } = {
	text: Schema.String,
	int: Schema.Number,
	decimal: Schema.String,
	money: Schema.String,
	bool: Schema.Boolean,
	date: Schema.String,
	instant: Schema.String
};
function columns(name: string, spec: ModelSpec): ReadonlyMap<string, Schema.Top> {
	const primary = spec.table?.primary;
	return new Map<string, Schema.Top>([
		...(primary === 'identity'
			? [['id', Schema.Number] as const]
			: primary === 'text' || primary === 'uuid'
				? [['id', Schema.String] as const]
				: []),
		...Object.entries(spec.fields).map(
			([f, k]) => [f, k.optional === true ? Schema.NullOr(wire(k)) : wire(k)] as const
		),
		...Object.entries(spec.computed ?? {}).map(
			([c, k]) => [c, Schema.NullOr(COMPUTED[k.kind])] as const
		),
		...Object.entries(SYSTEM.relationships)
			.filter(([key]) => key.startsWith(`${name}.`))
			.map(
				([key, r]) =>
					[
						key.slice(name.length + 1),
						r.optional === true ? Schema.NullOr(Schema.String) : Schema.String
					] as const
			)
	]);
}
const TABLES = new Map(
	Object.entries(SYSTEM.models).map(([name, spec]) => [name, columns(name, spec)])
);

/**
 * Table `name`'s row, or only its `keys` (a statement's select list), as a Schema named for the table. Build it once, at
 * module scope, next to the statement it decodes.
 */
export function row<
	N extends SystemModel,
	const K extends keyof Row<N> & string = keyof Row<N> & string
>(name: N, keys?: readonly K[]): Schema.Decoder<Pick<Row<N>, K>> {
	const want = keys === undefined ? undefined : new Set<string>(keys);
	const is = Schema.is(
		Schema.Struct(
			Object.fromEntries(
				[...(TABLES.get(name) ?? [])].filter(([c]) => want === undefined || want.has(c))
			)
		)
	);
	return Schema.declare((u: unknown): u is Pick<Row<N>, K> => is(u), { identifier: name });
}
