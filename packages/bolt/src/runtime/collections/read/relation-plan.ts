import { and, type AnyDBQueryConfig, type AnyRelations, type SQL } from 'drizzle-orm';
import { Effect, Result, Schema } from 'effect';
import type { FieldDefinition, WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import {
	boundedCount,
	compileCollectionPredicate,
	compileOrderTerms,
	DEFAULT_RELATION_PREFIX_LIMIT,
	MAX_RELATION_DEPTH,
	nestedWith,
	orderingExpressions,
	referenceArmSpec,
	relationSpec,
	requestedColumns,
	requestedRelations,
	selectedColumnNames,
	WhereCompileError,
	type ColumnSelection,
	type OrderTerm
} from '#lib/runtime/access/effective-plan.js';
import { referenceArmKey } from '#lib/runtime/schema/relational-schema.js';
import { decodeReferenceRow } from '#lib/runtime/collections/references.js';
import type { QueryError } from '#lib/runtime/collections/collections.contract.js';
import type { RelationalBuilder } from '#lib/runtime/persistence.js';

const levelAlias = (depth: number): string => `d${depth}`;
export const ROOT_ALIAS = levelAlias(0);

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

type LevelPlan = Readonly<{
	readonly collection: string;
	readonly referenceFields: Readonly<Record<string, FieldDefinition>>;
	readonly attachments: ReadonlyArray<Attachment>;
	readonly attached: ReadonlySet<string>;
}>;

type RelationReadPlan = Readonly<{
	readonly root: LevelPlan;
	readonly rootProjection: ColumnSelection | undefined;
}>;

export type PlanContext = Readonly<{
	readonly definition: WorkspaceDefinition;
	readonly relations: AnyRelations;
	readonly authorize: (collection: string) => Effect.Effect<void, AccessControl.AccessDenied>;
	readonly predicate: (collection: string) => AccessControl.RowPredicate;
}>;

const isObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const fieldsOf = (
	definition: WorkspaceDefinition,
	collection: string
): Readonly<Record<string, FieldDefinition>> =>
	definition.collections.find((entry) => entry.name === collection)?.fields ?? {};

const physicalSelection = (
	fields: Readonly<Record<string, FieldDefinition>>,
	columns: ColumnSelection | undefined
): Readonly<Record<string, true>> | undefined => {
	if (columns === undefined) return undefined;
	const selection: Record<string, true> = {};
	for (const name of selectedColumnNames(
		[...SYSTEM_COLUMN_NAMES, ...Object.keys(fields)],
		columns
	)) {
		const reference = fields[name]?.reference;
		if (reference === undefined) selection[name] = true;
		else for (const target of reference.targets) selection[target.storageColumn] = true;
	}
	return selection;
};

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

const levelWhere = (
	context: PlanContext,
	collection: string,
	spec: unknown,
	depth: number
): Result.Result<SQL, WhereCompileError> => {
	const visibility = AccessControl.predicateExpression(context.predicate(collection));
	const narrowing = isObject(spec) ? spec['where'] : undefined;
	if (narrowing === undefined) return Result.succeed(visibility);
	const compiled = compileCollectionPredicate({
		definition: context.definition,
		collection,
		where: narrowing,
		qualifier: levelAlias(depth),
		node: `query.with.${collection}.where`
	});
	return Result.isFailure(compiled)
		? Result.fail(compiled.failure)
		: Result.succeed(and(visibility, compiled.success.sql) ?? visibility);
};

const refuse = (
	collection: string,
	field: string,
	message: string,
	extras: Readonly<{ readonly node?: string; readonly relationship?: string }> = {}
): Effect.Effect<never, WhereCompileError> =>
	Effect.fail(new WhereCompileError({ collection, field, message, ...extras }));

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
			return yield* refuse(
				collection,
				'columns',
				`columns names no column of ${collection}; a related record has to select something.`
			);
		}
		const where = levelWhere(context, collection, spec, depth);
		if (Result.isFailure(where)) return yield* where.failure;
		const ordering = compileOrderTerms(
			context.definition,
			collection,
			isObject(spec) ? spec['orderBy'] : undefined
		);
		const limit =
			boundedCount(isObject(spec) ? spec['limit'] : undefined) ?? DEFAULT_RELATION_PREFIX_LIMIT;
		const offset = boundedCount(isObject(spec) ? spec['offset'] : undefined);
		return {
			// Drizzle's RelationsFilter type omits the RAW key that relationsFilterToSQL reads first.
			config: {
				...(selection === undefined ? {} : { columns: selection }),
				where: { RAW: where.success },
				orderBy: (table: unknown) => [...orderingExpressions(table, ordering)],
				limit,
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

const declaredRelation = (
	relations: AnyRelations,
	collection: string,
	key: string
): Readonly<{ readonly relationType: 'one' | 'many' }> | undefined => {
	const relation = relations[collection]?.relations[key];
	return relation === undefined ? undefined : { relationType: relation.relationType };
};

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
		if (depth >= MAX_RELATION_DEPTH)
			return yield* refuse(
				collection,
				'with',
				`with exceeds the maximum relationship depth ${MAX_RELATION_DEPTH}.`
			);
		const fields = fieldsOf(context.definition, collection);
		const config: Record<string, AnyDBQueryConfig> = {};
		const attachments: Array<Attachment> = [];
		for (const name of names) {
			const entry = relationSpec(spec, name);
			const reference = fields[name]?.reference;
			if (reference !== undefined) {
				for (const target of reference.targets) {
					const key = referenceArmKey(name, target.tag);
					if (declaredRelation(context.relations, collection, key) === undefined)
						return yield* refuse(
							collection,
							name,
							`Compiled reference arm ${collection}.${key} has no relational descriptor.`,
							{ node: `with.${name}.${target.tag}`, relationship: `${collection}.${key}` }
						);
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
			const relationship = AccessControl.resolveCompiledRelationship(
				context.definition.relations,
				collection,
				name,
				`with.${name}`
			);
			if (Result.isFailure(relationship))
				return yield* refuse(collection, name, relationship.failure.message, {
					node: relationship.failure.node,
					relationship: relationship.failure.relationship ?? `${collection}.${name}`
				});
			const declared = declaredRelation(context.relations, collection, name);
			if (declared === undefined)
				return yield* refuse(
					collection,
					name,
					`Compiled relationship ${relationship.success.identity} has no relational descriptor.`,
					{ node: `with.${name}`, relationship: relationship.success.identity }
				);
			if (declared.relationType !== relationship.success.definition.cardinality)
				return yield* refuse(
					collection,
					name,
					`Compiled relationship ${relationship.success.identity} disagrees with its relational cardinality.`,
					{ node: `with.${name}`, relationship: relationship.success.identity }
				);
			const target = relationship.success.definition.target;
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
		return { with: Object.keys(config).length === 0 ? undefined : config, attachments };
	});

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
		const level: LevelPlan = {
			collection,
			referenceFields: decodableReferences(fieldsOf(context.definition, collection), undefined),
			attachments: planned.attachments,
			attached: new Set(planned.attachments.map((attachment) => attachment.key))
		};
		return { with: planned.with, level, plan: { root: level, rootProjection } };
	});

export type MaskRow = (
	collection: string,
	row: Readonly<Record<string, Schema.Json>>
) => Readonly<Record<string, Schema.Json>>;

const asRow = (value: unknown): Readonly<Record<string, Schema.Json>> =>
	value as Readonly<Record<string, Schema.Json>>;

const relationValue = (value: unknown): unknown =>
	typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

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
		const handle = record[attachment.field];
		if (!isObject(handle) || handle['kind'] !== attachment.tag || typeof handle['id'] !== 'string')
			continue;
		record[attachment.field] = {
			kind: attachment.tag,
			id: handle['id'],
			record: value == null ? null : readRow(asRow(value), attachment.level, mask)
		};
	}
	return record;
};

export const readRelationalRows = (
	rows: ReadonlyArray<unknown>,
	level: LevelPlan,
	mask: MaskRow
): ReadonlyArray<Readonly<Record<string, Schema.Json>>> =>
	rows.map((row) => readRow(asRow(row), level, mask));

export const projectRootRow = <Row extends Readonly<Record<string, unknown>>>(
	row: Row,
	projection: ColumnSelection | undefined,
	attached: ReadonlySet<string>
): Row => {
	if (projection === undefined) return row;
	const selected = new Set(
		selectedColumnNames(
			Object.keys(row).filter((name) => !attached.has(name)),
			projection
		)
	);
	return Object.fromEntries(
		Object.entries(row).filter(([name]) => attached.has(name) || selected.has(name))
	) as Row;
};

type RelationalReadConfig = Readonly<{
	readonly where: SQL;
	readonly ordering: ReadonlyArray<OrderTerm>;
	readonly searchOrdering?: SQL | undefined;
	readonly limit: number;
	readonly with: unknown;
	readonly columns?: Readonly<Record<string, boolean>> | undefined;
}>;

type RelationalReadPorts = Readonly<{
	readonly builders: Readonly<Record<string, RelationalBuilder | undefined>>;
	readonly planContext: PlanContext;
	readonly mask: MaskRow;
	readonly execute: (
		statement: ReturnType<RelationalBuilder['findMany']>
	) => Effect.Effect<ReadonlyArray<unknown>, QueryError>;
}>;

export const readRelational = Effect.fn('Collections.readRelational')(function* (
	ports: RelationalReadPorts,
	collection: string,
	config: RelationalReadConfig
) {
	const builder = ports.builders[collection];
	if (builder === undefined) {
		return yield* new WhereCompileError({
			collection,
			field: 'collection',
			message: `'${collection}' has no relational descriptor in this workspace.`
		});
	}
	const planned = yield* planRelations(ports.planContext, collection, config.with, config.columns);
	const query = builder.findMany({
		where: { RAW: config.where },
		orderBy: (table: unknown) => [
			...(config.searchOrdering === undefined ? [] : [config.searchOrdering]),
			...orderingExpressions(table, config.ordering)
		],
		limit: config.limit,
		...(planned.with === undefined ? {} : { with: planned.with })
	} as unknown as AnyDBQueryConfig);
	const rawRows = yield* ports.execute(query);
	const source = rawRows.map((row) => row as Readonly<Record<string, unknown>>);
	const rows = rawRows
		.map(
			(row) =>
				readRelationalRows(
					[row as Readonly<Record<string, unknown>>],
					planned.level,
					ports.mask
				)[0] ?? {}
		)
		.map((row) => projectRootRow(row, planned.plan.rootProjection, planned.plan.root.attached));
	return { rows, source };
});
