import { and, type AnyDBQueryConfig, type AnyRelations, type SQL } from 'drizzle-orm';
import { Effect, Result, Schema } from 'effect';
import type { FieldDefinition, WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import { referenceArmKey } from '#lib/compiler/relational-schema.js';
import { decodeReferenceRow } from '#lib/runtime/collections/references.js';
import {
	compileOrderTerms,
	compileWhere,
	makeWhereContext,
	orderingExpressions,
	WhereCompileError
} from '#lib/runtime/collections/read/where.js';
import {
	boundedCount,
	nestedWith,
	referenceArmSpec,
	relationSpec,
	requestedColumns,
	requestedRelations,
	selectedColumnNames,
	type ColumnSelection
} from '#lib/runtime/collections/with-clause.js';

/**
 * A `with` clause, as a Drizzle relational query and hydration plan.
 *
 * The whole read — the rows and every relation hanging off them, at every depth — is one statement.
 * Drizzle emits each relation as a `left join lateral (select … ) on true` whose inner select is an
 * ordinary query over the related table, and that inner `where` is where this puts the subject's
 * row-visibility predicate for that collection. A related record is therefore filtered by exactly
 * the predicate a direct read of its collection would carry, inside the same statement, and `with`
 * cannot become a way to see rows a subject could not otherwise read.
 *
 * What SQL cannot do, this does over the result: field masking is a policy fact about columns
 * rather than rows, and a polymorphic reference is one logical handle over several physical arms.
 * Both are applied per level on the way out, against the level's own collection.
 */

/**
 * The alias Drizzle gives the table at one nesting depth.
 *
 * Drizzle names the root `d0` and each nested level `d{depth}`, and the compiled predicates a read
 * carries qualify their columns by name — so a level's alias has to be known before its `where` is
 * compiled. A change to that scheme is a hard SQL error naming the missing alias, never a silently
 * wrong answer, and `tests/collections/relation-query.test.ts` pins it.
 */
const levelAlias = (depth: number): string => `d${depth}`;

/** The root of a relational read, and the depth every `with` entry hangs one level below. */
export const ROOT_ALIAS = levelAlias(0);

/** How one relation Drizzle returned is written back onto the row that asked for it. */
type Attachment =
	| Readonly<{
			readonly _tag: 'Relation';
			readonly key: string;
			readonly many: boolean;
			readonly level: LevelPlan;
	  }>
	| Readonly<{
			readonly _tag: 'Reference';
			readonly key: string;
			readonly field: string;
			readonly tag: string;
			readonly level: LevelPlan;
	  }>;

/** What one level of a relational result has to be read as, once the statement has run. */
type LevelPlan = Readonly<{
	readonly collection: string;
	/**
	 * The reference fields whose physical arms this level selected.
	 *
	 * Only those: `decodeReferenceRow` refuses a required reference whose arms are all absent, and a
	 * narrowed `columns` clause is entitled to leave a reference out entirely.
	 */
	readonly referenceFields: Readonly<Record<string, FieldDefinition>>;
	readonly attachments: ReadonlyArray<Attachment>;
	/** The row keys those attachments occupy, so splitting a row costs one lookup per column. */
	readonly attached: ReadonlySet<string>;
}>;

/** The complete hydration and presentation plan consumed by the callable Resolver. */
type RelationReadPlan = Readonly<{
	readonly root: LevelPlan;
	/** Root projection is deliberately post-read so grouped lanes can first consume `source`. */
	readonly rootProjection: ColumnSelection | undefined;
}>;

/** Everything the planner needs that belongs to the running invocation rather than to the clause. */
export type PlanContext = Readonly<{
	readonly definition: WorkspaceDefinition;
	readonly relations: AnyRelations;
	/** Refuses the whole read when a `with` names a collection this subject may not read at all. */
	readonly authorize: (collection: string) => Effect.Effect<void, AccessControl.AccessDenied>;
	readonly predicate: (collection: string) => AccessControl.RowPredicate;
}>;

const isObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/** The collection's authored fields, or nothing when the workspace does not declare it. */
const fieldsOf = (
	definition: WorkspaceDefinition,
	collection: string
): Readonly<Record<string, FieldDefinition>> =>
	definition.collections.find((entry) => entry.name === collection)?.fields ?? {};

/**
 * The physical columns a logical `columns` clause resolves to.
 *
 * The clause names authored fields; the table holds system columns and, for a polymorphic
 * reference, one nullable arm per target instead of the field itself. `undefined` means the clause
 * narrowed nothing, which is Drizzle's own "every column" — the two agree, so an unnarrowed level
 * needs no selection at all.
 */
const physicalSelection = (
	fields: Readonly<Record<string, FieldDefinition>>,
	columns: ColumnSelection | undefined
): Readonly<Record<string, true>> | undefined => {
	if (columns === undefined) return undefined;
	const selection: Record<string, true> = {};
	const available = [...SYSTEM_COLUMN_NAMES, ...Object.keys(fields)];
	for (const name of selectedColumnNames(available, columns)) {
		const reference = fields[name]?.reference;
		if (reference === undefined) selection[name] = true;
		else for (const target of reference.targets) selection[target.storageColumn] = true;
	}
	return selection;
};

/** The reference fields a level can decode: the ones whose every arm it selected. */
const decodableReferences = (
	fields: Readonly<Record<string, FieldDefinition>>,
	selection: Readonly<Record<string, true>> | undefined
): Readonly<Record<string, FieldDefinition>> =>
	Object.fromEntries(
		Object.entries(fields).filter(
			([, field]) =>
				field.reference !== undefined &&
				(selection === undefined ||
					field.reference.targets.every((target) => selection[target.storageColumn] === true))
		)
	);

/** One level's row-visibility predicate, and-ed with whatever the caller narrowed it by. */
const levelWhere = (
	context: PlanContext,
	collection: string,
	fields: Readonly<Record<string, FieldDefinition>>,
	spec: unknown,
	depth: number
): Result.Result<SQL, WhereCompileError> => {
	const visibility = AccessControl.predicateExpression(context.predicate(collection));
	const narrowing = isObject(spec) ? spec['where'] : undefined;
	if (narrowing === undefined) return Result.succeed(visibility);
	const compiled = compileWhere(
		narrowing,
		makeWhereContext(collection, fields, context.definition, levelAlias(depth))
	);
	if (Result.isFailure(compiled)) return Result.fail(compiled.failure);
	return Result.succeed(and(visibility, compiled.success) ?? visibility);
};

/**
 * Turns one `with` entry into the Drizzle query config for the level it names.
 *
 * `where`, `orderBy`, `limit` and `offset` are the relation's own: a lateral subquery is a whole
 * query, so a caller may narrow, sort and bound a relation exactly as it narrows, sorts and bounds
 * the rows the relation hangs off.
 */
const levelConfig = (
	context: PlanContext,
	collection: string,
	spec: unknown,
	depth: number
): Effect.Effect<
	Readonly<{ readonly config: AnyDBQueryConfig; readonly level: LevelPlan }>,
	WhereCompileError | AccessControl.AccessDenied
> =>
	Effect.gen(function* () {
		const fields = fieldsOf(context.definition, collection);
		const selection = physicalSelection(fields, requestedColumns(spec));
		const nested = yield* planWith(context, collection, nestedWith(spec), depth);
		if (
			selection !== undefined &&
			Object.keys(selection).length === 0 &&
			nested.with === undefined
		) {
			return yield* new WhereCompileError({
				collection,
				field: 'columns',
				message: `columns names no column of ${collection}; a related record has to select something.`
			});
		}
		const where = levelWhere(context, collection, fields, spec, depth);
		if (Result.isFailure(where)) return yield* where.failure;
		const ordering = compileOrderTerms(
			isObject(spec) ? spec['orderBy'] : undefined,
			makeWhereContext(collection, fields, context.definition, levelAlias(depth))
		);
		const limit = boundedCount(isObject(spec) ? spec['limit'] : undefined);
		const offset = boundedCount(isObject(spec) ? spec['offset'] : undefined);
		return {
			// `RAW` is Drizzle's escape hatch for a predicate its filter grammar cannot express, and
			// `relationsFilterToSQL` honours it first of all — `case "RAW": … parts.push(processed)`.
			// The *declared* `RelationsFilter`, though, intersects an index signature of per-column
			// filters over `RelationsFilterCommons`, so a bound `SQL` is checked against a column
			// filter's shape and fails on the one key the runtime reads before any other. This cast is
			// therefore load-bearing rather than tidy-uppable: it is the only way to put a compiled
			// policy predicate inside a relation's own lateral subquery, which is the whole security
			// property of this module. Do not remove it, and do not widen a type of ours to avoid it.
			config: {
				...(selection === undefined ? {} : { columns: selection }),
				where: { RAW: where.success },
				orderBy: (table: unknown) => [...orderingExpressions(table, ordering)],
				...(limit === undefined ? {} : { limit }),
				...(offset === undefined ? {} : { offset }),
				...(nested.with === undefined ? {} : { with: nested.with })
			} as unknown as AnyDBQueryConfig,
			level: {
				collection,
				referenceFields: decodableReferences(fields, selection),
				attachments: nested.attachments,
				attached: new Set(nested.attachments.map((attachment) => attachment.key))
			}
		};
	});

/** Whether this workspace declared a relation Drizzle can resolve under that key. */
const declaredRelation = (
	relations: AnyRelations,
	collection: string,
	key: string
): Readonly<{ readonly relationType: 'one' | 'many' }> | undefined => {
	const relation = relations[collection]?.relations[key];
	return relation === undefined ? undefined : { relationType: relation.relationType };
};

/**
 * Reads a `with` clause into the Drizzle `with` config and the plan for reading its result back.
 *
 * An entry naming neither a reference column nor a relation Drizzle could resolve is left off the
 * query and off the row, which is what the read path has always done: a surface renders its own
 * fallback, and that is a better answer than a wrong record. (`schema()` refuses the same entry,
 * deliberately — a shape that quietly lacked a key it promised would make its type a lie.)
 */
const planWith = (
	context: PlanContext,
	collection: string,
	spec: unknown,
	depth: number
): Effect.Effect<
	Readonly<{
		readonly with: Readonly<Record<string, AnyDBQueryConfig>> | undefined;
		readonly attachments: ReadonlyArray<Attachment>;
	}>,
	WhereCompileError | AccessControl.AccessDenied
> =>
	Effect.gen(function* () {
		const names = requestedRelations(spec);
		if (names.length === 0) return { with: undefined, attachments: [] };
		const fields = fieldsOf(context.definition, collection);
		const config: Record<string, AnyDBQueryConfig> = {};
		const attachments: Array<Attachment> = [];

		for (const name of names) {
			const entry = relationSpec(spec, name);
			const reference = fields[name]?.reference;
			if (reference !== undefined) {
				for (const target of reference.targets) {
					const key = referenceArmKey(name, target.tag);
					if (declaredRelation(context.relations, collection, key) === undefined) continue;
					yield* context.authorize(target.collection);
					const arm = yield* levelConfig(
						context,
						target.collection,
						referenceArmSpec(entry, target.tag),
						depth + 1
					);
					config[key] = arm.config;
					attachments.push({
						_tag: 'Reference',
						key,
						field: name,
						tag: target.tag,
						level: arm.level
					});
				}
				continue;
			}
			const declared = declaredRelation(context.relations, collection, name);
			if (declared === undefined) continue;
			const target = context.definition.relations.find(
				(candidate) => candidate.source === collection && candidate.name === name
			)?.target;
			if (target === undefined) continue;
			yield* context.authorize(target);
			const resolved = yield* levelConfig(context, target, entry, depth + 1);
			config[name] = resolved.config;
			attachments.push({
				_tag: 'Relation',
				key: name,
				many: declared.relationType === 'many',
				level: resolved.level
			});
		}
		return {
			with: Object.keys(config).length === 0 ? undefined : config,
			attachments
		};
	});

/**
 * Plans the `with` clause of a root read.
 *
 * The root's own columns, predicate, ordering and paging belong to the read that asked for them and
 * are composed by the caller; everything below the root is this.
 */
export const planRelations = (
	context: PlanContext,
	collection: string,
	spec: unknown,
	rootProjection?: ColumnSelection
): Effect.Effect<
	Readonly<{
		readonly with: Readonly<Record<string, AnyDBQueryConfig>> | undefined;
		readonly level: LevelPlan;
		readonly plan: RelationReadPlan;
	}>,
	WhereCompileError | AccessControl.AccessDenied
> =>
	Effect.map(planWith(context, collection, spec, 0), (planned) => {
		const fields = fieldsOf(context.definition, collection);
		const level: LevelPlan = {
			collection,
			referenceFields: decodableReferences(fields, undefined),
			attachments: planned.attachments,
			attached: new Set(planned.attachments.map((attachment) => attachment.key))
		};
		return {
			with: planned.with,
			level,
			plan: { root: level, rootProjection }
		};
	});

/** Narrows a row to its own columns, keeping the relations Drizzle attached to one side. */
const split = (
	row: Readonly<Record<string, unknown>>,
	level: LevelPlan
): Readonly<{
	readonly own: Record<string, unknown>;
	readonly related: Readonly<Record<string, unknown>>;
}> => {
	const own: Record<string, unknown> = {};
	const related: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(row)) {
		if (level.attached.has(name)) related[name] = value;
		else own[name] = value;
	}
	return { own, related };
};

/** Masks one level's row for this subject, against that level's own collection. */
export type MaskRow = (
	collection: string,
	row: Readonly<Record<string, Schema.Json>>
) => Readonly<Record<string, Schema.Json>>;

const asRow = (value: unknown): Readonly<Record<string, Schema.Json>> =>
	value as Readonly<Record<string, Schema.Json>>;

/**
 * The value one relation came back as.
 *
 * A relation crosses the wire as `json`, and whether that arrives parsed depends on the host's
 * database facility rather than on anything Bolt controls: a driver that decodes `json` hands back
 * an object, one that does not hands back its text. Drizzle's own mapper answers this for a session
 * it owns, and Bolt has no session — it renders the statement and the facility executes it — so the
 * one thing that mapper would have decided is decided here.
 */
const relationValue = (value: unknown): unknown =>
	typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

/**
 * Reads one relational row: its own columns first, then the relations hanging off it.
 *
 * The order is the one the batched read had. A field mask applies to the record's columns, so a
 * reference the mask removed carries no handle and nothing is hydrated onto it — masking still
 * decides whether a `with` produces anything, exactly as it did when a relation was a second read.
 */
const readRow = (
	row: Readonly<Record<string, unknown>>,
	level: LevelPlan,
	mask: MaskRow
): Readonly<Record<string, Schema.Json>> => {
	const { own, related } = split(row, level);
	const record: Record<string, Schema.Json> = {
		...mask(level.collection, asRow(decodeReferenceRow(own, level.referenceFields)))
	};
	for (const attachment of level.attachments) {
		const value = relationValue(related[attachment.key]);
		if (attachment._tag === 'Relation') {
			record[attachment.key] = attachment.many
				? readRelationalRows(Array.isArray(value) ? value : [], attachment.level, mask)
				: value == null
					? null
					: readRow(asRow(value), attachment.level, mask);
			continue;
		}
		// The handle `decodeReferenceRow` rebuilt, if the mask left it there and it names this arm.
		const handle = record[attachment.field];
		if (!isObject(handle) || handle['kind'] !== attachment.tag || typeof handle['id'] !== 'string')
			continue;
		record[attachment.field] = {
			kind: attachment.tag,
			id: handle['id'],
			// A related record the subject's own predicate declined is `null`, never a missing key: a
			// surface tests for absence, and `{}` reads as a record that exists and has lost its fields.
			record: value == null ? null : readRow(asRow(value), attachment.level, mask)
		};
	}
	return record;
};

/** Reads a relational result into the rows a collection query returns. */
export const readRelationalRows = (
	rows: ReadonlyArray<unknown>,
	level: LevelPlan,
	mask: MaskRow
): ReadonlyArray<Readonly<Record<string, Schema.Json>>> =>
	rows.map((row) => readRow(asRow(row), level, mask));

/** Applies authored root projection while retaining the already-hydrated relation attachments. */
export const projectRootRow = <Row extends Readonly<Record<string, unknown>>>(
	row: Row,
	projection: ColumnSelection | undefined,
	attached: ReadonlySet<string>
): Row => {
	if (projection === undefined) return row;
	const rootNames = Object.keys(row).filter((name) => !attached.has(name));
	const selected = new Set(selectedColumnNames(rootNames, projection));
	return Object.fromEntries(
		Object.entries(row).filter(([name]) => attached.has(name) || selected.has(name))
	) as Row;
};
