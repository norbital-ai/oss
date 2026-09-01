import { Schema } from 'effect';
import type {
	AnySchema,
	DefaultWorkspaceSchema,
	SchemaQueryConfig,
	SchemaQueryRow,
	TableName
} from './contracts-schema.js';
import { describeModel } from './model-introspection.js';
import { defineSystemRowModel } from './system-row-model.js';
import type { FieldDefinition } from './workspace-schema.js';
import { declaredCustomTypes, declaredFields, declaredRelation } from './schema-registry.js';
import { describeInvalidCustomValue } from '../runtime/collections/custom-values.js';
import {
	nestedWith,
	requestedColumns,
	requestedRelations,
	selectedColumnNames
} from '../runtime/access/effective-plan.js';

/**
 * States the shape of a record the way a read of it is already stated.
 *
 * ```ts
 * export const input = schema('time_entries', {
 * 	columns: { employment_id: true, work_date: true, worked_intervals: true },
 * 	with: { time_entry_employment: { columns: { id: true } } }
 * });
 * ```
 *
 * **The config is a query config minus the members that choose rows.** `where`, `orderBy`, `limit`
 * and `offset` narrow *which* records answer; `columns` and `with` narrow *what a record is*. Only
 * the second question has anything to do with a shape, so the first four are refused rather than
 * ignored — and everything that is left is spelled exactly as `findMany` spells it. There is no
 * second word for selecting columns: `columns:` is what 307 template call sites and 52 of Bolt's own
 * already write, and a shape that spelled it `select:` would be a second grammar for one idea.
 *
 * **What comes back is a real Effect `Schema`.** Not a description of one, and not a bespoke object
 * with a `Type` property bolted on: it decodes, it composes into unions and structs, and
 * `Schema.Type<typeof input>` is the exact object type the declaration named — `Pick` of the row for
 * the columns it listed, with each `with` entry replacing the column it hydrates. That precision is
 * the whole point. A generated `WorkspaceInputs` map types `api.db.x.mutate` from it, so a write
 * naming a column the shape does not is a type error at the call site rather than a refusal at run
 * time.
 *
 * **It resolves late.** `export const input = schema(…)` runs at module init in a `+hooks.ts`, which
 * a workspace may evaluate before the module that registers its collections. `Schema.suspend` is
 * what makes that a non-question: nothing is looked up until the schema is first used, so an author
 * never has to reason about import order to declare a shape.
 */

/**
 * A shape declaration: a read declaration with the row-selecting members closed off.
 *
 * The four are narrowed to `never` rather than left out, for the reason `SchemaNearestConfig` states
 * about `orderBy`: a generic `Config extends SchemaShapeConfig` admits extra properties, so omitting
 * a member does not remove it. Extending `SchemaQueryConfig` directly — rather than `Omit`-ing it and
 * re-adding the four — also keeps the subtype relation declared rather than inferred, so a shape
 * config is a query config everywhere one is asked for.
 */
export interface SchemaShapeConfig<
	S extends AnySchema,
	N extends TableName<S>
> extends SchemaQueryConfig<S, N> {
	readonly where?: never;
	readonly orderBy?: never;
	readonly limit?: never;
	readonly offset?: never;
}

/**
 * The object type a shape declaration names.
 *
 * It *is* the query row type, applied to the same config: the way you declare a read is the way you
 * declare a shape, so there is nothing here to keep in step with `SchemaQueryRow` — it is that type.
 */
export type SchemaShapeRow<
	S extends AnySchema,
	N extends TableName<S>,
	Config extends SchemaShapeConfig<S, N> | undefined = undefined
> = SchemaQueryRow<S, N, Config>;

/** `schema()` bound to one workspace schema. */
export interface SchemaShape<S extends AnySchema> {
	<
		const N extends TableName<S>,
		const Config extends SchemaShapeConfig<S, N> | undefined = undefined
	>(
		name: N,
		config?: Config
	): Schema.suspend<Schema.Codec<SchemaShapeRow<S, N, Config>>>;
}

const isObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/**
 * The platform columns every collection carries, described once.
 *
 * `describeModel` reports what a `defineModel` declaration says and nothing more, so `id`,
 * `created_at` and their four siblings are absent from every collection's fields — while the row
 * type a query is checked against is `SystemRow & {authored columns}`. Merging them here is what
 * keeps an unnarrowed `schema('x')` the same shape as an unnarrowed `findMany`.
 */
let describedSystemFields: Readonly<Record<string, FieldDefinition>> | undefined;
const systemFields = (): Readonly<Record<string, FieldDefinition>> =>
	(describedSystemFields ??= describeModel(defineSystemRowModel()));

const fieldsOf = (collection: string): Readonly<Record<string, FieldDefinition>> => {
	const declared = declaredFields(collection);
	if (declared === undefined)
		throw new TypeError(
			`schema(${JSON.stringify(collection)}) names a collection this workspace does not declare.`
		);
	return { ...systemFields(), ...declared };
};

/**
 * The DDL types whose values are whole numbers.
 *
 * `numeric` and `integer` are one `ScalarType` — both are `number` to queries and to masking — and
 * they are not one shape: `numeric` is where payroll money lives and `integer` is a count. The
 * distinction survives on `sqlType`, which `describeModelColumns` reads off the built column, so it
 * is available here without a second table of which builder means what.
 */
const INTEGER_SQL_TYPES: ReadonlySet<string> = new Set([
	'smallint',
	'integer',
	'bigint',
	'smallserial',
	'serial',
	'bigserial'
]);

/**
 * A UTC instant is carried as a string and left as one.
 *
 * The column is `timestamptz` read in Drizzle's `mode: 'string'`, and the exact spelling the driver
 * returns is the database's to choose. Fixing a grammar here would make a shape refuse rows the
 * database itself produced, which is the opposite of what a shape is for.
 */
const InstantSchema = Schema.String.annotate({ title: 'instant' });
const UuidSchema = Schema.String.check(Schema.isUUID());

/** What a `file()` column holds — the `FileRef` shape, inline, as `models-schema.ts` declares it. */
const FileRefSchema = Schema.Struct({
	storage_key: Schema.String,
	file_name: Schema.String,
	file_size: Schema.Finite,
	mime_type: Schema.String
});

/**
 * The bare handle a polymorphic reference column holds: one arm per declared target, discriminated
 * by its authored tag. It is `ReferenceHandle<Targets>`, built from the same target list the type is.
 */
const referenceHandle = (reference: NonNullable<FieldDefinition['reference']>): Schema.Top =>
	Schema.Union(
		reference.targets.map((target) =>
			Schema.Struct({ kind: Schema.Literal(target.tag), id: UuidSchema })
		)
	);

/**
 * A `custom()` column, checked by the definition its declared type carries.
 *
 * The check *is* `describeInvalidCustomValue` — the function the command boundary already validates
 * every write through. It resolves the definition out of the registry, unwraps a factory form, walks
 * a `multiple` list and words the failure; and it returns `undefined` for a value that is fine, which
 * is exactly what an Effect filter reads as success. So a shape and a write agree on what a
 * `custom('leave_event')` is by construction rather than by two implementations happening to match.
 */
const customValue = (name: string, field: FieldDefinition): Schema.Top =>
	Schema.Unknown.check(
		Schema.makeFilter(
			(value) =>
				describeInvalidCustomValue(
					{ [name]: field },
					{ [name]: value as Schema.Json },
					declaredCustomTypes()
				),
			{ title: field.customType }
		)
	);

/**
 * One column's value, by what its declaration says it is.
 *
 * The order is by specificity, not by `type`: a reference, a custom type, a file and an enum are all
 * carried on a column whose scalar kind is the storage's answer rather than the value's, so asking
 * the scalar first would render every one of them as the `text` or `jsonb` it is stored in.
 */
const columnValue = (name: string, field: FieldDefinition): Schema.Top => {
	if (field.reference !== undefined) return referenceHandle(field.reference);
	if (field.customType !== undefined) return customValue(name, field);
	if (field.file === true)
		return field.fileMultiple === true ? Schema.Array(FileRefSchema) : FileRefSchema;
	if (field.values !== undefined && field.values.length > 0)
		return Schema.Literals([...field.values]);
	switch (field.type) {
		case 'uuid': {
			return UuidSchema;
		}
		case 'boolean': {
			return Schema.Boolean;
		}
		case 'instant': {
			return InstantSchema;
		}
		case 'number': {
			return field.sqlType !== undefined && INTEGER_SQL_TYPES.has(field.sqlType)
				? Schema.Int
				: Schema.Finite;
		}
		case 'json': {
			return Schema.Json;
		}
		default: {
			return Schema.String;
		}
	}
};

/** A column that may be absent is `null`, never missing — a row always carries every column it has. */
const columnSchema = (name: string, field: FieldDefinition): Schema.Top => {
	const value = columnValue(name, field);
	return field.required ? value : Schema.NullOr(value);
};

/**
 * A hydrated polymorphic reference: the handle it already was, with the record it points at attached.
 *
 * A per-arm spec narrows that arm; a spec with no arm named applies to all of them, which is the rule
 * the read path reads a reference `with` entry by.
 */
const hydratedReference = (
	field: FieldDefinition,
	reference: NonNullable<FieldDefinition['reference']>,
	spec: unknown
): Schema.Top => {
	const arms = reference.targets.map((target) => {
		const targetSpec = isObject(spec) ? (spec[target.tag] ?? spec) : undefined;
		return Schema.Struct({
			kind: Schema.Literal(target.tag),
			id: UuidSchema,
			record: Schema.NullOr(structFor(target.collection, targetSpec))
		});
	});
	const hydrated = Schema.Union(arms);
	return field.required ? hydrated : Schema.NullOr(hydrated);
};

/**
 * One `with` entry, by the cardinality its declaration carries.
 *
 * A `many` relation is an array and a `one` relation is nullable — the same two answers
 * a relational read writes into a row, and the reason they are asked here rather than guessed from
 * the name.
 *
 * A name that resolves to neither a reference column nor a declared relation is refused by both the
 * shape compiler and the read plan. Missing descriptors and cardinality disagreements also fail
 * closed; neither path silently omits a requested relationship.
 */
const relationSchema = (
	collection: string,
	name: string,
	field: FieldDefinition | undefined,
	spec: unknown
): Schema.Top => {
	if (field?.reference !== undefined) return hydratedReference(field, field.reference, spec);
	const relation = declaredRelation(collection, name);
	if (relation === undefined)
		throw new TypeError(
			`schema(${JSON.stringify(collection)}) asks for ${JSON.stringify(name)} under \`with\`, which is neither a reference column nor a relationship this workspace declares.`
		);
	const nested = structFor(relation.target, spec);
	return relation.cardinality === 'many' ? Schema.Array(nested) : Schema.NullOr(nested);
};

/**
 * Assembles one collection's struct: its selected columns, then its `with` entries.
 *
 * `with` is applied second because a hydrated reference replaces the bare handle the column of the
 * same name holds — which is what `SchemaQueryRow` states as `Omit<…, keyof WithRows> & WithRows`.
 */
const structFor = (collection: string, spec: unknown): Schema.Top => {
	const fields = fieldsOf(collection);
	// `Struct.Fields` is keyed by `PropertyKey`; a `string`-keyed record does not satisfy its symbol
	// index signature, and the error it produces names the field map rather than the key.
	const members: Record<PropertyKey, Schema.Top> = {};
	for (const name of selectedColumnNames(Object.keys(fields), requestedColumns(spec))) {
		const field = fields[name];
		if (field !== undefined) members[name] = columnSchema(name, field);
	}
	const relations = nestedWith(spec);
	for (const name of requestedRelations(relations)) {
		members[name] = relationSchema(collection, name, fields[name], relations?.[name]);
	}
	return Schema.Struct(members);
};

/**
 * Built once, on first use.
 *
 * The suspension is what defers the registry lookup past module init; memoizing behind it keeps a
 * schema that is decoded on every request from rebuilding its struct on every request.
 */
const make = (name: string, config?: unknown): Schema.Top => {
	let built: Schema.Top | undefined;
	return Schema.suspend(() => (built ??= structFor(name, config)));
};

/**
 * The shape of a record in this workspace, as a real Effect `Schema`.
 *
 * The single cast is where a runtime that builds a struct from a name meets a type that knows which
 * struct that is. Everything below it is dynamic by necessity — the columns come from a registry —
 * and everything above it is exact.
 */
export const schema = make as SchemaShape<DefaultWorkspaceSchema>;

/**
 * The same primitive, bound to a schema other than the ambient one.
 *
 * A synced workspace augments `WorkspaceAuthoringTypes`, so `schema` already resolves that
 * workspace's collections and nothing needs this. Bolt's own sources and tests have no augmentation
 * to read, and TypeScript infers nothing once a type argument is given by hand — so naming the schema
 * has to happen before the call rather than in it.
 */
export const schemaFor = <S extends AnySchema>(): SchemaShape<S> => make as SchemaShape<S>;
