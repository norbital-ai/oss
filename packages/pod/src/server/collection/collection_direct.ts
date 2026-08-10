import { SYSTEM_COLUMN_NAMES } from '@norbital-ai/platform-utils/system/column_names';
import { ManifestContext } from '@norbital-ai/platform-utils/manifest/context';
import type { ManifestRelationship } from '@norbital-ai/platform-utils/manifest/types';
import type {
	CollectionFindFirstQuery,
	CollectionGroupedQuery,
	CollectionQuery
} from '$lib/authoring/workspace/db-api.js';
import {
	sql,
	type AnyDBQueryConfig,
	type AnyRelationsFilter,
	type DBQueryConfigWithComment
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { getColumns } from 'drizzle-orm';
import {
	andRelationsFilters,
	toRelationsFilter,
	toRelationsWith
} from '$lib/authoring/workspace/relations-filter.js';
import {
	dateRangeFilter,
	isDateRangeOperator,
	isKnownFieldOperator,
	rejectUnknownFieldOperator
} from './collection_operators.server.js';
import { isVectorDistanceOperator, vectorDistanceFilter } from './collection_vector.server.js';
import { typeGuard } from '@norbital-ai/std/schema';
import { isTemporalOperand, temporalKindForFieldKind } from '@norbital-ai/std/date';
import { z } from 'zod';
import { v7 } from 'uuid';
import { portableCollectionField } from '$lib/authoring/schema/table.js';
import { error } from './http_error.js';
import { requestI18nOrDefault } from '$lib/server/i18n.js';
import type { TNorbitalDBRecord } from './norbital_db_record.js';
import type { ManifestCollectionEntry } from '$lib/manifest/index.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';

const recordSchema = z.record(z.string(), z.unknown());
const minimalRelationLinkSchema = z.object({ norbital_id: z.string() }).strict();
const nestedRecordPayloadSchema = z
	.array(recordSchema.refine((record) => !typeGuard(minimalRelationLinkSchema, record)))
	.min(1);

type DrizzleCollectionQuery = {
	findMany: (config?: AnyDBQueryConfig) => Promise<Record<string, unknown>[]>;
	findFirst: (
		config?: DBQueryConfigWithComment<'one'>
	) => Promise<Record<string, unknown> | undefined>;
};

type QueryValidationInput = {
	readonly columns?: unknown;
	readonly where?: unknown;
	readonly orderBy?: unknown;
	readonly with?: unknown;
};

type FallbackQueryConfig = AnyDBQueryConfig | DBQueryConfigWithComment<'one'>;

export function requireTable(ctx: ProvisionedContext, collectionName: string): PgTable {
	const table = ctx.tableRegistry?.[collectionName];
	if (!table) {
		throw error(
			404,
			requestI18nOrDefault().t('pod.server.unknownCollection', { collection: collectionName })
		);
	}
	return table;
}

function readRelationalQueryApi(db: object): Record<string, DrizzleCollectionQuery> | undefined {
	return Reflect.get(db, 'query') as Record<string, DrizzleCollectionQuery> | undefined;
}

function knownColumnNames(ctx: ProvisionedContext, collection: string): string[] {
	return Object.keys(getColumns(requireTable(ctx, collection))).sort();
}

function validateColumnName(ctx: ProvisionedContext, collection: string, column: string): void {
	if (column in getColumns(requireTable(ctx, collection))) return;
	throw error(
		400,
		`Collection '${collection}' has no column '${column}'. Valid columns: ${knownColumnNames(ctx, collection).join(', ')}`
	);
}

function validateColumns(ctx: ProvisionedContext, collection: string, columns: unknown): void {
	if (!typeGuard(recordSchema, columns)) return;
	for (const column of Object.keys(columns)) validateColumnName(ctx, collection, column);
}

/**
 * One column's condition after compilation. `lifted` conditions carry an operator Drizzle has no
 * idea about (Pod's `dateRange()` operators), so they leave the column key entirely and become a
 * table-level filter; everything else stays exactly as it arrived.
 */
type CompiledCondition =
	| { readonly lifted: false; readonly condition: unknown }
	| { readonly lifted: true; readonly filter: AnyRelationsFilter };

/**
 * Compile one column's condition, validating every operator key on the way.
 *
 * Pod's `dateRange()` operators (`contains_date`, `overlaps`) have no Drizzle equivalent — they
 * compile to RAW SQL, which is a *table-level* filter key. Because the column is fixed for the
 * whole condition, a field-level `AND`/`OR`/`NOT` around them is exactly the table-level
 * `AND`/`OR`/`NOT` of the lifted parts, so nesting composes without a special case.
 */
function compileCondition(
	ctx: ProvisionedContext,
	collection: string,
	field: string,
	condition: unknown
): CompiledCondition {
	if (!typeGuard(recordSchema, condition)) return { lifted: false, condition };

	const residual: Record<string, unknown> = {};
	const lifted: AnyRelationsFilter[] = [];

	for (const [operator, operand] of Object.entries(condition)) {
		if (operator === 'AND' || operator === 'OR') {
			const group = compileConditionGroup(ctx, collection, field, operator, operand);
			if (group.lifted) lifted.push(group.filter);
			else residual[operator] = group.condition;
			continue;
		}
		if (operator === 'NOT') {
			const inner = compileCondition(ctx, collection, field, operand);
			if (inner.lifted) lifted.push(toRelationsFilter({ NOT: inner.filter }));
			else residual[operator] = inner.condition;
			continue;
		}
		if (isDateRangeOperator(operator)) {
			lifted.push(dateRangeFilter(field, operator, operand));
			continue;
		}
		if (isVectorDistanceOperator(operator)) {
			lifted.push(vectorDistanceFilter(field, operator, operand));
			continue;
		}
		if (!isKnownFieldOperator(operator)) {
			rejectUnknownFieldOperator(collection, field, operator);
		}
		residual[operator] = operand;
	}

	if (lifted.length === 0) return { lifted: false, condition };
	const parts = Object.keys(residual).length
		? [toRelationsFilter({ [field]: residual }), ...lifted]
		: lifted;
	return {
		lifted: true,
		filter: parts.length === 1 ? parts[0] : andRelationsFilters(...parts)
	};
}

/** A field-level `AND`/`OR` array; lifted to the table level only if a member had to be. */
function compileConditionGroup(
	ctx: ProvisionedContext,
	collection: string,
	field: string,
	operator: 'AND' | 'OR',
	operand: unknown
): CompiledCondition {
	if (!Array.isArray(operand)) return { lifted: false, condition: operand };
	const members = operand.map((entry) => compileCondition(ctx, collection, field, entry));
	if (!members.some((member) => member.lifted)) return { lifted: false, condition: operand };
	const filters = members.map((member) =>
		member.lifted ? member.filter : toRelationsFilter({ [field]: member.condition })
	);
	return { lifted: true, filter: toRelationsFilter({ [operator]: filters }) };
}

/**
 * Validate a raw `where` object and compile the operators Drizzle does not have.
 *
 * Validation and compilation are one traversal on purpose: a `where` that passes the checks is by
 * construction the `where` that is handed to Drizzle, so there is no shape the validator accepts
 * and the compiler never sees.
 */
function compileWhere(
	ctx: ProvisionedContext,
	collection: string,
	where: unknown
): AnyRelationsFilter | undefined {
	if (!typeGuard(recordSchema, where)) return where as AnyRelationsFilter | undefined;

	const residual: Record<string, unknown> = {};
	const lifted: AnyRelationsFilter[] = [];

	for (const [key, value] of Object.entries(where)) {
		if ((key === 'AND' || key === 'OR') && Array.isArray(value)) {
			residual[key] = value.map((filter) => compileWhere(ctx, collection, filter));
			continue;
		}
		if (key === 'NOT' && typeGuard(recordSchema, value)) {
			residual[key] = compileWhere(ctx, collection, value);
			continue;
		}
		if (key === 'RAW') {
			residual[key] = value;
			continue;
		}
		const relatedCollection = relatedCollectionFor(ctx, collection, key);
		if (relatedCollection) {
			if (typeof value === 'boolean') {
				residual[key] = value;
				continue;
			}
			if (typeGuard(recordSchema, value)) {
				residual[key] = compileWhere(ctx, relatedCollection, value);
				continue;
			}
			throw error(400, `Relation filter '${key}' must be a boolean or filter object.`);
		}
		validateColumnName(ctx, collection, key);
		validateTemporalCondition(ctx, collection, key, value);
		const compiled = compileCondition(ctx, collection, key, value);
		if (compiled.lifted) lifted.push(compiled.filter);
		else residual[key] = compiled.condition;
	}

	if (lifted.length === 0) return toRelationsFilter(residual);
	if (Object.keys(residual).length === 0) {
		return lifted.length === 1 ? lifted[0] : andRelationsFilters(...lifted);
	}
	return andRelationsFilters(toRelationsFilter(residual), ...lifted);
}

function validateTemporalCondition(
	ctx: ProvisionedContext,
	collection: string,
	field: string,
	condition: unknown
): void {
	const column = getColumns(requireTable(ctx, collection))[field];
	const kind = column
		? temporalKindForFieldKind(portableCollectionField(field, column).kind)
		: undefined;
	if (!kind || condition == null) return;
	const operands = typeGuard(recordSchema, condition)
		? Object.entries(condition).flatMap(([operator, operand]) =>
				operator === 'isNull' || operator === 'isNotNull' ? [] : [operand]
			)
		: [condition];
	if (!operands.every((operand) => isTemporalOperand(kind, operand))) {
		const expected =
			kind === 'instant'
				? 'a UTC ISO instant'
				: kind === 'clock-time'
					? 'a local clock time (HH:mm)'
					: 'a calendar date (YYYY-MM-DD)';
		throw error(400, `Filter '${field}' requires ${expected}.`);
	}
}

function relatedCollectionFor(
	ctx: ProvisionedContext,
	collection: string,
	relation: string
): string | undefined {
	const relationship = ctx.manifestCtx.findRelationship(relation);
	if (!relationship || (relationship.from !== collection && relationship.to !== collection)) {
		return undefined;
	}
	return relationship.from === collection ? relationship.to : relationship.from;
}

/** Nested `with` selections carry their own `where`, so they need the same compilation. */
function compileWith(ctx: ProvisionedContext, collection: string, withClause: unknown): unknown {
	if (!typeGuard(recordSchema, withClause)) return withClause;
	const compiled: Record<string, unknown> = {};
	for (const [relation, selection] of Object.entries(withClause)) {
		const relatedCollection = relatedCollectionFor(ctx, collection, relation);
		if (!relatedCollection) {
			const validRelations = ctx.manifestCtx
				.getRelationshipsForCollection(collection)
				.map(({ name }) => name)
				.sort();
			throw error(
				400,
				`Collection '${collection}' has no relation '${relation}'. Valid relations: ${validRelations.join(', ') || '(none)'}`
			);
		}
		if (!typeGuard(recordSchema, selection)) {
			compiled[relation] = selection;
			continue;
		}
		validateColumns(ctx, relatedCollection, selection.columns);
		validateColumns(ctx, relatedCollection, selection.orderBy);
		compiled[relation] = {
			...selection,
			...(selection.where === undefined
				? {}
				: { where: compileWhere(ctx, relatedCollection, selection.where) }),
			...(selection.with === undefined
				? {}
				: { with: compileWith(ctx, relatedCollection, selection.with) })
		};
	}
	return compiled;
}

type CompiledQuery = {
	readonly where: AnyRelationsFilter | undefined;
	readonly with: AnyDBQueryConfig['with'];
};

/** Validate a query and hand back the `where`/`with` that must be sent to Drizzle in its place. */
function compileQuery(
	ctx: ProvisionedContext,
	collection: string,
	query: QueryValidationInput
): CompiledQuery {
	validateColumns(ctx, collection, query.columns);
	validateColumns(ctx, collection, query.orderBy);
	return {
		where: compileWhere(ctx, collection, query.where),
		with: toRelationsWith(
			query.with === undefined
				? undefined
				: (compileWith(ctx, collection, query.with) as Record<string, unknown>)
		)
	};
}

async function asDynamicSelectRows(
	statement: PromiseLike<unknown[]>
): Promise<Record<string, unknown>[]> {
	const rows = await statement;
	return rows.filter((row): row is Record<string, unknown> => typeGuard(recordSchema, row));
}

export function firstRowAsRecord(rows: unknown[]): Record<string, unknown> | undefined {
	for (const row of rows) {
		if (typeGuard(recordSchema, row)) return row;
	}
	return undefined;
}

export function getCollectionQuery(
	ctx: ProvisionedContext,
	collection: string
): DrizzleCollectionQuery {
	const db = ctx.drizzleDb;
	if (!db) {
		throw error(500, 'Database is not configured');
	}
	const queryApi = readRelationalQueryApi(db);
	const finder = queryApi?.[collection];
	if (finder) return finder;

	const table = requireTable(ctx, collection);
	const selectRows = async (query?: FallbackQueryConfig, first = false) => {
		if (
			query?.where != null ||
			query?.with != null ||
			query?.extras != null ||
			query?.orderBy != null ||
			query?.comment != null
		) {
			throw error(
				500,
				`Collection '${collection}' has no relational query builder — relational query options would be silently ignored`
			);
		}
		let statement = db.select().from(table).$dynamic();
		const limit = first ? 1 : query && 'limit' in query ? query.limit : undefined;
		if (limit != null) {
			statement = statement.limit(limit);
		}
		if (query?.offset != null) {
			statement = statement.offset(query.offset);
		}
		return asDynamicSelectRows(statement);
	};
	return {
		findMany: (query) => selectRows(query),
		findFirst: async (query) => (await selectRows(query, true))[0]
	};
}

export function collectionMetadata(
	ctx: ProvisionedContext,
	collectionName: string
): ManifestCollectionEntry {
	const entry = ctx.manifestCtx.getCollection(collectionName);
	return { ...entry, collection_name: collectionName };
}

export function singularCollectionName(collectionName: string): string {
	if (collectionName.endsWith('ies')) {
		return `${collectionName.slice(0, -3)}y`;
	}
	if (collectionName.endsWith('s')) {
		return collectionName.slice(0, -1);
	}
	return collectionName;
}

export function extractRelationLinkIds(value: unknown): string[] | null {
	if (typeGuard(minimalRelationLinkSchema, value)) {
		return [value.norbital_id];
	}
	if (Array.isArray(value) && value.every((entry) => typeGuard(minimalRelationLinkSchema, entry))) {
		return value.map((item) => item.norbital_id);
	}
	return null;
}

function validateMutationRelation(
	ctx: ProvisionedContext,
	collection: string,
	relation: string,
	value: unknown
): void {
	const targetIds = extractRelationLinkIds(value);
	if (targetIds !== null) return;
	if (!typeGuard(nestedRecordPayloadSchema, value)) {
		throw error(
			400,
			`Relation '${relation}' on '${collection}' must be a record link or an array of nested records.`
		);
	}
	const rel = ctx.manifestCtx.getRelationship(relation);
	const relatedCollection = rel.from === collection ? rel.to : rel.from;
	for (const record of value) validateMutationPayload(ctx, relatedCollection, record);
}

function validateMutationPayload(
	ctx: ProvisionedContext,
	collection: string,
	payload: Record<string, unknown>
): void {
	const columns = getColumns(requireTable(ctx, collection));
	const relations = new Set(
		ctx.manifestCtx.getRelationshipsForCollection(collection).map(({ name }) => name)
	);
	for (const [field, value] of Object.entries(payload)) {
		if (field in columns) continue;
		if (relations.has(field)) {
			validateMutationRelation(ctx, collection, field, value);
			continue;
		}
		throw error(
			400,
			`Collection '${collection}' has no writable field or relation '${field}'. Valid fields: ${Object.keys(columns).sort().join(', ')}. Valid relations: ${[...relations].sort().join(', ') || '(none)'}`
		);
	}
}

function foreignKeyColumnForNestedChild(
	rel: ManifestRelationship,
	parentCollection: string
): string | null {
	const { otherCollection } = ManifestContext.getRelationshipDirection(rel, parentCollection);
	if (rel.from === otherCollection && rel.from_is_array) {
		return `${singularCollectionName(rel.to)}_id`;
	}
	if (rel.to === otherCollection && rel.to_is_array) {
		return `${singularCollectionName(rel.from)}_id`;
	}
	return null;
}

export function splitMutationPayload(
	ctx: ProvisionedContext,
	collectionName: string,
	payload: Record<string, unknown>
): {
	row: Record<string, unknown>;
	links: Record<string, string[]>;
	nested: Record<string, Record<string, unknown>[]>;
} {
	validateMutationPayload(ctx, collectionName, payload);
	const relationshipNames = new Set(
		ctx.manifestCtx.getRelationshipsForCollection(collectionName).map(({ name }) => name)
	);
	const row: Record<string, unknown> = {};
	const links: Record<string, string[]> = {};
	const nested: Record<string, Record<string, unknown>[]> = {};

	for (const [key, value] of Object.entries(payload)) {
		if (relationshipNames.has(key)) {
			const targetIds = extractRelationLinkIds(value);
			if (targetIds !== null) {
				links[key] = targetIds;
				continue;
			}
			if (typeGuard(nestedRecordPayloadSchema, value)) {
				nested[key] = value;
				continue;
			}
		}
		row[key] = value;
	}

	return { row, links, nested };
}

export function flattenWithOntoPayload(data: Record<string, unknown>): Record<string, unknown> {
	const { with: withInput, ...fields } = data;
	const payload = { ...fields };
	if (typeGuard(recordSchema, withInput)) {
		for (const [withKey, links] of Object.entries(withInput)) {
			payload[withKey] = links;
		}
	}
	return payload;
}

export function parseMutationInput(
	collection: string,
	kind: 'create' | 'update',
	input: Record<string, unknown>
): Record<string, unknown> {
	const workspace = getTenantWorkspace();
	const flattened = flattenWithOntoPayload(input);
	const registered = workspace.registered;
	const schema = registered.inputSchemas?.[collection]?.[kind];
	if (!schema) return flattened;
	const relationNames = new Set(
		Object.values(workspace.relationships).flatMap((relationship) =>
			relationship.from === collection || relationship.to === collection ? [relationship.name] : []
		)
	);
	const row: Record<string, unknown> = {};
	const relations: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(flattened)) {
		if (relationNames.has(field)) relations[field] = value;
		else row[field] = value;
	}
	const parsed = schema.parse(row);
	return typeGuard(recordSchema, parsed) ? { ...parsed, ...relations } : flattened;
}

export function mergeWhere(
	policy: AnyRelationsFilter | undefined,
	user: AnyRelationsFilter | undefined
): AnyRelationsFilter | undefined {
	if (policy === undefined && user === undefined) return undefined;
	if (policy === undefined) return user;
	if (user === undefined) return policy;
	return andRelationsFilters(policy, user);
}

export async function insertJunctionLinks(
	ctx: ProvisionedContext,
	collectionName: string,
	sourceId: string,
	links: Record<string, string[]>
): Promise<void> {
	const db = ctx.drizzleDb;
	if (!db) {
		throw error(500, 'Tenant database is not provisioned');
	}
	const sourceColumn = `${singularCollectionName(collectionName)}_id`;

	// stupidity:allow A6 -- junction writes share one transaction connection.
	for (const [relationshipName, targetIds] of Object.entries(links)) {
		if (targetIds.length === 0) continue;
		const junctionTable = ctx.tableRegistry?.[relationshipName];
		if (!junctionTable) continue;

		const cols = getColumns(junctionTable);
		if (!(sourceColumn in cols)) continue;

		const targetColumn = Object.keys(cols).find(
			(col) =>
				col.endsWith('_id') &&
				col !== sourceColumn &&
				col !== SYSTEM_COLUMN_NAMES.PKEY &&
				col !== SYSTEM_COLUMN_NAMES.APPROVAL_ID
		);
		if (!targetColumn) continue;

		await db.insert(junctionTable).values(
			targetIds.map((targetId) => ({
				[sourceColumn]: sourceId,
				[targetColumn]: targetId
			}))
		);
	}
}

export async function insertNestedRelationRecords(
	ctx: ProvisionedContext,
	collectionName: string,
	sourceId: string,
	nested: Record<string, Record<string, unknown>[]>
): Promise<void> {
	const db = ctx.drizzleDb;
	if (!db) {
		throw error(500, 'Tenant database is not provisioned');
	}

	for (const [relationshipName, records] of Object.entries(nested)) {
		if (records.length === 0) continue;
		const rel = ctx.manifestCtx.getRelationship(relationshipName);
		const { otherCollection } = ManifestContext.getRelationshipDirection(rel, collectionName);
		const childTable = requireTable(ctx, otherCollection);
		const foreignKeyColumn = foreignKeyColumnForNestedChild(rel, collectionName);
		const now = new Date().toISOString();

		// Prepare every child row up front, then insert in multi-row batches —
		// one INSERT per child is a full DB round-trip each, which dominates
		// wall-clock for large payloads (e.g. a payroll run creating hundreds
		// of payslips against a remote Postgres).
		const prepared = records.map((record) => {
			const {
				row: childRow,
				links: childLinks,
				nested: childNested
			} = splitMutationPayload(ctx, otherCollection, record);
			const childId =
				typeof childRow[SYSTEM_COLUMN_NAMES.PKEY] === 'string'
					? childRow[SYSTEM_COLUMN_NAMES.PKEY]
					: v7();

			const values: Record<string, unknown> = {
				...childRow,
				[SYSTEM_COLUMN_NAMES.PKEY]: childId,
				[SYSTEM_COLUMN_NAMES.CREATED_AT]: childRow[SYSTEM_COLUMN_NAMES.CREATED_AT] ?? now,
				[SYSTEM_COLUMN_NAMES.UPDATED_AT]: childRow[SYSTEM_COLUMN_NAMES.UPDATED_AT] ?? now
			};
			if (foreignKeyColumn && values[foreignKeyColumn] == null) {
				values[foreignKeyColumn] = sourceId;
			}
			return { childId: String(childId), values, childLinks, childNested };
		});

		// stupidity:allow A6 -- bounded batches are deliberately committed in statement order.
		for (let i = 0; i < prepared.length; i += NESTED_INSERT_BATCH_SIZE) {
			const batch = prepared.slice(i, i + NESTED_INSERT_BATCH_SIZE);
			await db.insert(childTable).values(batch.map((child) => child.values));
		}

		// stupidity:allow A6 -- recursive relationship writes depend on each child insert.
		for (const child of prepared) {
			await persistMutationRelationships(
				ctx,
				otherCollection,
				child.childId,
				child.childLinks,
				child.childNested
			);
		}
	}
}

/** Rows per multi-row INSERT — bounds statement size for wide JSONB rows. */
const NESTED_INSERT_BATCH_SIZE = 200;

export async function persistMutationRelationships(
	ctx: ProvisionedContext,
	collectionName: string,
	sourceId: string,
	links: Record<string, string[]>,
	nested: Record<string, Record<string, unknown>[]>
): Promise<void> {
	if (!sourceId) return;
	if (Object.keys(links).length > 0) {
		await insertJunctionLinks(ctx, collectionName, sourceId, links);
	}
	if (Object.keys(nested).length > 0) {
		await insertNestedRelationRecords(ctx, collectionName, sourceId, nested);
	}
}

// ── Direct query API (no policy, no hooks, no audit) ──────────────

export async function directFindMany(
	ctx: ProvisionedContext,
	collection: string,
	query: CollectionQuery
): Promise<Record<string, unknown>[]> {
	const compiled = compileQuery(ctx, collection, query);
	return getCollectionQuery(ctx, collection).findMany({
		columns: query.columns,
		with: compiled.with,
		where: compiled.where,
		extras: query.extras,
		orderBy: query.orderBy,
		limit: query.limit,
		offset: query.offset,
		comment: query.comment
	});
}

export async function directRelationalFindFirst(
	ctx: ProvisionedContext,
	collection: string,
	query: CollectionFindFirstQuery = {}
): Promise<Record<string, unknown> | undefined> {
	const compiled = compileQuery(ctx, collection, query);
	return getCollectionQuery(ctx, collection).findFirst({
		columns: query.columns,
		with: compiled.with,
		where: compiled.where,
		extras: query.extras,
		orderBy: query.orderBy,
		offset: query.offset,
		comment: query.comment
	});
}

export async function directFindFirst(
	ctx: ProvisionedContext,
	collection: string,
	recordId: string
): Promise<TNorbitalDBRecord> {
	const rows = await getCollectionQuery(ctx, collection).findMany({
		where: toRelationsFilter({ [SYSTEM_COLUMN_NAMES.PKEY]: recordId }),
		limit: 1
	});
	const record = rows[0];
	if (!record) {
		throw error(404, requestI18nOrDefault().t('pod.server.recordNotFound', { id: recordId }));
	}
	return record as TNorbitalDBRecord;
}

export async function directCount(
	ctx: ProvisionedContext,
	collection: string,
	query: CollectionQuery
): Promise<number> {
	const compiled = compileQuery(ctx, collection, query);
	const rows = await getCollectionQuery(ctx, collection).findMany({
		columns: {},
		extras: {
			__norbital_count: sql<number>`count(*) over()`.as('__norbital_count')
		},
		where: compiled.where,
		limit: 1
	});
	const count = rows[0]?.__norbital_count;
	return typeof count === 'number' ? count : Number(count ?? 0);
}

export async function directFindGrouped(
	ctx: ProvisionedContext,
	collection: string,
	query: CollectionGroupedQuery
): Promise<Record<string, Record<string, unknown>[]>> {
	const compiled = compileQuery(ctx, collection, query);
	validateColumnName(ctx, collection, query.group.by);
	const finder = getCollectionQuery(ctx, collection);

	const laneKeys = query.group.lanes?.length
		? [...new Set(query.group.lanes)]
		: [
				...new Set(
					(
						await finder.findMany({
							columns: { [query.group.by]: true },
							where: compiled.where,
							limit: query.limit
						})
					)
						.map((row) => row[query.group.by])
						.filter((value) => value != null)
				)
			];

	const groupedEntries = await Promise.all(
		laneKeys.map(async (laneKey) => {
			const laneWhere = mergeWhere(
				compiled.where,
				toRelationsFilter({ [query.group.by]: laneKey })
			);
			const rows = await finder.findMany({
				columns: query.columns,
				with: compiled.with,
				where: laneWhere,
				extras: query.extras,
				orderBy: query.orderBy,
				limit: query.limit,
				offset: query.offset,
				comment: query.comment
			});
			return [String(laneKey), rows] as const;
		})
	);

	return Object.fromEntries(groupedEntries);
}

// ── Direct record API (no policy, no hooks, no audit) ─────────────

export async function directInsert(
	ctx: ProvisionedContext,
	collection: string,
	input: Record<string, unknown>
): Promise<Record<string, unknown>> {
	const { row, links, nested } = splitMutationPayload(ctx, collection, input);
	const now = new Date().toISOString();
	const table = requireTable(ctx, collection);
	const db = ctx.drizzleDb;
	if (!db) {
		throw error(500, 'Tenant database is not provisioned');
	}

	const created = firstRowAsRecord(
		await db
			.insert(table)
			.values({
				...row,
				[SYSTEM_COLUMN_NAMES.CREATED_AT]: row[SYSTEM_COLUMN_NAMES.CREATED_AT] ?? now,
				[SYSTEM_COLUMN_NAMES.UPDATED_AT]: row[SYSTEM_COLUMN_NAMES.UPDATED_AT] ?? now
			})
			.returning()
	);

	if (!created) {
		throw error(500, `Failed to create record in "${collection}"`);
	}

	const sourceId = String(created[SYSTEM_COLUMN_NAMES.PKEY] ?? '');
	await persistMutationRelationships(ctx, collection, sourceId, links, nested);

	return created;
}

export async function directUpdate(
	ctx: ProvisionedContext,
	collection: string,
	recordId: string,
	input: Record<string, unknown>
): Promise<Record<string, unknown>> {
	const { row, links, nested } = splitMutationPayload(ctx, collection, input);
	const table = requireTable(ctx, collection);
	const cols = getColumns(table);
	const db = ctx.drizzleDb;
	if (!db) {
		throw error(500, 'Tenant database is not provisioned');
	}
	const { eq } = await import('drizzle-orm');

	const updated = firstRowAsRecord(
		await db
			.update(table)
			.set({
				...row,
				[SYSTEM_COLUMN_NAMES.UPDATED_AT]: new Date().toISOString()
			})
			.where(eq(cols[SYSTEM_COLUMN_NAMES.PKEY], recordId))
			.returning()
	);

	if (!updated) {
		throw error(404, requestI18nOrDefault().t('pod.server.recordNotFound', { id: recordId }));
	}

	await persistMutationRelationships(ctx, collection, recordId, links, nested);

	return updated;
}

export async function directDelete(
	ctx: ProvisionedContext,
	collection: string,
	recordId: string
): Promise<void> {
	const table = requireTable(ctx, collection);
	const cols = getColumns(table);
	const db = ctx.drizzleDb;
	if (!db) {
		throw error(500, 'Tenant database is not provisioned');
	}
	const { eq } = await import('drizzle-orm');

	await db.delete(table).where(eq(cols[SYSTEM_COLUMN_NAMES.PKEY], recordId));
}
