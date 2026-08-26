import { deriveRecordId } from '#lib/runtime/derive-record-id.js';
import {
	and,
	asc,
	count as countRows,
	desc,
	eq,
	getColumns,
	inArray,
	isNotNull,
	notInArray,
	sql,
	type SQL,
	type SQLChunk
} from 'drizzle-orm';
import { alias as tableAlias, pgTable, text, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { Cause, Clock, Context, Effect, Layer, Number as ENumber, Result, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as Approvals from '#lib/runtime/approvals/approvals.js';
import { ApprovalConflict } from '#lib/runtime/approvals/approvals.js';
import * as Database from '#lib/runtime/facilities/database.js';
import * as SyncWake from '#lib/runtime/sync/wake.js';
import { AI, Files } from '#lib/runtime/facilities/services.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import * as Automations from '#lib/runtime/automations/automations.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import { Subject } from '#lib/runtime/identity/identity.js';
import { automationSubject } from '#lib/runtime/identity/static-identity.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { searchableColumns } from '#lib/authoring/model-introspection.js';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import type {
	CollectionDefinition,
	FieldDefinition,
	RelationDefinition,
	WorkspaceDefinition
} from '#lib/authoring/workspace-schema.js';
import {
	eventRecord,
	outboxEntriesFor,
	sendSubscriptions,
	watchesOperation,
	type SendSubscription
} from '#lib/runtime/integrations/outbox.js';
import {
	compileOrderTerms,
	compileWhere,
	makeWhereContext,
	whereExpression,
	WhereCompileError,
	type WhereContext
} from '#lib/runtime/collections/where.js';
import { compileCollectionCursorSeek } from '#lib/runtime/collections/cursor.js';
export { encodeCollectionCursor } from '#lib/runtime/collections/cursor.js';
import {
	CollectionAction,
	MutationPhaseFailure,
	PendingApproval,
	Service,
	mutationPhaseFailure,
	Predicate,
	type BatchMutationError,
	type CollectionHistorySnapshot,
	type Interface,
	type MutationError,
	type MutationInput,
	type MutationPhase,
	type NearestInput,
	type QueryError,
	type QueryInput,
	type ResumeError
} from './collections.contract.js';
export {
	MutationPhaseFailure,
	PendingApproval,
	Service,
	mutationPhaseFailure
} from './collections.contract.js';
export type {
	Interface,
	BatchMutationError,
	CollectionHistorySnapshot,
	MutationError,
	QueryError,
	ResumeError
} from './collections.contract.js';
import { attachRelations } from '#lib/runtime/collections/prefetch.js';
import {
	decodeReferenceRow,
	encodeReferenceValues,
	referenceValueProblem
} from '#lib/runtime/collections/references.js';
import {
	afterMillisOf,
	AuthoredRuntimeService,
	inferOp,
	makeAuthoringApi,
	MAX_STRUCTURED_INFERENCE_OUTPUT_TOKENS,
	nearestInputOf,
	objectRowsOf,
	runAuthoredHandler,
	runAutomationOp,
	inferenceTurnContent,
	type AuthoredCollectionOps,
	type AuthoredCollectionHookModule,
	type RuntimeAuthoringApi
} from '#lib/runtime/collections/authored.js';
import { AuthoredRefusal, refusalAt, type RefusalSite } from '#lib/authoring/refusal.js';
import * as InvocationBudget from '#lib/runtime/budget.js';
import { approvalFlowDescriptor } from '#lib/authoring/approval-flow.js';
import { approvalStepId } from '#lib/authoring/policy-introspection.js';
import {
	aliased,
	composer,
	executeBuilt,
	lessThanOrEqual,
	rowJson,
	toStatement,
	transactionSql,
	vectorDistance
} from '#lib/runtime/persistence.js';

const {
	bolt_collection_history: collectionHistoryTable,
	bolt_integration_outbox: integrationOutboxTable
} = SYSTEM_MODEL_TABLES;

/**
 * A query-only Drizzle descriptor for one runtime collection.
 *
 * `WorkspaceDefinition` deliberately carries portable field metadata rather than Drizzle builders.
 * Reads need column names, not DDL types, so every physical column is described as text here: the
 * descriptor emits quoted identifiers and bound values but never creates or migrates a table.
 * Logical references are omitted and their generated physical UUID arms are included instead.
 */
const collectionQueryTable = (name: string, fields: Readonly<Record<string, FieldDefinition>>) => {
	const names = new Set<string>(SYSTEM_COLUMN_NAMES);
	for (const [field, definition] of Object.entries(fields)) {
		if (definition.reference === undefined) names.add(field);
		else for (const target of definition.reference.targets) names.add(target.storageColumn);
	}
	const columns = Object.fromEntries([...names].map((column) => [column, text()]));
	// repository-health:allow DDL1 -- query-only Drizzle descriptor; this call emits no DDL.
	return pgTable(name, columns);
};

const columnsOf = (table: ReturnType<typeof collectionQueryTable>) =>
	getColumns(table) as Readonly<Record<string, AnyPgColumn>>;

type CompiledQuery = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<Schema.Json>;
}>;

/** Lifts only this module's closed where/search/cursor compiler output into Drizzle. */
const queryFragment = (query: CompiledQuery): SQL => {
	const chunks: Array<SQLChunk> = [];
	let offset = 0;
	for (const match of query.sql.matchAll(/\$(\d+)/g)) {
		chunks.push(sql.raw(query.sql.slice(offset, match.index)));
		chunks.push(sql.param(query.parameters[Number(match[1]) - 1] ?? null));
		offset = match.index + match[0].length;
	}
	chunks.push(sql.raw(query.sql.slice(offset)));
	return sql.join(chunks, sql.empty());
};
const JsonObject = Schema.Record(Schema.String, Schema.Json);
const PolicyAuthorizationMarker = Schema.Struct({
	id: Schema.NonEmptyString,
	live: Schema.Literal(true)
});
const isPolicyAuthorizationMarker = Schema.is(PolicyAuthorizationMarker);
const PolicyApprovalMarker = Schema.Struct({
	id: Schema.NonEmptyString,
	flow: Schema.Literal(true),
	superceded_by: Schema.Array(Schema.NonEmptyString)
});
const isPolicyApprovalMarker = Schema.is(PolicyApprovalMarker);
const ResolvedApprovalConfiguration = Schema.Struct({
	id: Schema.NonEmptyString,
	steps: Schema.Array(
		Schema.Struct({
			id: Schema.NonEmptyString,
			approvers: Schema.Array(Schema.NonEmptyString).check(Schema.isNonEmpty())
		})
	).check(Schema.isNonEmpty()),
	superceded_by: Schema.Array(Schema.NonEmptyString)
});
const isResolvedApprovalConfiguration = Schema.is(ResolvedApprovalConfiguration);
const APPROVAL_READ_METHODS = ['findMany', 'findFirst', 'count', 'findNearest'] as const;

/**
 * Removes every mutation method from the live authoring api before an approval predicate receives it.
 *
 * The generated type already exposes only `db.query`; this is its runtime twin. Reusing the query
 * proxy directly would be insufficient because it deliberately points at the same collection object
 * hooks use, including `create` and `update`. Each collection wrapper below is frozen and copies only
 * the four read operations, so untyped authored JavaScript cannot turn a policy decision into a write.
 */
const policyDecisionApi = (api: RuntimeAuthoringApi, subject: Identity.Subject): unknown => {
	const query = Reflect.get(api.db, 'query');
	const readOnlyTarget: Record<string, unknown> = Object.create(null);
	const readOnlyQuery = new Proxy(readOnlyTarget, {
		get: (_target, collection) => {
			if (typeof collection !== 'string' || typeof query !== 'object' || query === null)
				return undefined;
			const collectionApi = Reflect.get(query, collection);
			if (typeof collectionApi !== 'object' || collectionApi === null) return undefined;
			return Object.freeze(
				Object.fromEntries(
					APPROVAL_READ_METHODS.flatMap((method) => {
						const operation = Reflect.get(collectionApi, method);
						return typeof operation === 'function' ? [[method, operation] as const] : [];
					})
				)
			);
		}
	});
	return Object.freeze({
		db: Object.freeze({ query: readOnlyQuery }),
		requestor: Object.freeze({
			id: subject.userId,
			userId: subject.userId,
			tenantId: subject.tenantId,
			...(subject.email === undefined ? {} : { email: subject.email }),
			...(subject.teamPath[0] === undefined ? {} : { team: subject.teamPath[0] }),
			teamPath: Object.freeze([...subject.teamPath]),
			admin: subject.admin === true
		})
	});
};
const PersistedCollectionHistoryRow = Schema.Struct({
	sequence: Schema.Number,
	created_at: Schema.String,
	snapshot: Schema.NullOr(JsonObject)
});
type PersistedCollectionHistoryRow = typeof PersistedCollectionHistoryRow.Type;
/** The `JsonObject` predicate, built once: it is consulted for every row the facility hands back. */
const isJsonObject = Schema.is(JsonObject);

/**
 * Drizzle's connectionless `toSQL()` does not run a JSONB column's driver encoder.
 *
 * The facility receives plain parameters rather than a Drizzle session, so JSON values must cross
 * this boundary as JSON text. PostgreSQL then parses the bound text using the target JSONB column's
 * type. SQL null stays null; a JSON null is not used by these bookkeeping rows.
 */
const encodedJsonb = (value: Exclude<Schema.Json, null>): string => JSON.stringify(value);

/**
 * Rebuilds full record revisions from the patch log stored by collection mutations.
 *
 * A create stores the initial values, while each update stores only the fields that changed. The
 * browser history contract is deliberately different: every entry is a complete record snapshot
 * with an effective interval. Folding oldest-first is therefore part of the persistence boundary,
 * not a presentation concern a form should have to rediscover.
 */
const collectionHistorySnapshots = (
	rows: ReadonlyArray<PersistedCollectionHistoryRow>
): ReadonlyArray<CollectionHistorySnapshot> => {
	const accumulated: Record<string, Schema.Json> = {};
	return rows.map((row, index) => {
		if (row.snapshot !== null) Object.assign(accumulated, row.snapshot);
		return {
			values: { ...accumulated },
			validFrom: row.created_at,
			validTo: rows[index + 1]?.created_at ?? null,
			version: row.sequence
		};
	});
};

/** Stable structural identity for approval configurations authored with different key order. */
const approvalFingerprint = (value: Schema.Json | undefined): string => {
	if (value === undefined) return 'default';
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(approvalFingerprint).join(',')}]`;
	return `{${Object.entries(value)
		.toSorted(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${approvalFingerprint(entry)}`)
		.join(',')}}`;
};

/**
 * Structural identity of the concrete route a reviewer will actually follow.
 *
 * Configuration and stage ids identify the policy coordinate that produced a route; they are not
 * part of the route itself. An atomic graph may legitimately contain, for example, a create and an
 * update governed by the same HR-manager flow. Comparing their derived ids rejected that graph even
 * though every record resolved to the same approvers and supersede boundary. Policy-coordinate ids
 * remain in `executionInvariants` below, so changing either grant still invalidates a pending review.
 */
const approvalRouteFingerprint = (value: Schema.Json | undefined): string => {
	if (!isResolvedApprovalConfiguration(value)) return approvalFingerprint(value);
	return approvalFingerprint({
		steps: value.steps.map((step) => ({ approvers: step.approvers })),
		superceded_by: value.superceded_by
	});
};

/**
 * How many related rows one prefetch may load.
 *
 * A page of parents fans out to at most this many children per relation. It is deliberately far
 * above a page size and still bounded — an unbounded prefetch would let one screen pull a whole
 * collection into memory.
 */
const PREFETCH_LIMIT = 5000;
const DeclarativeReviewRow = Schema.Struct({
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	snapshot: Schema.String
});
const DeclarativeReviewRelationship = Schema.Struct({
	name: Schema.NonEmptyString,
	parentCollection: Schema.NonEmptyString,
	parentColumn: Schema.NonEmptyString,
	childCollection: Schema.NonEmptyString,
	childColumn: Schema.NonEmptyString,
	cascade: Schema.Boolean,
	parentId: Schema.NonEmptyString,
	snapshot: Schema.String
});
const DeclarativeReview = Schema.Struct({
	version: Schema.Literal(1),
	rows: Schema.Array(DeclarativeReviewRow),
	relationships: Schema.Array(DeclarativeReviewRelationship),
	policyFingerprint: Schema.String
});
type DeclarativeReview = typeof DeclarativeReview.Type;
const CollectionOperation = Schema.Struct({
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	values: Schema.Record(Schema.String, Schema.Json),
	action: CollectionAction,
	subject: Subject,
	mode: Schema.optionalKey(Schema.Literal('declarative')),
	review: Schema.optionalKey(DeclarativeReview)
});

/** Internal preparation signal: the whole root graph must be stored as one approval operation. */
class GraphApprovalRequired extends Schema.TaggedError<GraphApprovalRequired>()(
	'Bolt.Collections.GraphApprovalRequired',
	{
		collection: Schema.NonEmptyString,
		action: CollectionAction,
		approval: Schema.optionalKey(Schema.Json),
		review: DeclarativeReview
	}
) {}

export const unwrapMutationPhase = (cause: unknown): unknown =>
	cause instanceof MutationPhaseFailure ? cause.cause : cause;

/** Owns identifier safety, predicate compilation, and parameter rebasing. */
const CollectionSql = {
	quoteIdentifier: (name: string): string => `"${name.replaceAll('"', '""')}"`,
	offsetParameters: (sql: string, offset: number): string =>
		sql.replaceAll(/\$(\d+)/g, (_token, index: string) => `$${Number(index) + offset}`),
	compilePredicate: (predicate: Predicate, offset = 0): CompiledQuery =>
		Predicate.match(predicate, {
			Equal: ({ field, value }) => ({
				sql: `${CollectionSql.quoteIdentifier(field)} = $${offset + 1}`,
				parameters: [value]
			}),
			NotEqual: ({ field, value }) => ({
				sql: `${CollectionSql.quoteIdentifier(field)} <> $${offset + 1}`,
				parameters: [value]
			}),
			GreaterThan: ({ field, value }) => ({
				sql: `${CollectionSql.quoteIdentifier(field)} > $${offset + 1}`,
				parameters: [value]
			}),
			In: ({ field, values }) => ({
				sql:
					values.length === 0
						? 'false'
						: `${CollectionSql.quoteIdentifier(field)} in (${values.map((_, index) => `$${offset + index + 1}`).join(', ')})`,
				parameters: values
			})
		})
};
export const quoteIdentifier = CollectionSql.quoteIdentifier;
export const compilePredicate = CollectionSql.compilePredicate;
const offsetParameters = CollectionSql.offsetParameters;

/**
 * The most parameters one statement may carry.
 *
 * Postgres sends a statement's parameters under a 16-bit count and refuses one carrying more than
 * 65,535 of them, so a multi-row insert is bounded by `columns x rows` and never by rows: 10,000
 * rows of ten columns is 100,000 and is not a statement any server will accept. The headroom under
 * the hard ceiling is deliberate rather than superstitious — a batch is already capped at 5,000
 * rows, a wide collection reaches this bound at thirteen columns, and a group that later gains one
 * more parameter per row should split one row earlier instead of failing at the server.
 */
const MAX_STATEMENT_PARAMETERS = 60_000;

/**
 * One row on its way into a table, before anything has decided how many rows a statement carries.
 *
 * Stating the row separately from the statement is the whole of the batching: rows that name the
 * same columns in the same order under the same casts are one statement with more tuples in it.
 */
export type PlannedInsert = Readonly<{
	readonly table: string;
	/**
	 * The ordering constraint, and the only one. Every row of a layer is written before any row of a
	 * higher layer; inside a layer nothing names anything, so those rows may be merged and reordered.
	 */
	readonly layer: number;
	readonly columns: ReadonlyArray<string>;
	/** Per column, the cast its placeholder carries — `::jsonb` for a list-valued JSON column. */
	readonly casts?: ReadonlyArray<string>;
	readonly parameters: ReadonlyArray<Schema.Json>;
	/**
	 * The condition this row is written under, when it is not written unconditionally.
	 *
	 * Two things state one: the visibility predicate of a row the subject may not be allowed to
	 * write, and the existence check a row's bookkeeping carries so that it cannot outlive the row
	 * it describes.
	 *
	 * A row carrying one keeps the statement a single create has always written — `select … where
	 * <predicate>`, one row at a time — and is merged with nothing. Two reasons, and the first is
	 * correctness. A `VALUES` list has nowhere to hang a predicate, so merging would mean `select *
	 * from (values …) where <predicate>`, and the columns of that subquery are *in scope* for the
	 * predicate: a grant whose `where` names a column of the collection being created fails today
	 * with `column "owner" does not exist`, and under a subquery it would quietly start resolving
	 * against the row being written instead. Turning a refusal into a different answer is not an
	 * optimisation. The second reason is duller: `insert … select $1` takes its parameter types from
	 * the target columns, while a `VALUES` subquery is analysed on its own, where they are unknown.
	 */
	readonly where?: Readonly<{
		readonly sql: string;
		readonly parameters: ReadonlyArray<Schema.Json>;
	}>;
}>;

/** What two rows must share to be one statement: layer, table, columns, and the casts on them. */
const insertSignature = (row: PlannedInsert): string =>
	`${row.layer}\u0000${row.table}\u0000${row.columns
		.map((column, index) => `${column}${row.casts?.[index] ?? ''}`)
		.join(',')}`;

/**
 * Rows as the fewest statements that write them.
 *
 * This is where a payroll run's write went. A tenant database is a Neon instance a region away;
 * every statement of a transaction is a round trip of its own, because the host runs a transaction's
 * statements serially and that is the only correct way to run one connection's transaction; and 89
 * payslips at three statements each is 267 round trips at ~84ms, which is the 22.4 seconds that was
 * measured. None of it is parse cost — it is distance — so the only lever is how many statements
 * there are, and rows that share a signature share one.
 *
 * Grouping is by signature rather than by "the batch", because rows of one batch do not have to
 * name the same columns: a `create.perRecord.before` may return different keys per row, and padding
 * the gaps with explicit NULLs would write a NULL where the column default belongs. Rows that share
 * a signature have no gaps to pad, so the defaults apply exactly as they do when each row is written
 * alone, and a batch whose rows disagree degrades to one statement per shape rather than losing the
 * distinction.
 */
export const groupedInsertStatements = (
	rows: ReadonlyArray<PlannedInsert>
): ReadonlyArray<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }> => {
	const groups = new Map<string, Array<PlannedInsert>>();
	// Indexed once, ordered once, grouped once. The index is carried because it is both the tiebreak
	// that keeps the original order stable and the key a predicated row is grouped under.
	const ordered = rows.map((row, index) => ({ row, index }));
	ordered.sort((left, right) => left.row.layer - right.row.layer || left.index - right.index);
	for (const { row, index } of ordered) {
		// A predicated row is keyed on where it stands, so it is a group of one: it keeps the exact
		// statement it has today, in the position it has today.
		const key = row.where === undefined ? insertSignature(row) : `\u0000row ${index}`;
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [row]);
		else group.push(row);
	}
	const statements: Array<{
		readonly sql: string;
		readonly parameters: ReadonlyArray<Schema.Json>;
	}> = [];
	const tuple = (row: PlannedInsert, offset: number): string =>
		row.columns.map((_, index) => `$${offset + index + 1}${row.casts?.[index] ?? ''}`).join(', ');
	for (const group of groups.values()) {
		const first = group[0];
		if (first === undefined) continue;
		const columns = first.columns.map(quoteIdentifier).join(', ');
		if (first.where !== undefined) {
			statements.push(
				transactionSql(
					`insert into ${quoteIdentifier(first.table)} (${columns}) select ${tuple(first, 0)} where ${offsetParameters(first.where.sql, first.columns.length)}`,
					[...first.parameters, ...first.where.parameters]
				)
			);
			continue;
		}
		// Every row of a group carries the same number of parameters, which is what makes the ceiling
		// a division rather than a running total.
		const perRow = Math.max(first.columns.length, 1);
		const chunk = Math.max(Math.floor(MAX_STATEMENT_PARAMETERS / perRow), 1);
		for (let start = 0; start < group.length; start += chunk) {
			const slice = group.slice(start, start + chunk);
			statements.push(
				transactionSql(
					`insert into ${quoteIdentifier(first.table)} (${columns}) values ${slice
						.map((row, index) => `(${tuple(row, index * perRow)})`)
						.join(', ')}`,
					slice.flatMap((row) => [...row.parameters])
				)
			);
		}
	}
	return statements;
};

/**
 * The layer each row of a batch belongs to, so that merging rows into one statement cannot move a
 * row in front of the row it points at.
 *
 * A flattened graph arrives parent before child, because a foreign key must already name a row, and
 * merging moves later rows earlier. Only declared relationship columns and logical reference fields
 * are inspected; arbitrary strings and JSON objects cannot accidentally create dependencies. A row
 * naming an earlier row's id sits one layer above it. Layers are emitted in order, so a parent is
 * still written first, while rows inside a layer name nothing of each other's and may be merged
 * freely. A payroll run, its 89 payslips and their lines are three layers, and therefore three
 * statements rather than several hundred.
 *
 * A row that names a *later* row's id is left alone: it is either not a reference at all or it is
 * already broken today, and rows merged into one statement can name each other in any case, because
 * a non-deferred foreign key fires its check at the end of the statement rather than per tuple.
 */
export const insertionLayers = (
	nodes: ReadonlyArray<{
		readonly collection: string;
		readonly id: string;
		readonly values: Readonly<Record<string, Schema.Json>>;
	}>,
	definition: WorkspaceDefinition
): ReadonlyArray<number> => {
	const positions = new Map<string, number>();
	const fieldsByCollection = new Map(
		definition.collections.map((collection) => [collection.name, collection.fields])
	);
	const relationTargets = new Map(
		definition.relations.flatMap((relation) =>
			relation.from === undefined || relation.to === undefined
				? []
				: [
						[
							`${relation.from.collection}\u0000${relation.from.column}`,
							relation.to.collection
						] as const
					]
		)
	);
	nodes.forEach((node, index) => {
		const key = `${node.collection}\u0000${node.id}`;
		if (!positions.has(key)) positions.set(key, index);
	});
	const layers: Array<number> = [];
	for (const [index, node] of nodes.entries()) {
		let layer = 0;
		const fields = fieldsByCollection.get(node.collection);
		for (const [name, value] of Object.entries(node.values)) {
			const field = fields?.[name];
			const relationTarget = relationTargets.get(`${node.collection}\u0000${name}`);
			const referenceHandle =
				field?.reference !== undefined &&
				value !== null &&
				typeof value === 'object' &&
				!Array.isArray(value)
					? value
					: undefined;
			const kind = referenceHandle === undefined ? undefined : Reflect.get(referenceHandle, 'kind');
			const referenceTarget =
				typeof kind === 'string'
					? field?.reference?.targets.find((target) => target.tag === kind)?.collection
					: undefined;
			const identifier =
				referenceTarget === undefined || referenceHandle === undefined
					? value
					: Reflect.get(referenceHandle, 'id');
			const targetCollection = referenceTarget ?? relationTarget;
			if (targetCollection === undefined || typeof identifier !== 'string') continue;
			const referenced = positions.get(`${targetCollection}\u0000${identifier}`);
			if (referenced === undefined || referenced >= index) continue;
			layer = Math.max(layer, (layers[referenced] ?? 0) + 1);
		}
		layers.push(layer);
	}
	return layers;
};

/**
 * The writable orientation of a declared parent-to-children relationship.
 *
 * Authored relationship modules normally put the endpoints on the inverse `one` edge, not on the
 * parent's `many` edge. Programmatic workspaces sometimes put them directly on `many`. Both spell
 * the same ownership fact, so the runtime resolves both and every graph consumer shares the answer.
 */
type WritableManyRelation = Readonly<{
	readonly name: string;
	readonly parentCollection: string;
	readonly parentColumn: string;
	readonly childCollection: string;
	readonly childColumn: string;
	readonly cascade: boolean;
}>;

export const resolveWritableManyRelation = (
	definition: WorkspaceDefinition,
	parentCollection: string,
	name: string
): WritableManyRelation | undefined => {
	const many = definition.relations.find(
		(relation) =>
			relation.name === name &&
			relation.source === parentCollection &&
			relation.cardinality === 'many'
	);
	if (many === undefined) return undefined;

	const oriented = (
		from: RelationDefinition['from'],
		to: RelationDefinition['to'],
		childCollection: string,
		cascade: boolean
	): WritableManyRelation | undefined => {
		if (from === undefined || to === undefined) return undefined;
		const child =
			from.collection === childCollection && to.collection === parentCollection
				? from
				: to.collection === childCollection && from.collection === parentCollection
					? to
					: undefined;
		const parent = child === from ? to : child === to ? from : undefined;
		return child === undefined || parent === undefined
			? undefined
			: {
					name,
					parentCollection,
					parentColumn: parent.column,
					childCollection,
					childColumn: child.column,
					cascade
				};
	};

	const inverseRelations = definition.relations.filter(
		(relation) =>
			relation.source === many.target &&
			relation.target === parentCollection &&
			relation.cardinality === 'one'
	);
	const inverseCascade = inverseRelations.length === 1 && inverseRelations[0]?.cascade === true;
	const direct = oriented(many.from, many.to, many.target, many.cascade === true || inverseCascade);
	if (direct !== undefined) return direct;
	// The two sides are independently named for the UI (`account_contacts` / `contact_account`), so
	// identity is the reversed collections and endpoints, not equal relation names. More than one
	// usable inverse is ambiguous and therefore not writable.
	const inverses = inverseRelations.flatMap((relation) => {
		const resolved = oriented(
			relation.from,
			relation.to,
			many.target,
			many.cascade === true || relation.cascade === true
		);
		return resolved === undefined ? [] : [resolved];
	});
	return inverses.length === 1 ? inverses[0] : undefined;
};

const hasDeclaredManyRelationship = (
	definition: WorkspaceDefinition,
	collection: string,
	values: Readonly<Record<string, unknown>>
): boolean => {
	const relationshipNames = new Set(
		definition.relations
			.filter((relation) => relation.source === collection && relation.cardinality === 'many')
			.map((relation) => relation.name)
	);
	return Object.keys(values).some((key) => relationshipNames.has(key));
};

/**
 * One nearest-neighbour read against a pgvector column.
 *
 * The operands stay `unknown` for the reason `QueryInput.where` does: they arrive from authored
 * code, and the one place that decides what a vector search may be given is the place that renders
 * the SQL for it. Everything here was previously spread into an ordinary `findMany`, which knows no
 * `column`, no `probe` and no `metric` — so the whole config was dropped on the floor and the caller
 * received the collection's first hundred rows as its "nearest" neighbours.
 */
/**
 * The pgvector distance operator each declared metric measures with.
 *
 * `<#>` is the *negative* inner product, which is what makes `order by` ascending mean "most
 * similar" for all three; a caller comparing `ip` distances against a threshold is comparing
 * negatives, and the authoring contract says so.
 */
const NEAREST_OPERATORS = { cosine: '<=>', l2: '<->', ip: '<#>' } as const;

/**
 * How many levels of hook-caused writes one originating write may set off.
 *
 * Separate from `InvocationBudget`'s limit even though the number matches, because they bound
 * different things: that one counts *enqueued* work, which the host runs later on its own
 * invocation, and this counts writes nested inside one invocation's own fiber tree. They share the
 * error type because they are the same message to whoever reads it — something recursed — and
 * nothing is served by two codes for it.
 */
const HOOK_NESTING_LIMIT = 8;

/**
 * `AuthoredRefusal` is a member of all three channels because authored code runs on all three
 * paths: hooks on every mutation, the import pipeline under `import`, the export pipeline under
 * `export`, and `create.after` again when an approval resumes. It is stated rather than left to
 * inference so that a caller which handles these unions exhaustively has to decide what a business
 * rule refusing means for it — which is the distinction the whole change exists to make available.
 */
/**
 * Encodes the one authored scalar that is not itself JSON.
 *
 * Timestamp builders deliberately expose `Date` at the generated authoring surface, so a hook can
 * stamp `new Date()` without erasing the model's type. Database facilities, history snapshots, sync
 * records and approval payloads are all JSON boundaries, though. Normalising at the collection
 * boundary keeps the domain value precise inside the hook and gives every canonical write side
 * effect the same ISO value. Browser submissions already arrive in this form; encoding them again
 * is therefore a no-op.
 */
const encodeMutationValues = (
	values: Readonly<Record<string, unknown>>,
	fields: Readonly<Record<string, FieldDefinition>>
): Readonly<Record<string, Schema.Json>> =>
	Object.fromEntries(
		Object.entries(values).map(([name, value]) => [
			name,
			fields[name]?.type === 'instant' && value instanceof Date && Number.isFinite(value.getTime())
				? value.toISOString()
				: (value as Schema.Json)
		])
	);

/**
 * Drops values the database computes. A `generatedAlwaysAs` column rejects any write, so a caller
 * that echoes a whole row back — an import, a seed, an optimistic client mutation — would fail the
 * statement outright on a column it never chose to set.
 */
const writableValues = (
	values: Readonly<Record<string, unknown>>,
	definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
): Readonly<Record<string, Schema.Json>> => {
	const generated = Object.entries(definition.fields)
		.filter(([, field]) => field.generated !== undefined)
		.map(([name]) => name);
	const writable =
		generated.length === 0
			? values
			: Object.fromEntries(Object.entries(values).filter(([name]) => !generated.includes(name)));
	return encodeReferenceValues(
		encodeMutationValues(writable, definition.fields),
		definition.fields
	) as Readonly<Record<string, Schema.Json>>;
};

/**
 * Resolves one query's SQL predicate. A `where` object owns the answer when present; otherwise a
 * structured `predicate` does. Compilation failure is raised here so every read path reports the
 * offending column rather than running a widened query.
 */
const compiledFilter = (
	input: QueryInput,
	context: WhereContext
): Effect.Effect<SQL, WhereCompileError> => {
	if (input.where === undefined) {
		return Effect.succeed(
			queryFragment(
				input.predicate === undefined
					? { sql: 'true', parameters: [] }
					: compilePredicate(input.predicate)
			)
		);
	}
	const compiled = compileWhere(input.where, context);
	return Result.isFailure(compiled)
		? Effect.fail(compiled.failure)
		: Effect.succeed(whereExpression(compiled.success));
};

/**
 * Matches free text against the columns a collection declared searchable.
 *
 * Case-insensitive containment across every opted-in column, which is what a person means by typing
 * into a search box. A collection with no searchable column yields `true` — the caller decides
 * whether to offer a search box at all, and a term that reached here anyway must not silently widen
 * into a full scan.
 */
const searchClause = (
	fields: Readonly<Record<string, FieldDefinition>>,
	term: string | undefined
): CompiledQuery => {
	const trimmed = term?.trim() ?? '';
	// The same reader the trigram indexes are emitted from, so the columns searched and the columns
	// indexed cannot come apart.
	const searchable = searchableColumns(fields);
	if (trimmed === '') return { sql: 'true', parameters: [] };
	// A term against a collection that opted no column in matches nothing. Returning `true` here would
	// hand back every row, which is how a search box comes to look like it does nothing at all.
	if (searchable.length === 0) return { sql: 'false', parameters: [] };
	const clauses = searchable.map((name) => `${quoteIdentifier(name)}::text ilike $1`);
	return { sql: clauses.join(' or '), parameters: [`%${trimmed}%`] };
};

/**
 * The refusal an authored `db.create` or `db.update` raises when the write stored no row.
 *
 * An `AuthoredRefusal` rather than a defect, because the way this is reached is an access predicate
 * declining the row — a workspace rule doing its job. Reporting a business refusal as an
 * infrastructure fault is the exact regression `AuthoredRefusal` was built to prevent.
 */
const storedNothing = (operation: 'create' | 'update', collection: string, id: string) =>
	Effect.fail(
		new AuthoredRefusal({
			message: `stored no row for ${id}; the record was refused before it was written`,
			collection,
			action: operation
		})
	);

export const layerWith = (randomId: () => string = () => globalThis.crypto.randomUUID()) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const workspace = yield* Workspace.Service;
			const tenant = yield* TenantScope.Service;
			const access = yield* AccessControl.Service;
			const database = yield* Database.Service;
			const approvals = yield* Approvals.Service;
			const ai = yield* AI.Service;
			const files = yield* Files.Service;
			const queue = yield* TaskQueue.Service;
			const automations = yield* Automations.Service;
			const authored = yield* AuthoredRuntimeService;
			const queryTables = new Map<string, ReturnType<typeof collectionQueryTable>>();
			const queryTableFor = (
				name: string,
				fields: Readonly<Record<string, FieldDefinition>>
			): ReturnType<typeof collectionQueryTable> => {
				const existing = queryTables.get(name);
				if (existing !== undefined) return existing;
				const table = collectionQueryTable(name, fields);
				queryTables.set(name, table);
				return table;
			};
			// Announced from here rather than from the command boundary, because this is the only place
			// every write actually passes through: a command, an agent tool, an import, an automation and a
			// replica's own `sync.mutate` all land on these three functions. Announcing at `dispatch` would
			// have missed every write that did not arrive as a command.
			const wake = yield* SyncWake.Service;
			/**
			 * Every outbound integration binding, indexed by the collection whose writes it watches.
			 *
			 * Computed once here rather than per mutation. Almost no collection has one, so the cost of
			 * outbound delivery on a workspace that declares none is a single failed map lookup per write.
			 */
			const sendsByCollection = sendSubscriptions(
				workspace.definition.integrations,
				authored.integrations
			);
			const subscriptionsFor = (collection: string): ReadonlyArray<SendSubscription> =>
				sendsByCollection.get(collection) ?? [];
			/**
			 * The statements that queue this write's outbound deliveries, to be run in the write's own
			 * transaction.
			 *
			 * In the transaction and not after it, deliberately. A post-commit enqueue has a window where
			 * the row exists and the intent to tell anybody about it does not, and a process that dies in
			 * that window drops the event with nothing anywhere to show for it. Committing the row and the
			 * queue entry together is what makes "the outbox is the truth" a fact rather than a hope.
			 *
			 * An entry carrying a refusal — an authored trigger or body that threw — is queued straight to
			 * `failed`. That is the visible middle ground between failing a tenant's write over a mistyped
			 * predicate and silently dropping the event: the write lands, and the reason is a row an
			 * operator can find.
			 */
			/** The columns a batched integration delivery writes, in stable parameter order. */
			const outboxDeliveryColumns = [
				'integration_name',
				'binding_name',
				'collection_name',
				'record_id',
				'operation',
				'path',
				'payload',
				'status',
				'last_error'
			] as const;
			type OutboxDeliveryValues = Readonly<{
				readonly integration_name: string;
				readonly binding_name: string;
				readonly collection_name: string;
				readonly record_id: string;
				readonly operation: 'create' | 'update' | 'delete';
				readonly path: string | null;
				readonly payload: string | null;
				readonly status: 'pending' | 'failed';
				readonly last_error: string | null;
			}>;
			const outboxDeliveryParameters = (values: OutboxDeliveryValues): ReadonlyArray<Schema.Json> =>
				outboxDeliveryColumns.map((column) => values[column]);
			/**
			 * The deliveries this write queues, as structured values rather than SQL.
			 *
			 * A create batch flattens these values into a grouped insert, while update and delete compose
			 * typed Drizzle inserts in `outboxStatements`. Both paths therefore share the same row shape
			 * without keeping a handwritten domain statement beside it.
			 */
			const outboxDeliveries = (
				subject: Identity.Subject,
				collection: string,
				id: string,
				operation: 'create' | 'update' | 'delete',
				values: Readonly<Record<string, Schema.Json>>,
				previous: Readonly<Record<string, unknown>> | undefined
			): ReadonlyArray<{
				readonly integration: string;
				readonly values: OutboxDeliveryValues;
			}> => {
				const subscriptions = subscriptionsFor(collection);
				if (subscriptions.length === 0 || !watchesOperation(subscriptions, operation)) return [];
				const entries = outboxEntriesFor(subscriptions, subject, {
					operation,
					recordId: id,
					record: eventRecord(operation, id, values, previous),
					previous
				});
				return entries.map((entry) => ({
					integration: entry.integration,
					values: {
						integration_name: entry.integration,
						binding_name: entry.binding,
						collection_name: entry.collection,
						record_id: entry.recordId,
						operation: entry.operation,
						path: entry.path,
						payload: entry.payload === null ? null : encodedJsonb(entry.payload),
						status: entry.refusal === null ? 'pending' : 'failed',
						last_error: entry.refusal
					}
				}));
			};
			/**
			 * The job that drains them, in this same transaction.
			 *
			 * This is what replaced a fixed `* * * * *` drain per sending integration — 1440 wakes a day
			 * against every sending tenant's database whether or not anything was ever queued, which was
			 * the single largest standing cost in the runtime. The delivery is now told about by the write
			 * that caused it: the row and the job commit together, so the job cannot exist without the
			 * delivery and the delivery cannot exist without the record change, and there is no window
			 * where one is true and the other is not.
			 *
			 * One task per *integration*, not per delivery and not per record. Per integration is what the
			 * drain already claims at — `distinct on (collection_name, record_id)` gives per-record
			 * ordering inside one drain — and it keeps the property the minute cron had for the right
			 * reason: a partner that is down backs off its own queue and nobody else's.
			 *
			 * Per integration *per batch*, too. The task id is `<effectId>:flush:<integration>` and the
			 * enqueue is `on conflict (effect_id) do nothing`, so a batch of 89 rows watched by one
			 * integration was already writing the same row 89 times and keeping one; it now says it once.
			 */
			const outboxDrains = (
				effectId: EffectId,
				integrations: ReadonlyArray<string>
			): ReadonlyArray<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }> =>
				[...new Set(integrations)].toSorted().flatMap((integration) =>
					queue
						.statements([
							{
								command: 'integrations.flush',
								input: { name: integration },
								effectId: `${effectId}:flush:${integration}`
							}
						])
						.map((statement) => ({
							sql: statement.sql,
							parameters: statement.parameters
						}))
				);
			const outboxStatements = (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				id: string,
				operation: 'create' | 'update' | 'delete',
				values: Readonly<Record<string, Schema.Json>>,
				previous: Readonly<Record<string, unknown>> | undefined
			): ReadonlyArray<{
				readonly sql: string;
				readonly parameters: ReadonlyArray<Schema.Json>;
			}> => {
				const deliveries = outboxDeliveries(subject, collection, id, operation, values, previous);
				return [
					...deliveries.map(({ values }) =>
						toStatement(composer.insert(integrationOutboxTable).values(values).toSQL())
					),
					...outboxDrains(
						effectId,
						deliveries.map(({ integration }) => integration)
					)
				];
			};

			/**
			 * Tells the host to come back now, because this write is about to queue a delivery.
			 *
			 * Sent *before* the commit, never after. A crash between the message and the commit costs a
			 * false alarm — the host wakes, finds nothing due, re-arms — while a crash the other way round
			 * costs a committed delivery nobody ever comes back for. That asymmetry is the whole reason the
			 * order is fixed rather than convenient.
			 */
			const announceFlush = Effect.fn('Collections.announceFlush')(function* (
				effectId: EffectId,
				collection: string,
				operation: 'create' | 'update' | 'delete'
			) {
				const subscriptions = subscriptionsFor(collection);
				if (subscriptions.length === 0 || !watchesOperation(subscriptions, operation)) return;
				yield* queue.wake(EffectId.make(`${effectId}:wake`), yield* Clock.currentTimeMillis);
			});
			/** Whether this collection has an outbound binding that needs the row as it was before the write. */
			const needsPreviousRow = (collection: string, operation: 'update' | 'delete'): boolean =>
				watchesOperation(subscriptionsFor(collection), operation);
			// Annotated from the interface because the body calls itself to prefetch relations, and a
			// self-referencing const cannot have its type inferred.
			/** Reads one row back without row-level visibility or masking — the elevated view hooks and change events see. */
			const readRowElevated = Effect.fn('Collections.readRowElevated')(function* (
				effectId: EffectId,
				collection: string,
				id: string
			) {
				const definition = yield* workspace.collection(collection);
				const table = queryTableFor(collection, definition.fields);
				const columns = columnsOf(table);
				const result = yield* executeBuilt(
					effectId,
					database,
					composer.select(columns).from(table).where(eq(columns['id']!, id)).limit(1)
				);
				const row = result.rows[0];
				return typeof row === 'object' && row !== null
					? decodeReferenceRow(row as Readonly<Record<string, unknown>>, definition.fields)
					: undefined;
			});
			/**
			 * The bytes behind a `file()` value.
			 *
			 * A `file()` column holds the file — `{storage_key, file_name, file_size, mime_type}` — so this
			 * takes the value and reads the object it names. It used to take an *id* and look up a
			 * `document_asset` row for the key, elevated, because that row was the only thing that knew
			 * where the bytes were and the caller had no route to it.
			 *
			 * The elevation is gone with the lookup, and that is the point rather than a side effect: it
			 * existed because an asset row was not reachable through the record's own authorization, and a
			 * value on the record needs no second read to authorize.
			 */
			const readAsset = Effect.fn('Collections.readAsset')(function* (
				effectId: EffectId,
				file: {
					readonly storage_key?: unknown;
					readonly file_name?: unknown;
					readonly mime_type?: unknown;
				}
			) {
				const storageKey = typeof file?.storage_key === 'string' ? file.storage_key : undefined;
				if (storageKey === undefined) {
					return yield* new Database.FacilityError({
						operation: 'files.read',
						code: 'files.asset_missing',
						message: 'This file value names no stored object, so there is nothing to read.',
						retryable: false,
						outcome: 'known'
					});
				}
				const response = yield* files.execute(effectId, { _tag: 'Read', key: storageKey });
				const bytes = response.bytes ?? new Uint8Array();
				const mimeType = typeof file.mime_type === 'string' ? file.mime_type : null;
				const name = typeof file.file_name === 'string' ? file.file_name : storageKey;
				return { id: storageKey, name, mimeType, size: bytes.byteLength, bytes };
			});
			/**
			 * Runs one authored hook handler with its context object, resolving Effect, promise, and plain
			 * results alike, and stamping a refusal it raised with where it was raised.
			 *
			 * The handler is passed as a thunk rather than called here. It used to be invoked in the
			 * argument position — `runAuthoredHandler(hook.handler(context, api))` — and a plain
			 * synchronous handler is the common case, so `refuse` threw *before* `runAuthoredHandler` was
			 * entered and nothing it did could see the throw. That is the specific reason a business rule
			 * arrived at the host as an `ExecutionFailure`.
			 *
			 * `site` names the collection and the phase, because a refusal cannot: `refuse` takes a
			 * sentence and nothing else, and the author writing it is inside one hook and has no reason to
			 * repeat which one. `action` carries the qualified phase — `create.before`, `delete.after` —
			 * rather than the bare action, because the two halves mean different things to whoever reads
			 * the failure. A `before` refusal means nothing was written; an `after` refusal means the write
			 * already happened and is being reported, not undone.
			 */
			const runHook = (
				hook: { readonly handler: (context: unknown, api: unknown) => unknown } | undefined,
				context: unknown,
				api: unknown,
				site: RefusalSite
			): Effect.Effect<unknown, AuthoredRefusal> => {
				if (hook === undefined) return Effect.succeed(undefined);
				return runAuthoredHandler<unknown>(() => hook.handler(context, api)).pipe(
					Effect.catch((refusal) => Effect.fail(refusalAt(refusal, site)))
				);
			};
			/**
			 * Refuses a hook chain that has stopped going anywhere.
			 *
			 * Hooks nest by design — a write runs hooks, and a hook may write, which runs more hooks — and
			 * that is how `employments` creates `employment_terms`. The shape has no natural floor: a hook
			 * that writes back to its own collection recurses until something stops it, and until this
			 * existed the only thing that did was the invocation deadline, by which point the chain had
			 * committed every write it managed to fit inside it. There is no transaction to roll those
			 * back, so "eventually times out" is not a bound worth having.
			 *
			 * Checked on the way *in* to a write, so the refusal names the collection whose hook went too
			 * deep. The limit is deliberately far above the real chains, which are two or three levels: it
			 * is here to catch a loop, not to shape a design.
			 */
			const refuseRunawayHooks = (
				action: string,
				collection: string,
				depth: number
			): Effect.Effect<void, InvocationBudget.NestingLimitExceeded> =>
				depth > HOOK_NESTING_LIMIT
					? Effect.fail(
							InvocationBudget.NestingLimitExceeded.at(
								`${action} on ${collection}, from a hook`,
								depth,
								HOOK_NESTING_LIMIT
							)
						)
					: Effect.void;
			/**
			 * Builds the invocation-bound authoring api from this layer's internals.
			 *
			 * The elevated form backs the after-hook `db.mutate`/`db.delete` surface: those write through
			 * the same statement paths but with no row-visibility predicate, which is the point of an
			 * after hook — the record already passed authorization, so its own follow-ups must not fail
			 * on a row filter the writer itself could not see past.
			 */
			type HookWriteOps = Pick<AuthoredCollectionOps, 'create' | 'update' | 'delete' | 'mutate'>;
			const buildOps = (
				effectId: EffectId,
				subject: Identity.Subject,
				elevated = false,
				/**
				 * How many hooks deep the write that produced this api already is.
				 *
				 * A hook that writes runs the hooks of what it wrote, and those may write again. That is a
				 * legitimate and common shape — an employment's `create.after` creates its terms — but it is
				 * also a loop the moment a hook writes back to its own collection, and nothing else bounds
				 * it. The invocation deadline eventually would, by which time the chain has done however
				 * many writes it could fit into thirty seconds and every one of them is a fact.
				 */
				depth = 0,
				staged?: HookWriteOps
			): AuthoredCollectionOps => {
				return {
					findMany: (collection, input) =>
						findMany(effectId, subject, { collection, ...input }).pipe(
							Effect.flatMap(objectRowsOf)
						),
					findFirst: (collection, input) =>
						findMany(effectId, subject, { collection, ...input, limit: 1 }).pipe(
							Effect.map((rows) => rows[0] as Readonly<Record<string, unknown>> | undefined)
						),
					count: (collection, input) =>
						findMany(effectId, subject, { collection, ...input }).pipe(
							Effect.map((rows) => rows.length)
						),
					findNearest: (collection, input) =>
						findNearest(effectId, subject, nearestInputOf(collection, input)).pipe(
							Effect.flatMap(objectRowsOf)
						),
					runAutomation: runAutomationOp(effectId, automations),
					/**
					 * Answers with the row the database holds, and refuses when it holds none.
					 *
					 * These two used to end `row ?? { id: id, ...values }` — the caller's own payload
					 * handed back as though it had been stored. `readBack` did the same thing on the batch path
					 * and this was the other half of it.
					 *
					 * Refusing rather than answering `undefined`, which is the opposite of what the batch path
					 * does, and deliberately: there a refused row is one of many and the batch legitimately
					 * proceeds without it, while here an authored hook asked for one record and the next line it
					 * runs will use what comes back. A hook that silently continued on an invented record would
					 * write the consequences of a create that never happened. The access predicate refusing the
					 * insert is the way this is reached, so the refusal says that rather than reporting a fault.
					 */
					create:
						staged?.create ??
						((collection, id, values) =>
							Effect.gen(function* () {
								yield* create(effectId, subject, { collection, id, values }, depth);
								const row = yield* readRowElevated(effectId, collection, id);
								if (row === undefined) return yield* storedNothing('create', collection, id);
								return row;
							})),
					update:
						staged?.update ??
						((collection, id, values) =>
							Effect.gen(function* () {
								yield* update(effectId, subject, { collection, id, values }, depth);
								const row = yield* readRowElevated(effectId, collection, id);
								if (row === undefined) return yield* storedNothing('update', collection, id);
								return row;
							})),
					delete:
						staged?.delete ??
						((collection, id) => deleteRecord(effectId, subject, collection, id, depth)),
					mutate:
						staged?.mutate ??
						((collection, payloads, options) =>
							mutate(effectId, subject, collection, payloads, elevated, depth, options)),
					approvalFindMany: (input) =>
						findMany(effectId, subject, { collection: 'approval_request', ...input }).pipe(
							Effect.map((rows) => rows as ReadonlyArray<Readonly<Record<string, unknown>>>)
						),
					approvalFindFirst: (input) =>
						findMany(effectId, subject, {
							collection: 'approval_request',
							...input,
							limit: 1
						}).pipe(Effect.map((rows) => rows[0] as Readonly<Record<string, unknown>> | undefined)),
					infer: inferOp(effectId, ai, (file) => readAsset(effectId, file)),
					readFileAsset: (file) => readAsset(effectId, file)
				};
			};
			const buildApi = (
				effectId: EffectId,
				subject: Identity.Subject,
				elevated = false,
				depth = 0,
				staged?: HookWriteOps
			): RuntimeAuthoringApi =>
				makeAuthoringApi(
					buildOps(effectId, subject, elevated, depth, staged),
					{ elevated },
					randomId
				);
			/**
			 * Enqueues the change-triggered automations a write just satisfied.
			 *
			 * A scheduled automation runs when a host wakes it; a change automation exists because a
			 * record did, so the write itself is the trigger — the row is read back elevated and handed
			 * to the task as `incoming_record`, the shape the authoring context types declare.
			 */
			const emitChangeEvents = Effect.fn('Collections.emitChangeEvents')(function* (
				effectId: EffectId,
				collection: string,
				id: string,
				event: 'created' | 'updated' | 'deleted'
			) {
				const triggers = Object.values(authored.automations).filter(
					(automation) =>
						automation.trigger._tag === 'Change' &&
						automation.trigger.collection === collection &&
						automation.trigger.event === event
				);
				if (triggers.length === 0) return;
				const row =
					event === 'deleted' ? undefined : yield* readRowElevated(effectId, collection, id);
				for (const automation of triggers) {
					const taskId = `${effectId}:event:${automation.name}`;
					const runAs = automationSubject(automation, tenant.tenantId);
					// Ignored rather than propagated, as it always was: a change trigger must not fail the
					// write that caused it. What changes is what an ignored failure now costs — the enqueue is
					// a row, so an automation that throws when it runs backs off and retries instead of
					// vanishing, and one that exhausts its attempts is a `failed` row somebody can find.
					yield* queue
						.enqueue(EffectId.make(taskId), [
							{
								command: `automations.${automation.name}`,
								input: {
									args: {},
									scope:
										event === 'deleted' || row === undefined
											? {}
											: { incoming_record: row as Schema.Json },
									bolt_run_as: runAs
								},
								effectId: taskId
							}
						])
						.pipe(Effect.ignore);
				}
			});
			/**
			 * The same enqueues, for a whole batch, in one facility call.
			 *
			 * `emitChangeEvents` is per record and costs two round trips out of the isolate when a trigger
			 * is declared — a read to build `incoming_record`, then an enqueue — and a batch ran it in a
			 * sequential loop. On 89 payslips that is 178 round trips *after* the write had already
			 * committed in one; on a 4 000-row import it is 8 000. It never showed up because the function
			 * returns immediately when no automation watches the collection, so the cost appears the day a
			 * workspace declares its first change trigger and looks like the trigger being slow.
			 *
			 * Both halves collapse. The rows were already read back for the caller, so they are passed in
			 * rather than re-read, and `queue.enqueue` has always taken an array. Every task keeps the
			 * effect id it had — `<batch>:mutate:<index>:event:<name>` — so an enqueue that already
			 * happened is still recognised as the same one on a replay.
			 */
			const emitChangeEventsMany = Effect.fn('Collections.emitChangeEventsMany')(function* (
				effectId: EffectId,
				collection: string,
				/**
				 * One entry per record that exists. A row that was never written is not passed in at all —
				 * a change event announces a record, and there is no record — so `row` is not optional:
				 * the caller has to have decided before it gets here.
				 */
				records: ReadonlyArray<{
					readonly taskScope: string;
					readonly row: Readonly<Record<string, unknown>>;
				}>,
				event: 'created' | 'updated' | 'deleted'
			) {
				if (records.length === 0) return;
				const triggers = Object.values(authored.automations).filter(
					(automation) =>
						automation.trigger._tag === 'Change' &&
						automation.trigger.collection === collection &&
						automation.trigger.event === event
				);
				if (triggers.length === 0) return;
				const enqueues = triggers.flatMap((automation) =>
					records.map((record) => {
						const taskId = `${record.taskScope}:event:${automation.name}`;
						const runAs = automationSubject(automation, tenant.tenantId);
						const scope: Schema.Json =
							event === 'deleted' ? {} : { incoming_record: record.row as Schema.Json };
						return {
							command: `automations.${automation.name}`,
							input: { args: {}, scope, bolt_run_as: runAs },
							effectId: taskId
						};
					})
				);
				// Ignored rather than propagated, as the per-row form always did: a change trigger must not
				// fail the write that caused it.
				yield* queue.enqueue(effectId, enqueues).pipe(Effect.ignore);
			});
			/**
			 * Decodes one payload through the collection's declared input, if it has one.
			 *
			 * Lifted out of `runCreateHooks` because `load` sees the batch's inputs and must see them in
			 * the same shape the handler will: a collection that declares two fields where the table has
			 * twenty would otherwise hand its batch read the raw payload and its handler the decoded one.
			 */
			const decodeCreateInput = Effect.fn('Collections.decodeCreateInput')(function* (
				collection: string,
				values: Readonly<Record<string, Schema.Json>>,
				module: AuthoredCollectionHookModule | undefined
			) {
				if (module?.create?.input === undefined) return values;
				const decoded = yield* Schema.decodeUnknownEffect(module.create.input)(values).pipe(
					Effect.mapError(
						() =>
							new AccessControl.AccessDenied({
								action: 'create',
								resource: collection,
								reason: 'hook input validation failed'
							})
					)
				);
				return decoded as Readonly<Record<string, Schema.Json>>;
			});
			/**
			 * The reads a batch needs, done once, handed to every record's hook in it.
			 *
			 * A hook is authored for one record, and one that reads is an N+1 by construction — the
			 * attendance rules ask two questions per row, so a four-thousand-row import asks eight
			 * thousand times. `load` is where the query a person would actually write goes: one read over
			 * the window the batch spans, instead of two per day.
			 *
			 * It is not a second place to write the rule. That was `batchHandler`, which was declared,
			 * never called, and had already drifted — one collection carried the same assertion in both of
			 * its hooks. `load` cannot drift from `handler` because it does not restate anything: it
			 * returns data, and the handler is still the only thing that decides.
			 *
			 * Undeclared, this is `undefined` and costs nothing.
			 */
			const runCreatePrepare = Effect.fn('Collections.runCreatePrepare')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				inputs: ReadonlyArray<Readonly<Record<string, Schema.Json>>>,
				module: AuthoredCollectionHookModule | undefined,
				depth: number,
				staged?: HookWriteOps
			) {
				const prepare = module?.create?.prepare;
				if (prepare === undefined) return undefined;
				const api = buildApi(effectId, subject, false, depth + 1, staged);
				return yield* runAuthoredHandler(() => prepare({ inputs, api }, api)).pipe(
					Effect.mapError((cause) => refusalAt(cause, { collection, action: 'create.prepare' }))
				);
			});
			const runCreateHooks = Effect.fn('Collections.runCreateHooks')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				input: MutationInput,
				module: AuthoredCollectionHookModule | undefined,
				depth = 0,
				prepared: unknown = undefined,
				staged?: HookWriteOps
			) {
				const api = buildApi(effectId, subject, false, depth + 1, staged);
				// Already decoded by the caller. `load` sees the batch's inputs and the handler sees one of
				// them, and they must be the same shape — a collection declaring two fields where the table
				// has twenty would otherwise hand its batch read the raw payload and its handler the
				// decoded one.
				const values = input.values;
				const before = yield* runHook(
					module?.create?.perRecord?.before,
					{ input: values, prepared, api },
					api,
					{
						collection: input.collection,
						action: 'create.before'
					}
				);
				return before != null && typeof before === 'object'
					? (before as Readonly<Record<string, Schema.Json>>)
					: values;
			});
			const findMany: Interface['findMany'] = Effect.fn('Collections.findMany')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				input: QueryInput
			) {
				const definition = yield* workspace.collection(input.collection);
				yield* access.authorize(subject, 'read', input.collection);
				const context = makeWhereContext(input.collection, definition.fields, workspace.definition);
				const compiled = yield* compiledFilter(input, context);
				const searched = searchClause(definition.fields, input.search);
				const visibility = access.predicate(subject, 'read', input.collection);
				const limit = Math.max(1, input.limit ?? 100);
				const ordering = compileOrderTerms(input.orderBy, context);
				const seek = yield* compileCollectionCursorSeek(input.after, ordering, input.collection);
				const table = queryTableFor(input.collection, definition.fields);
				const columns = columnsOf(table);
				const orderedColumns = ordering.map((term) =>
					term.direction === 'asc' ? asc(columns[term.column]!) : desc(columns[term.column]!)
				);
				const result = yield* executeBuilt(
					effectId,
					database,
					composer
						.select(columns)
						.from(table)
						.where(
							and(
								compiled,
								queryFragment(searched),
								AccessControl.predicateExpression(visibility),
								queryFragment(seek)
							)
						)
						.orderBy(...orderedColumns)
						.limit(limit)
				);
				const rows = result.rows.map((row) =>
					isJsonObject(row)
						? access.mask(
								subject,
								'read',
								input.collection,
								decodeReferenceRow(row, definition.fields) as Readonly<Record<string, Schema.Json>>
							)
						: row
				);
				// Related records are read through `findMany` itself, so each one passes the same
				// authorization, row visibility and masking as a direct query would. `with` cannot
				// become a way to read what the subject is not allowed to see.
				return yield* attachRelations(
					workspace.definition,
					input.collection,
					rows,
					input.with,
					(collection, column, values) =>
						findMany(effectId, subject, {
							collection,
							where: { [column]: { in: values } },
							limit: PREFETCH_LIMIT
						}).pipe(Effect.orElseSucceed(() => []))
				);
			});
			/**
			 * Nearest neighbours, measured in the database by the index that was declared for them.
			 *
			 * The distance operator is applied to the column itself rather than to an expression over it,
			 * because that is the only form pgvector's HNSW index can answer: `order by "col" <-> $1` uses
			 * the index, and any wrapping of `"col"` degrades it into a sequential scan over every row.
			 * The same expression is projected as `distance`, so a caller comparing against a threshold and
			 * the planner choosing an access path are reading one number.
			 *
			 * Row visibility is the read predicate every other read goes through, and `access.mask` runs on
			 * the record before `distance` is put back on it — a field-restricted policy must not be
			 * undone by a search, and `distance` is not a column of the collection for it to strip.
			 */
			const findNearest: Interface['findNearest'] = Effect.fn('Collections.findNearest')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				input: NearestInput
			) {
				const definition = yield* workspace.collection(input.collection);
				yield* access.authorize(subject, 'read', input.collection);
				const refuse = (field: string, message: string) =>
					new WhereCompileError({ collection: input.collection, field, message });
				const column = input.column;
				if (typeof column !== 'string' || !Object.hasOwn(definition.fields, column)) {
					return yield* refuse(
						typeof column === 'string' ? column : 'column',
						`'${String(column)}' is not a column of ${input.collection}; findNearest needs the vector column to measure against.`
					);
				}
				const metric = input.metric;
				if (typeof metric !== 'string' || !Object.hasOwn(NEAREST_OPERATORS, metric)) {
					return yield* refuse(
						'metric',
						`No distance metric '${String(metric)}'. Accepted metrics: ${Object.keys(NEAREST_OPERATORS).join(', ')}.`
					);
				}
				const probe = input.probe;
				if (
					!Array.isArray(probe) ||
					probe.length === 0 ||
					!probe.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
				) {
					return yield* refuse(
						'probe',
						"probe must be a non-empty array of finite numbers with the column's dimension."
					);
				}
				const excludeIds = input.excludeIds ?? [];
				if (!Array.isArray(excludeIds) || !excludeIds.every((entry) => typeof entry === 'string')) {
					return yield* refuse('excludeIds', 'excludeIds must be an array of record identifiers.');
				}
				if (
					input.maxDistance !== undefined &&
					(typeof input.maxDistance !== 'number' || !Number.isFinite(input.maxDistance))
				) {
					return yield* refuse('maxDistance', 'maxDistance must be a finite number.');
				}
				const limit = ENumber.clamp({ minimum: 1, maximum: 500 })(
					typeof input.limit === 'number' && Number.isFinite(input.limit)
						? Math.trunc(input.limit)
						: 100
				);
				// A driver binds a JavaScript array to a Postgres *array*, and `vector` is not one. The
				// literal text form cast to `::vector` is what pgvector parses.
				const table = queryTableFor(input.collection, definition.fields);
				const columns = columnsOf(table);
				const vectorColumn = columns[column]!;
				const distance = vectorDistance(
					vectorColumn,
					NEAREST_OPERATORS[metric as keyof typeof NEAREST_OPERATORS],
					probe
				);
				const visibility = access.predicate(subject, 'read', input.collection);
				const result = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({ ...columns, distance: aliased(distance, 'distance') })
						.from(table)
						.where(
							and(
								isNotNull(vectorColumn),
								AccessControl.predicateExpression(visibility),
								excludeIds.length === 0 ? undefined : notInArray(columns['id']!, excludeIds),
								input.maxDistance === undefined
									? undefined
									: lessThanOrEqual(distance, input.maxDistance)
							)
						)
						.orderBy(distance)
						.limit(limit)
				);
				return result.rows.map((row) => {
					if (!isJsonObject(row)) return row;
					const record = Object.fromEntries(
						Object.entries(row).filter(([field]) => field !== 'distance')
					);
					const distance = row['distance'];
					const measured = typeof distance === 'number' ? distance : Number(distance ?? Number.NaN);
					return {
						...access.mask(
							subject,
							'read',
							input.collection,
							decodeReferenceRow(record, definition.fields) as Readonly<Record<string, Schema.Json>>
						),
						distance: measured
					};
				});
			});
			/**
			 * A column value as a parameter, and the placeholder that receives it.
			 *
			 * A driver binds a JavaScript array to a Postgres *array*, so a `jsonb` column handed
			 * `[{ start_at, end_at }]` receives array-literal syntax and answers `invalid input syntax for
			 * type json`. An object does not take that path — a driver serialises it — which is why only
			 * list-valued JSON columns were broken, and why nothing caught it until a workspace stored one:
			 * `time_entries.worked_intervals` is a list, so no attendance record could be written or
			 * corrected through the runtime at all.
			 *
			 * The decision is the *column's* declared type, never the value's JavaScript type. A model can
			 * declare a real Postgres array with `.array()`, and a value bound for one must stay an array —
			 * encoding it as JSON because it happened to arrive as a list would corrupt exactly the column
			 * the driver was already handling correctly.
			 */
			const isJsonColumn = (
				definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
				column: string
			): boolean => definition.fields[column]?.type === 'json';
			const boundParameter = (
				definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
				column: string,
				value: Schema.Json
			): Schema.Json =>
				isJsonColumn(definition, column) && Array.isArray(value) ? JSON.stringify(value) : value;
			const boundPlaceholder = (
				definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
				column: string,
				value: Schema.Json,
				position: number
			): string =>
				`$${position}${isJsonColumn(definition, column) && Array.isArray(value) ? '::jsonb' : ''}`;

			/** One node of a batch create: the mutation, its authoring definition, the predicate that gates it, and the layer its flatten-graph position put it above. */
			type CreateStatementNode = Readonly<{
				readonly input: MutationInput;
				readonly definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>;
				readonly visibility: AccessControl.RowPredicate;
				readonly layer: number;
			}>;

			/**
			 * Every statement a batch of creates is, without executing any of them.
			 *
			 * Separated from running them so a batch is one round trip rather than N. The rows, their
			 * history entries and their integration deliveries have to land
			 * together — a record visible to the sync engine but absent from history is a worse state
			 * than no record — and the only way to say "together" through this facility is to hand it one
			 * `Transaction`.
			 *
			 * One transaction was never the end of it, though: the host executes a transaction's
			 * statements serially on one connection, correctly, so a transaction of 267 statements
			 * against a database a region away is 267 round trips. So this takes every row of the batch
			 * rather than one, and hands the whole lot to `groupedInsertStatements`, which writes the rows
			 * that share a shape as one statement each.
			 *
			 * The three bookkeeping tables are collapsed the same way, and are two thirds of the round
			 * trips a batch used to make. They sit one layer past every record: nothing enforces that a
			 * history row follows the record it describes — the table names a record rather than
			 * referencing it — but the order is the one a reader expects, and it keeps a batch's
			 * bookkeeping in one group instead of interleaved between the records. That order is also what
			 * lets a bookkeeping row ask whether its record was written: by then every record insert of the
			 * batch has run, so the answer is final.
			 */
			const createStatements = (
				effectId: EffectId,
				subject: Identity.Subject,
				nodes: ReadonlyArray<CreateStatementNode>
			): ReadonlyArray<{
				readonly sql: string;
				readonly parameters: ReadonlyArray<Schema.Json>;
			}> => {
				const records: Array<PlannedInsert> = [];
				const bookkeeping: Array<PlannedInsert> = [];
				const integrations: Array<string> = [];
				const bookkeepingLayer =
					nodes.reduce((highest, node) => Math.max(highest, node.layer), 0) + 1;
				for (const { input, definition, visibility, layer } of nodes) {
					const values = encodeMutationValues(input.values, definition.fields);
					const writable = writableValues(values, definition);
					const entries = Object.entries(writable).sort(([left], [right]) =>
						left.localeCompare(right)
					);
					const columnValues: ReadonlyArray<readonly [string, Schema.Json]> = [
						['id', input.id],
						...entries.map(([name, value]) => [name, value] as const)
					];
					// Whether the row is written at all, or only if the predicate admits it. It decides the
					// record insert and everything that follows the record, so it is asked once.
					const unconditional =
						visibility.sql.trim() === 'true' && visibility.parameters.length === 0;
					records.push({
						table: input.collection,
						layer,
						columns: columnValues.map(([name]) => name),
						casts: columnValues.map(([name, value]) =>
							isJsonColumn(definition, name) && Array.isArray(value) ? '::jsonb' : ''
						),
						parameters: columnValues.map(([name, value]) =>
							boundParameter(definition, name, value)
						),
						// A predicate that is literally `true` — an elevated write, an administrator, a grant
						// with no `where` — filters nothing, so the row is written unconditionally and can
						// share a statement. Anything else keeps the `select … where` it has today, alone.
						...(unconditional
							? {}
							: { where: { sql: visibility.sql, parameters: visibility.parameters } })
					});
					/**
					 * What the row's bookkeeping is written under, when the row itself is conditional.
					 *
					 * The row insert is a `select … where <predicate>`, so a row the predicate refuses
					 * writes nothing — and the history entry and integration
					 * deliveries that follow it were plain inserts that ran regardless. That left the
					 * database holding an outbox row and a history row for a record that is not there:
					 * sync replicates a `create` for a phantom, and an outbound binding delivers it.
					 *
					 * The condition is the row's existence rather than a second copy of the predicate,
					 * because the two are not the same question by the time the bookkeeping runs. A
					 * predicate is free to read the collection it guards — a quota is written exactly that
					 * way — and bookkeeping sits a layer above every record, so re-asking it after the
					 * batch has been written asks it of a table that has since changed: a quota of two
					 * admits the first two rows and then reads as false for all of them, which would strip
					 * the bookkeeping off the rows that *were* written. Asking whether the row is there
					 * answers about this row, at this point, and cannot drift from what the insert did.
					 *
					 * `id` is the record's identity, so the row this finds is the row the insert
					 * above either wrote or did not — a colliding id fails the insert and takes the
					 * transaction with it rather than arriving here.
					 */
					const wrote = unconditional
						? undefined
						: transactionSql(
								`exists (select 1 from ${quoteIdentifier(input.collection)} where id = $1)`,
								[input.id]
							);
					// A guarded row is a group of one, like the record it follows, so a predicated batch
					// writes its bookkeeping per row instead of merged. That is the price of the guard and
					// it is paid only where a predicate exists: an elevated or unrestricted write carries
					// no `where` at all and its bookkeeping merges exactly as it did.
					const follows = (row: PlannedInsert): PlannedInsert =>
						wrote === undefined ? row : { ...row, where: wrote };
					if (definition.history)
						bookkeeping.push(
							follows({
								table: 'bolt_collection_history',
								layer: bookkeepingLayer,
								columns: ['collection_name', 'record_id', 'operation', 'subject_id', 'snapshot'],
								parameters: [input.collection, input.id, 'create', subject.userId, values]
							})
						);
					for (const delivery of outboxDeliveries(
						subject,
						input.collection,
						input.id,
						'create',
						values,
						undefined
					)) {
						bookkeeping.push(
							follows({
								table: 'bolt_integration_outbox',
								layer: bookkeepingLayer,
								columns: outboxDeliveryColumns,
								parameters: outboxDeliveryParameters(delivery.values)
							})
						);
						// The drain itself stays unconditional. It is one job per integration per batch that
						// looks for pending deliveries and exits when it finds none, so a refused row costs a
						// wake with nothing to do rather than a delivery that should not exist.
						integrations.push(delivery.integration);
					}
				}
				return [
					...groupedInsertStatements([...records, ...bookkeeping]),
					...outboxDrains(effectId, integrations)
				];
			};
			/**
			 * Many creates, as one transaction and one announcement.
			 *
			 * The predicate is evaluated per row, exactly as a single create evaluates it — each row
			 * carries its own `where` and a row the subject may not write inserts nothing, while the rest
			 * of the batch proceeds. That is the same outcome N separate creates would produce, reached in
			 * one round trip instead of N.
			 *
			 * One `wake.announce` at the end rather than one per row: the announcement says a collection
			 * changed, and saying it two hundred times says nothing more than saying it once.
			 */
			/**
			 * One transaction for rows that may span several collections.
			 *
			 * This is the only thing that writes a created row — a single `create`, a batch, and a nested
			 * graph all arrive here. A flattened graph is a payroll run, its payslips, their lines and
			 * their source claims, and all of them have to land together or the run is a fact its payslips
			 * are not. So every node's statements are collected here and issued once.
			 *
			 * Not in the order `flattenGraph` produced them, though: rows that share a shape are merged
			 * into one statement, which moves the later ones earlier. `insertionLayers` is what keeps that
			 * safe — a row that names another row's id sits a layer above it, layers are written in order,
			 * so a foreign key still names a row that is already there.
			 *
			 * The collection definition and the visibility predicate are resolved per node rather than
			 * per call, because the nodes are not all the same collection any more. Elevation is honoured
			 * the same way it always was: it relaxes the row predicate for a hook's own follow-ups. The
			 * public batch path authorizes the subject before it reaches this planner; the elevated path is
			 * only exposed after an already-authorized root mutation, so its engine-owned follow-ups carry
			 * that root authority rather than requiring a second grant on every derived collection.
			 */
			const applyGraph = Effect.fn('Collections.applyGraph')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				nodes: ReadonlyArray<{
					readonly collection: string;
					readonly id: string;
					readonly values: Readonly<Record<string, Schema.Json>>;
				}>,
				elevated: boolean
			) {
				if (nodes.length === 0) return;
				// Which rows may be merged, and in what order — a foreign key must already name a row, and
				// merging moves rows earlier.
				const layers = insertionLayers(nodes, workspace.definition);
				const planned: Array<CreateStatementNode> = [];
				const touched = new Set<string>();
				for (const [index, node] of nodes.entries()) {
					const definition = yield* workspace.collection(node.collection);
					const visibility = elevated
						? AccessControl.unrestricted
						: access.predicate(subject, 'create', node.collection);
					planned.push({
						input: { collection: node.collection, id: node.id, values: node.values },
						definition,
						visibility,
						layer: layers[index] ?? 0
					});
					touched.add(node.collection);
				}
				const statements = createStatements(effectId, subject, planned);
				for (const collection of touched) yield* announceFlush(effectId, collection, 'create');
				yield* database.execute(effectId, { _tag: 'Transaction', statements });
				yield* wake.announce(effectId, [...touched]);
			});
			/**
			 * Locks the exact row a JavaScript decision observed before the mutation or any side effect.
			 *
			 * A live authorization runs before the transaction so it can use Effect reads. `row_version`
			 * closes that prepare/commit gap: if another writer changed the record, this assertion aborts
			 * the whole transaction with a serialization failure instead of applying a decision made about
			 * stale data. Even a write with no live function gets an existence/predicate assertion so a
			 * rejected update cannot leave history, sync, or integration rows behind.
			 */
			const mutationGuardStatement = (
				collection: string,
				id: string,
				action: 'update' | 'delete',
				visibility: AccessControl.RowPredicate,
				previous: Readonly<Record<string, unknown>> | undefined
			): Readonly<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }> => {
				const expectedVersion = previous?.['row_version'];
				const parameters: Array<Schema.Json> = [id, ...visibility.parameters];
				const versionClause =
					typeof expectedVersion === 'number'
						? ` and row_version = $${parameters.push(expectedVersion)}`
						: '';
				const messageIndex = parameters.push(
					`${collection} ${id} changed after ${action} authorization or is outside the mutation predicate`
				);
				return transactionSql(
					`select bolt_assert((select count(*) = 1 from (select id from ${quoteIdentifier(collection)} where id = $1 and (${offsetParameters(visibility.sql, 1)})${versionClause} for update) as bolt_mutation_row), $${messageIndex})`,
					parameters
				);
			};
			/**
			 * Plans one update including the bookkeeping and outbound work that make it a canonical
			 * collection mutation. Keeping this separate from execution lets a declarative graph put the
			 * same operation inside its one transaction instead of recreating a shorter SQL-only path.
			 */
			const updateStatements = (
				effectId: EffectId,
				subject: Identity.Subject,
				input: MutationInput,
				definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
				visibility: AccessControl.RowPredicate,
				clearLock: boolean,
				previous: Readonly<Record<string, unknown>> | undefined
			): ReadonlyArray<{
				readonly sql: string;
				readonly parameters: ReadonlyArray<Schema.Json>;
			}> => {
				const values = encodeMutationValues(input.values, definition.fields);
				const writable = writableValues(values, definition);
				const entries = Object.entries(writable).sort(([left], [right]) =>
					left.localeCompare(right)
				);
				if (entries.length === 0 && !clearLock) return [];
				const assignments = [
					...entries.map(
						([name, value], index) =>
							`${quoteIdentifier(name)} = ${boundPlaceholder(definition, name, value, index + 1)}`
					),
					'updated_at = now()',
					'row_version = row_version + 1',
					...(clearLock ? ['approval_id = null'] : [])
				];
				const history = definition.history
					? [
							toStatement(
								composer
									.insert(collectionHistoryTable)
									.values({
										collection_name: input.collection,
										record_id: input.id,
										operation: 'update',
										subject_id: subject.userId,
										snapshot: encodedJsonb(values)
									})
									.toSQL()
							)
						]
					: [];
				return [
					mutationGuardStatement(input.collection, input.id, 'update', visibility, previous),
					transactionSql(
						`update ${quoteIdentifier(input.collection)} set ${assignments.join(', ')} where id = $${entries.length + 1} and (${offsetParameters(visibility.sql, entries.length + 1)})`,
						[
							...entries.map(([name, value]) => boundParameter(definition, name, value)),
							input.id,
							...visibility.parameters
						]
					),
					...history,
					...outboxStatements(
						effectId,
						subject,
						input.collection,
						input.id,
						'update',
						values,
						previous
					)
				];
			};
			const applyUpdate = Effect.fn('Collections.applyUpdate')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				input: MutationInput,
				definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
				clearLock: boolean,
				elevated = false,
				/** The row before this update, when an outbound binding on this collection needs one. */
				previous: Readonly<Record<string, unknown>> | undefined = undefined
			) {
				const referenceProblem = referenceValueProblem(input.values, definition.fields);
				if (referenceProblem !== undefined)
					return yield* Effect.fail(
						new AuthoredRefusal({
							message: referenceProblem,
							collection: input.collection,
							action: 'update'
						})
					);
				const visibility = elevated
					? AccessControl.unrestricted
					: access.predicate(subject, 'update', input.collection);
				const statements = updateStatements(
					effectId,
					subject,
					input,
					definition,
					visibility,
					clearLock,
					previous
				);
				if (statements.length === 0) return;
				yield* announceFlush(effectId, input.collection, 'update');
				yield* database.execute(effectId, { _tag: 'Transaction', statements });
				yield* wake.announce(effectId, [input.collection]);
			});
			/** The delete twin of `updateStatements`, shared by single-row and graph execution. */
			const deleteStatements = (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				id: string,
				definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
				visibility: AccessControl.RowPredicate,
				previous: Readonly<Record<string, unknown>> | undefined
			): ReadonlyArray<{
				readonly sql: string;
				readonly parameters: ReadonlyArray<Schema.Json>;
			}> => {
				const history = definition.history
					? [
							toStatement(
								composer
									.insert(collectionHistoryTable)
									.values({
										collection_name: collection,
										record_id: id,
										operation: 'delete',
										subject_id: subject.userId
									})
									.toSQL()
							)
						]
					: [];
				return [
					mutationGuardStatement(collection, id, 'delete', visibility, previous),
					transactionSql(
						`delete from ${quoteIdentifier(collection)} where id = $1 and (${offsetParameters(visibility.sql, 1)})`,
						[id, ...visibility.parameters]
					),
					...history,
					...outboxStatements(effectId, subject, collection, id, 'delete', {}, previous)
				];
			};
			const applyDelete = Effect.fn('Collections.applyDelete')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				id: string,
				definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
				elevated = false,
				/** The row before this delete, when an outbound binding on this collection needs one. */
				previous: Readonly<Record<string, unknown>> | undefined = undefined
			) {
				const visibility = elevated
					? AccessControl.unrestricted
					: access.predicate(subject, 'delete', collection);
				const statements = deleteStatements(
					effectId,
					subject,
					collection,
					id,
					definition,
					visibility,
					previous
				);
				yield* announceFlush(effectId, collection, 'delete');
				yield* database.execute(effectId, { _tag: 'Transaction', statements });
				yield* wake.announce(effectId, [collection]);
			});
			const readLock = Effect.fn('Collections.readLock')(function* (
				effectId: EffectId,
				collection: string,
				id: string
			) {
				const definition = yield* workspace.collection(collection);
				const table = queryTableFor(collection, definition.fields);
				const columns = columnsOf(table);
				const result = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({ approval_id: columns['approval_id']! })
						.from(table)
						.where(eq(columns['id']!, id))
						.limit(1)
				);
				const row = result.rows[0];
				const value =
					typeof row === 'object' && row !== null ? Reflect.get(row, 'approval_id') : undefined;
				return typeof value === 'string' && value.length > 0 ? value : undefined;
			});
			/**
			 * Releases a record held by an approval, without touching anything else on it.
			 *
			 * `applyUpdate` can clear the lock as part of a write, which is how an approved *update* settles
			 * — it has values to apply anyway. An approved *create* has none: the row was written when the
			 * create was intercepted, so the only thing left to change is that it is no longer held.
			 */
			const releaseLock = Effect.fn('Collections.releaseLock')(function* (
				effectId: EffectId,
				collection: string,
				id: string,
				requestId?: string
			) {
				const definition = yield* workspace.collection(collection);
				const table = queryTableFor(collection, definition.fields);
				const columns = columnsOf(table);
				const result = yield* executeBuilt(
					effectId,
					database,
					composer
						.update(table)
						.set({ approval_id: null })
						.where(
							requestId === undefined
								? eq(columns['id']!, id)
								: and(eq(columns['approval_id']!, requestId), eq(columns['id']!, id))
						)
						.returning({ record_id: columns['id']! })
				);
				if (result.affectedRows > 0)
					yield* wake
						.announce(EffectId.make(`${effectId}:approval-release-wake`), [collection])
						.pipe(Effect.timeout(250), Effect.ignore);
			});
			const holdForApproval = Effect.fn('Collections.holdForApproval')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				input: MutationInput,
				action: typeof CollectionAction.Type,
				approval?: Schema.Json,
				mode?: 'declarative',
				review?: DeclarativeReview
			) {
				const pending = yield* approvals.pendingForRecord(effectId, input.collection, input.id);
				if (pending !== undefined) {
					return yield* new ApprovalConflict({
						requestId: pending.requestId,
						reason: 'record is locked by a pending approval'
					});
				}
				if (action !== 'create') {
					const locked = yield* readLock(effectId, input.collection, input.id);
					if (locked !== undefined) {
						return yield* new ApprovalConflict({
							requestId: locked,
							reason: 'record is locked by a pending approval'
						});
					}
				}
				// Derived, not random: the same interception must resolve to the same request so a retry
				// re-joins its approval instead of opening a second one. It has to be a UUID because
				// `approval_request` is a collection like any other, keyed by `id uuid` — the
				// composite string only ever fit while Bolt's invented `id text` accepted anything.
				const requestId = deriveRecordId(`${input.collection}:${input.id}:${effectId}`);
				let durableReview = review;
				if (mode === 'declarative' && action !== 'create' && review !== undefined) {
					const rows: Array<(typeof review.rows)[number]> = [];
					for (const row of review.rows) {
						if (row.collection !== input.collection || row.id !== input.id) {
							rows.push(row);
							continue;
						}
						const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(
							row.snapshot
						).pipe(
							Effect.mapError(
								() =>
									new ApprovalConflict({
										requestId,
										reason: 'prepared approval review contains an invalid row snapshot'
									})
							)
						);
						rows.push({
							...row,
							snapshot: JSON.stringify({ ...decoded, approval_id: requestId })
						});
					}
					durableReview = { ...review, rows };
				}
				const state = yield* approvals.request(
					effectId,
					subject,
					requestId,
					{
						collection: input.collection,
						id: input.id,
						values: input.values,
						action,
						subject,
						...(approval === undefined ? {} : { approval }),
						...(mode === undefined ? {} : { mode }),
						...(durableReview === undefined ? {} : { review: durableReview })
					},
					mode === 'declarative' && action === 'create'
						? undefined
						: { collection: input.collection, id: input.id }
				);
				if (state._tag !== 'Pending') {
					return yield* new ApprovalConflict({
						requestId: state.requestId,
						reason: 'record is locked by a pending approval'
					});
				}
				// The request, durable inbox projection, requestor link, sync outbox and (where a row
				// already exists) approval lock are one database statement in `Approvals.request`. A
				// declarative create is the sole lockless case because its domain row intentionally does not
				// exist before approval.
				return yield* new PendingApproval({
					requestId: state.requestId,
					collection: input.collection,
					id: input.id,
					action
				});
			});
			/** Whether a write has a live approval router. */
			const hasApprovalGate = (visibility: AccessControl.RowPredicate): boolean =>
				isPolicyApprovalMarker(visibility.approval);

			const policyDecisionFailure = (
				action: string,
				collection: string,
				reason: string
			): AccessControl.AccessDenied =>
				new AccessControl.AccessDenied({ action, resource: collection, reason });

			/** Runs one prepared JS-object authorization. Anything except explicit `true` fails closed. */
			const authorizePolicyWrite = Effect.fn('Collections.authorizePolicyWrite')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				visibility: AccessControl.RowPredicate,
				action: 'create' | 'update' | 'delete',
				collection: string,
				context: Readonly<Record<string, unknown>>
			) {
				if (!visibility.allowed)
					return yield* policyDecisionFailure(action, collection, visibility.reason);
				const marker = visibility.authorization;
				if (marker === undefined) return;
				if (!isPolicyAuthorizationMarker(marker))
					return yield* policyDecisionFailure(
						action,
						collection,
						'write authorization metadata is malformed'
					);
				const authorize = authored.policyAuthorizations[marker.id];
				if (authorize === undefined)
					return yield* policyDecisionFailure(
						action,
						collection,
						`write authorization ${marker.id} has no live implementation`
					);
				const api = policyDecisionApi(buildApi(effectId, subject), subject);
				const answer = yield* runAuthoredHandler(() => authorize(context, api)).pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.failCause(cause as Cause.Cause<never>)
							: Effect.fail(
									policyDecisionFailure(
										action,
										collection,
										`write authorization ${marker.id} failed`
									)
								)
					)
				);
				if (answer !== true)
					return yield* policyDecisionFailure(
						action,
						collection,
						answer === false
							? `write authorization ${marker.id} refused the prepared record`
							: `write authorization ${marker.id} returned a non-boolean result`
					);
			});

			/** Resolves one branded flow into the concrete, durable sequence reviewed later. */
			const resolveApproval = Effect.fn('Collections.resolveApproval')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				visibility: AccessControl.RowPredicate,
				action: 'create' | 'update' | 'delete',
				collection: string,
				context: Readonly<Record<string, unknown>>,
				evaluate = true
			) {
				const marker = visibility.approval;
				if (marker === undefined) return undefined;
				if (!isPolicyApprovalMarker(marker))
					return yield* policyDecisionFailure(action, collection, 'approval metadata is malformed');
				if (!evaluate) return undefined;
				const route = authored.approvalFlows[marker.id];
				if (route === undefined)
					return yield* policyDecisionFailure(
						action,
						collection,
						`approval flow ${marker.id} has no live implementation`
					);
				const api = policyDecisionApi(buildApi(effectId, subject), subject);
				const value = yield* runAuthoredHandler(() => route(context, api)).pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.failCause(cause as Cause.Cause<never>)
							: Effect.fail(
									policyDecisionFailure(action, collection, `approval flow ${marker.id} failed`)
								)
					)
				);
				const flow = approvalFlowDescriptor(value);
				if (flow === undefined)
					return yield* policyDecisionFailure(
						action,
						collection,
						`approval flow ${marker.id} did not return an ApprovalFlow`
					);
				if (flow._tag === 'NoApproval') return undefined;
				return {
					id: marker.id,
					steps: flow.stages.map((stage, index) => ({
						id: approvalStepId(marker.id, index),
						approvers: [...stage.approvers]
					})),
					superceded_by: [...marker.superceded_by]
				};
			});
			/**
			 * Applies a create field mask to the submitted graph before authored code sees it.
			 *
			 * Hooks are trusted workspace code and may derive fields the caller cannot set. Checking only
			 * their returned value would either reject those server-computed fields or let a hook that
			 * normalizes/drops unknown input erase evidence that the caller tried to forge one. Walking the
			 * submitted graph here preserves that trust boundary for roots and nested creates alike.
			 */
			const validateSubmittedCreateFields: (
				subject: Identity.Subject,
				collection: string,
				payload: Readonly<Record<string, unknown>>,
				action: 'create' | 'update'
			) => Effect.Effect<void, Workspace.WorkspaceLookupError | AccessControl.AccessDenied> =
				Effect.fn('Collections.validateSubmittedCreateFields')(function* (
					subject: Identity.Subject,
					collection: string,
					payload: Readonly<Record<string, unknown>>,
					action: 'create' | 'update'
				) {
					const definition = yield* workspace.collection(collection);
					if (action === 'create') {
						const visibility = access.predicate(subject, 'create', collection);
						if (
							visibility.allowed &&
							visibility.fields !== undefined &&
							Object.keys(payload).some(
								(field) =>
									Object.hasOwn(definition.fields, field) && !visibility.fields?.includes(field)
							)
						) {
							return yield* new AccessControl.AccessDenied({
								action: 'create',
								resource: collection,
								reason: 'create includes fields outside the matching policy grant'
							});
						}
					}
					for (const [key, value] of Object.entries(payload)) {
						if (
							key === 'id' ||
							Object.hasOwn(definition.fields, key) ||
							SYSTEM_COLUMN_NAMES.includes(key)
						)
							continue;
						const relation = resolveWritableManyRelation(workspace.definition, collection, key);
						if (relation === undefined || !Array.isArray(value)) continue;
						for (const child of value) {
							if (typeof child !== 'object' || child === null || Array.isArray(child)) continue;
							const childPayload = child as Readonly<Record<string, unknown>>;
							yield* validateSubmittedCreateFields(
								subject,
								relation.childCollection,
								childPayload,
								typeof childPayload['id'] === 'string' ? 'update' : 'create'
							);
						}
					}
				});
			const create = Effect.fn('Collections.create')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				input: MutationInput,
				depth = 0
			) {
				yield* refuseRunawayHooks('create', input.collection, depth);
				const definition = yield* workspace.collection(input.collection);
				yield* access.authorize(subject, 'create', input.collection);
				const visibility = access.predicate(subject, 'create', input.collection);
				const module = authored.hooks[input.collection];
				yield* validateSubmittedCreateFields(subject, input.collection, input.values, 'create');
				/**
				 * A gated create writes the row and then locks it, rather than holding the operation and
				 * writing nothing.
				 *
				 * Holding was the earlier design and it had two costs that only show up on a real workspace.
				 * The row did not exist, so there was nothing for a reviewer to open, nothing for the table
				 * to show a pending badge on, and nothing for `approvals.process` to be invoked from — the
				 * decision UI keys off `approval_id` on a visible row. And because the operation was
				 * stored before any hook ran, the stored values were only what the form posted: `payroll_runs`
				 * derives six `not null` columns in `create.before`, so replaying that operation later
				 * inserted a row that could not satisfy its own schema, and `create.after` — which is what
				 * starts the payroll engine — never ran at all.
				 *
				 * So the hooks run first and the row is written exactly as an ungated create would write it.
				 * What approval changes is not whether the record exists but whether it is settled: the lock
				 * `holdForApproval` stamps is what every later mutation checks, so the record can still be
				 * moved, but only through the approval it is held by.
				 */
				// A create is a batch of one, and takes the batch's path rather than a shorter one of its
				// own: decode, load, hook. `load` over a single input costs one call and, where a
				// collection declares none, nothing at all.
				const decoded = yield* decodeCreateInput(input.collection, input.values, module);
				const prepared = yield* runCreatePrepare(
					effectId,
					subject,
					input.collection,
					[decoded],
					module,
					depth
				);
				const values = yield* runCreateHooks(
					effectId,
					subject,
					{ ...input, values: decoded },
					module,
					depth,
					prepared
				);
				const preparedValues = encodeMutationValues(values, definition.fields);
				const context = { record: { id: input.id, ...preparedValues } };
				yield* authorizePolicyWrite(
					EffectId.make(`${effectId}:policy-authorization`),
					subject,
					visibility,
					'create',
					input.collection,
					context
				);
				const approval = yield* resolveApproval(
					EffectId.make(`${effectId}:approval-flow`),
					subject,
					visibility,
					'create',
					input.collection,
					context
				);
				// The same path a batch takes, because a create *is* a batch of one — and because a
				// `create.before` that returns the records belonging to this one has to commit them with
				// it. `payroll_runs` is created one at a time through this function, and its run row was
				// a fact three transactions before its payslips were.
				yield* applyGraph(
					effectId,
					subject,
					yield* flattenGraph(input.collection, values, input.id, 0),
					false
				);
				if (approval !== undefined) {
					return yield* holdForApproval(
						effectId,
						subject,
						{ ...input, values: preparedValues },
						'create',
						approval
					);
				}
				if (module?.create?.perRecord?.after !== undefined) {
					const api = buildApi(effectId, subject, true, depth + 1);
					const record = yield* readRowElevated(effectId, input.collection, input.id);
					yield* runHook(module.create.perRecord.after, { record, api }, api, {
						collection: input.collection,
						action: 'create.after'
					});
				}
				yield* emitChangeEvents(effectId, input.collection, input.id, 'created');
			});
			const createMany = Effect.fn('Collections.createMany')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				inputs: ReadonlyArray<MutationInput>
			) {
				for (let index = 0; index < inputs.length; index += 1) {
					const input = inputs[index];
					if (input !== undefined)
						yield* create(EffectId.make(`${effectId}:${index}`), subject, input);
				}
			});
			/**
			 * Every batched write, and the only path a batch takes.
			 *
			 * Two things were wrong with what this replaces, and they pulled in opposite directions.
			 *
			 * **It cost O(N) round trips to do an O(1) job.** The write is one transaction — that part was
			 * right — and then the batch read every row back one at a time, ran every `after` hook off its
			 * own second read of the same row, and emitted every change event in a sequential loop of its
			 * own. Measured on a real payroll run: 89 rows, 18.1 seconds, of which the transaction was
			 * milliseconds. Every one of those reads is an RPC out of the guest isolate before it is a
			 * query. A batch now costs one transaction, one read-back, and one enqueue, whatever N is, and
			 * `mutation-facility-budget.test.ts` fails if that stops being true.
			 *
			 * **It wrote updates as inserts.** `ElevatedMutationPayload` has always declared
			 * `{ id } & update` as an alternative to an insert, and every payload went through
			 * `runCreateHooks` and `createStatements` regardless — so an update ran the create hooks and
			 * then collided with its own primary key. Payloads are routed by `id` now.
			 *
			 * The shape:
			 *
			 * ```
			 * ┌─ PREPARE ── before hooks, outside the transaction ─┐
			 * ├─ COMMIT ─── one Transaction ──────────────────────┤
			 * └─ SETTLE ─── one read-back · after hooks · one enqueue
			 * ```
			 *
			 * Each of the three names itself in the failure it raises, through `MutationPhaseFailure`.
			 * The distinction a caller needs is not which error but which side of the transaction it
			 * happened on: `prepare` and `commit` wrote nothing and may be retried, `settle` did write
			 * and must not be, and only the phase can say which.
			 *
			 *
			 * `batchSize` cuts the payloads into batches that each get all three phases and their own
			 * transaction. Batches run in sequence: two concurrent batches into one table contend on the
			 * same rows, and stopping at a failure needs a defined frontier to stop at. A batch is also
			 * the unit the host's CPU-span budget sees, because the transaction at its end is a facility
			 * call and a facility call is what ends a span.
			 *
			 * `elevated` is honoured rather than assumed, so the same function is correct for a hook
			 * running as an ordinary subject.
			 */
			/**
			 * How deep one nested write may go.
			 *
			 * The compile-time twin of this bound is the `Depth` countdown in `contracts-schema.ts`; the
			 * two are the same number for the same reason. `relations` is a graph with cycles in it —
			 * `payroll_runs → payslips → payroll_runs` — so without a bound a returned graph that closed a
			 * loop would be walked until the isolate died. Refused during preparation, with nothing
			 * written, which is the whole advantage of doing this before the transaction rather than
			 * inside it.
			 */
			const GRAPH_DEPTH_LIMIT = 5;
			/** One node of a flattened graph: which collection it belongs to, its id, and its columns. */
			const FlatRow = Schema.Struct({
				collection: Schema.NonEmptyString,
				id: Schema.NonEmptyString,
				values: Schema.Record(Schema.String, Schema.Json)
			});
			type FlatRow = typeof FlatRow.Type;
			/**
			 * Splits one authored graph into the rows it names, parent first.
			 *
			 * A `create.before` may return its own columns and, keyed by the relation names declared in
			 * `+relationship.ts`, the records that belong to it. This is where that becomes rows: each
			 * node is given its id here rather than by whoever wrote it, because a child cannot carry a
			 * foreign key to a parent whose id does not exist yet — which is the reason the client may no
			 * longer mint one either.
			 *
			 * **An unrecognised key is refused, never dropped.** TypeScript catches a misspelled relation
			 * name when the handler returns an object literal, and cannot when the handler builds its
			 * result in a variable — which the payroll engine must, computing for a second and a half
			 * before it has one. So the guarantee is completed here: a key that is neither a column of the
			 * collection nor one of its declared relations fails the write and says which key it was. The
			 * alternative is the failure this whole design exists to end — a value that was computed,
			 * returned, and silently never stored.
			 */
			const flattenGraph: (
				collection: string,
				values: Readonly<Record<string, unknown>>,
				id: string,
				depth: number
			) => Effect.Effect<ReadonlyArray<FlatRow>, Workspace.WorkspaceLookupError | AuthoredRefusal> =
				Effect.fn('Collections.flattenGraph')(function* (
					collection: string,
					values: Readonly<Record<string, unknown>>,
					id: string,
					depth: number
				) {
					if (depth > GRAPH_DEPTH_LIMIT)
						return yield* Effect.fail(
							new AuthoredRefusal({
								message: `A nested write on ${collection} is more than ${GRAPH_DEPTH_LIMIT} levels deep. A record that owns records that own records that far is usually a cycle in +relationship.ts rather than a shape anybody meant to write.`,
								collection,
								action: 'create'
							})
						);
					const definition = yield* workspace.collection(collection);
					const own: Record<string, Schema.Json> = {};
					const nested: Array<{
						readonly collection: string;
						readonly column: string;
						readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
					}> = [];
					for (const [key, value] of Object.entries(values)) {
						if (Object.hasOwn(definition.fields, key) || SYSTEM_COLUMN_NAMES.includes(key)) {
							own[key] = value as Schema.Json;
							continue;
						}
						// Read against the relation's *declared* name, and only where this collection is the
						// source and the edge is a `many` with an endpoint. A `one` relation points at a record
						// that has to exist already, so expanding it inline would mean inventing its target.
						const relation = resolveWritableManyRelation(workspace.definition, collection, key);
						if (relation === undefined)
							return yield* Effect.fail(
								new AuthoredRefusal({
									message: `${collection} has no column or declared relation named "${key}". A create hook returned it, so it would otherwise have been dropped on the way to the database.`,
									collection,
									action: 'create'
								})
							);
						if (!Array.isArray(value))
							return yield* Effect.fail(
								new AuthoredRefusal({
									message: `"${key}" is a many relation on ${collection}, so it is written as a list of records.`,
									collection,
									action: 'create'
								})
							);
						nested.push({
							collection: relation.childCollection,
							column: relation.childColumn,
							rows: value as ReadonlyArray<Readonly<Record<string, unknown>>>
						});
					}
					const encodedOwn = encodeMutationValues(own, definition.fields);
					const referenceProblem = referenceValueProblem(encodedOwn, definition.fields);
					if (referenceProblem !== undefined)
						return yield* Effect.fail(
							new AuthoredRefusal({ message: referenceProblem, collection, action: 'create' })
						);
					// Parent first, and the order is load-bearing rather than tidy: the statements are applied
					// in the order they are collected, so a child's foreign key must already name a row.
					const rows: Array<FlatRow> = [{ collection, id, values: encodedOwn }];
					for (const child of nested)
						for (const row of child.rows)
							rows.push(
								...(yield* flattenGraph(
									child.collection,
									// The link the author did not write and could not have: it is this parent's id,
									// minted a moment ago. A value they *did* write for it is overwritten rather
									// than honoured — the type omits the column for exactly this reason.
									{ ...row, [child.column]: id },
									randomId(),
									depth + 1
								))
							);
					return rows;
				});

			type IncludedRelationship = Readonly<{
				readonly edge: WritableManyRelation;
				readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
			}>;
			type RelationshipSnapshot = Readonly<{
				readonly edge: WritableManyRelation;
				readonly parentId: string;
				readonly json: string;
			}>;
			/**
			 * One captured edge, flattened into the shape both the review and the lock plan read.
			 *
			 * The two used to carry their own copy of this projection, which is how a field added to one
			 * of them stops being reviewed by the other while both still typecheck.
			 */
			const reviewedRelationshipOf = (snapshot: RelationshipSnapshot) => ({
				name: snapshot.edge.name,
				parentCollection: snapshot.edge.parentCollection,
				parentColumn: snapshot.edge.parentColumn,
				childCollection: snapshot.edge.childCollection,
				childColumn: snapshot.edge.childColumn,
				cascade: snapshot.edge.cascade,
				parentId: snapshot.parentId,
				snapshot: snapshot.json
			});
			type PreparedGraphOperation = Readonly<{
				readonly action: 'create' | 'update' | 'delete';
				readonly collection: string;
				readonly id: string;
				readonly values: Readonly<Record<string, Schema.Json>>;
				readonly definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>;
				readonly visibility: AccessControl.RowPredicate;
				readonly previous?: Readonly<Record<string, unknown>>;
				readonly module?: AuthoredCollectionHookModule;
				readonly depth: number;
				readonly taskScope: EffectId;
				readonly clearLock?: boolean;
				readonly snapshot?: string;
			}>;
			type AppliedDeclarativeGraph = Readonly<{
				readonly operations: ReadonlyArray<PreparedGraphOperation>;
				/** Exact created/updated rows returned by the graph transaction before its locks release. */
				readonly records: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
			}>;

			const graphRefusal = (
				collection: string,
				action: 'create' | 'update' | 'delete',
				message: string
			) => Effect.fail(new AuthoredRefusal({ collection, action, message }));

			/**
			 * Separates columns from explicitly included relationships before a hook input schema sees the
			 * record. `Schema.Struct` drops undeclared keys, and relation keys are intentionally not table
			 * columns, so decoding the graph as one object would silently turn "synchronize this relation"
			 * into "leave it untouched".
			 */
			const splitGraphPayload = Effect.fn('Collections.splitGraphPayload')(function* (
				collection: string,
				payload: Readonly<Record<string, unknown>>,
				action: 'create' | 'update'
			) {
				const definition = yield* workspace.collection(collection);
				const own: Record<string, Schema.Json> = {};
				const included: Array<IncludedRelationship> = [];
				for (const [key, value] of Object.entries(payload)) {
					if (key === 'id') continue;
					if (SYSTEM_COLUMN_NAMES.includes(key))
						return yield* graphRefusal(
							collection,
							action,
							`${collection}.${key} is managed by Bolt and cannot be written.`
						);
					if (key in definition.fields) {
						own[key] = value as Schema.Json;
						continue;
					}
					const edge = resolveWritableManyRelation(workspace.definition, collection, key);
					if (edge === undefined)
						return yield* graphRefusal(
							collection,
							action,
							`${collection} has no writable many relationship named "${key}".`
						);
					if (edge.parentColumn !== 'id')
						return yield* graphRefusal(
							collection,
							action,
							`The ${collection}.${key} relationship joins through ${edge.parentColumn}; declarative nested mutation currently requires the parent's id.`
						);
					if (!Array.isArray(value))
						return yield* graphRefusal(
							collection,
							action,
							`"${key}" is a many relationship on ${collection}, so its desired state must be an array of records.`
						);
					const rows: Array<Readonly<Record<string, unknown>>> = [];
					for (const entry of value) {
						if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
							return yield* graphRefusal(
								collection,
								action,
								`Every entry of ${collection}.${key} must be a record.`
							);
						rows.push(entry as Readonly<Record<string, unknown>>);
					}
					included.push({ edge, rows });
				}
				return { own, included };
			});

			const relatedRows = Effect.fn('Collections.relatedRows')(function* (
				effectId: EffectId,
				edge: WritableManyRelation,
				parentId: string
			) {
				const definition = yield* workspace.collection(edge.childCollection);
				const child = tableAlias(queryTableFor(edge.childCollection, definition.fields), 'child');
				const columns = getColumns(child) as Readonly<Record<string, AnyPgColumn>>;
				const result = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({
							...columns,
							__bolt_snapshot: aliased(rowJson('child'), '__bolt_snapshot')
						})
						.from(child)
						.where(eq(columns[edge.childColumn]!, parentId))
						.orderBy(asc(columns['id']!))
				);
				const raw = result.rows.filter(isJsonObject);
				const snapshots = raw.flatMap((row) =>
					isJsonObject(row['__bolt_snapshot']) ? [row['__bolt_snapshot']] : []
				);
				return {
					rows: raw.map(
						(row) =>
							decodeReferenceRow(
								Object.fromEntries(
									Object.entries(row).filter(([key]) => key !== '__bolt_snapshot')
								),
								definition.fields
							) as Readonly<Record<string, unknown>>
					),
					json: JSON.stringify(snapshots)
				};
			});

			/**
			 * Builds the complete mixed create/update/delete plan before the transaction. Every hook and
			 * authorization check therefore fails in `prepare`, while every statement it admits commits in
			 * one envelope. Relationship omission is read by key presence: no key means no query and no
			 * operation; an explicit empty array plans deletion of every stored child.
			 */
			type DeclarativePreparationOptions = Readonly<{
				readonly approved: boolean;
				readonly runHooks: boolean;
				readonly rootId: string;
				readonly rootAction: 'create' | 'update';
				readonly clearRootLock: boolean;
				readonly approvalRequestId?: string;
				readonly expectedPolicyFingerprint?: string;
			}>;

			const prepareDeclarativeGraph = Effect.fn('Collections.prepareDeclarativeGraph')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				rootCollection: string,
				rootPayload: Readonly<Record<string, unknown>>,
				hookDepth: number,
				options: DeclarativePreparationOptions
			) {
				const operations: Array<PreparedGraphOperation> = [];
				const relationshipSnapshots = new Map<string, RelationshipSnapshot>();
				const approvalRequirements: Array<{
					readonly collection: string;
					readonly action: 'create' | 'update' | 'delete';
					readonly approval?: Schema.Json;
				}> = [];
				const executionInvariants: Array<Schema.Json> = [];
				const registerExecutionInvariant = (
					collection: string,
					action: 'create' | 'update' | 'delete',
					visibility: AccessControl.RowPredicate
				): void => {
					executionInvariants.push({
						collection,
						action,
						allowed: visibility.allowed,
						sql: visibility.sql,
						parameters: [...visibility.parameters],
						fields: visibility.fields === undefined ? null : [...visibility.fields].toSorted(),
						authorization: visibility.authorization ?? null,
						approval: visibility.approval ?? null
					});
				};
				let ordinal = 0;
				const preparedDeletes = new Set<string>();
				const scope = (): EffectId => EffectId.make(`${effectId}:graph:${ordinal++}`);
				const registerRelationshipSnapshot = (
					edge: WritableManyRelation,
					parentId: string,
					json: string
				): void => {
					const key = `${edge.childCollection}\u0000${edge.childColumn}\u0000${parentId}`;
					if (!relationshipSnapshots.has(key))
						relationshipSnapshots.set(key, { edge, parentId, json });
				};
				const recordSnapshot = Effect.fn('Collections.recordSnapshot')(function* (
					collection: string,
					id: string
				) {
					const definition = yield* workspace.collection(collection);
					const record = tableAlias(queryTableFor(collection, definition.fields), 'record');
					const columns = getColumns(record) as Readonly<Record<string, AnyPgColumn>>;
					const result = yield* executeBuilt(
						EffectId.make(`${effectId}:graph:snapshot:${collection}:${id}`),
						database,
						composer
							.select({ snapshot: aliased(rowJson('record'), 'snapshot') })
							.from(record)
							.where(eq(columns['id']!, id))
							.limit(1)
					);
					const row = result.rows[0];
					const snapshot = isJsonObject(row) ? row['snapshot'] : undefined;
					if (!isJsonObject(snapshot))
						return yield* graphRefusal(
							collection,
							'update',
							`${collection} ${id} no longer exists.`
						);
					return JSON.stringify(snapshot);
				});
				const ensureGraphRowUnlocked = Effect.fn('Collections.ensureGraphRowUnlocked')(function* (
					collection: string,
					id: string
				) {
					const pending = yield* approvals.pendingForRecord(
						EffectId.make(`${effectId}:graph:lock:${collection}:${id}`),
						collection,
						id
					);
					if (pending !== undefined)
						return yield* new ApprovalConflict({
							requestId: pending.requestId,
							reason: `${collection} ${id} is locked by another pending approval`
						});
					const locked = yield* readLock(
						EffectId.make(`${effectId}:graph:approval-lock:${collection}:${id}`),
						collection,
						id
					);
					if (locked !== undefined && locked !== options.approvalRequestId)
						return yield* new ApprovalConflict({
							requestId: locked,
							reason: `${collection} ${id} is held by an approval that has not resumed`
						});
				});

				const prepareDelete: (
					collection: string,
					row: Readonly<Record<string, unknown>>,
					depth: number
				) => Effect.Effect<
					void,
					| Workspace.WorkspaceLookupError
					| AccessControl.AccessDenied
					| Database.FacilityError
					| ApprovalConflict
					| AuthoredRefusal
					| InvocationBudget.NestingLimitExceeded
				> = Effect.fn('Collections.prepareGraphDelete')(function* (collection, row, depth) {
					const operationPosition = operations.length;
					const id = row['id'];
					if (typeof id !== 'string' || id.length === 0)
						return yield* graphRefusal(
							collection,
							'delete',
							`A stored ${collection} row selected for reconciliation has no identifier.`
						);
					if (depth > GRAPH_DEPTH_LIMIT)
						return yield* graphRefusal(
							collection,
							'delete',
							`A cascading relationship delete on ${collection} is more than ${GRAPH_DEPTH_LIMIT} levels deep.`
						);
					const identity = `${collection}\u0000${id}`;
					if (preparedDeletes.has(identity)) return;
					preparedDeletes.add(identity);
					const definition = yield* workspace.collection(collection);
					const snapshot = yield* recordSnapshot(collection, id);
					yield* ensureGraphRowUnlocked(collection, id);
					yield* access.authorize(subject, 'delete', collection);
					const visibility = access.predicate(subject, 'delete', collection);
					registerExecutionInvariant(collection, 'delete', visibility);
					const module = authored.hooks[collection];
					if (options.runHooks && module?.delete?.perRecord?.before !== undefined) {
						const api = buildApi(effectId, subject, false, hookDepth + depth + 1, stageHookWrites);
						yield* runHook(module.delete.perRecord.before, { existing: row, api }, api, {
							collection,
							action: 'delete.before'
						});
					}
					const context = { record: row };
					yield* authorizePolicyWrite(
						EffectId.make(`${effectId}:graph:policy-authorization:${collection}:${id}`),
						subject,
						visibility,
						'delete',
						collection,
						context
					);
					const approval = yield* resolveApproval(
						EffectId.make(`${effectId}:graph:approval-flow:${collection}:${id}`),
						subject,
						visibility,
						'delete',
						collection,
						context,
						options.runHooks
					);
					if (approval !== undefined)
						approvalRequirements.push({
							collection,
							action: 'delete',
							approval
						});
					// Deleting an owned row necessarily deletes the rows it owns. Plan every descendant through
					// the same authorization, approval, hooks, history, sync and event pipeline before the
					// database's foreign-key cascade can make them disappear invisibly.
					for (const relation of workspace.definition.relations) {
						if (relation.source !== collection || relation.cardinality !== 'many') continue;
						const edge = resolveWritableManyRelation(
							workspace.definition,
							collection,
							relation.name
						);
						if (edge === undefined || edge.parentColumn !== 'id' || !edge.cascade) continue;
						const related = yield* relatedRows(scope(), edge, id);
						registerRelationshipSnapshot(edge, id, related.json);
						for (const child of related.rows)
							yield* prepareDelete(edge.childCollection, child, depth + 1);
					}
					operations.splice(operationPosition, 0, {
						action: 'delete',
						collection,
						id,
						values: {},
						definition,
						visibility,
						previous: row,
						snapshot,
						...(module === undefined ? {} : { module }),
						depth,
						taskScope: scope()
					});
				});

				const prepareNode: (
					collection: string,
					payload: Readonly<Record<string, unknown>>,
					depth: number,
					ownership?: Readonly<{ readonly column: string; readonly parentId: string }>,
					identity?: Readonly<{
						readonly id: string;
						readonly action: 'create' | 'update';
						readonly clearLock: boolean;
					}>
				) => Effect.Effect<
					string,
					| Workspace.WorkspaceLookupError
					| AccessControl.AccessDenied
					| Database.FacilityError
					| ApprovalConflict
					| AuthoredRefusal
					| GraphApprovalRequired
					| InvocationBudget.NestingLimitExceeded
				> = Effect.fn('Collections.prepareGraphNode')(
					// repository-health:allow COMPLEX1 -- This recursive graph planner is the single policy/hook/relationship owner; guard clauses bound every branch and splitting it would duplicate the shared atomic plan state.
					function* (collection, payload, depth, ownership, identity) {
						const operationPosition = operations.length;
						if (depth > GRAPH_DEPTH_LIMIT)
							return yield* graphRefusal(
								collection,
								'create',
								`A nested write on ${collection} is more than ${GRAPH_DEPTH_LIMIT} levels deep.`
							);
						const submittedId = payload['id'];
						if (
							submittedId !== undefined &&
							(typeof submittedId !== 'string' || submittedId.length === 0)
						)
							return yield* graphRefusal(
								collection,
								'update',
								`The id of a ${collection} mutation must be a non-empty string.`
							);
						const action =
							identity?.action ?? (typeof submittedId === 'string' ? 'update' : 'create');
						const id = identity?.id ?? (typeof submittedId === 'string' ? submittedId : randomId());
						const definition = yield* workspace.collection(collection);
						const module = authored.hooks[collection];
						const submitted = yield* splitGraphPayload(collection, payload, action);
						let own: Readonly<Record<string, Schema.Json>> = submitted.own;
						let included = submitted.included;
						let previous: Readonly<Record<string, unknown>> | undefined;
						let snapshot: string | undefined;
						yield* access.authorize(subject, action, collection);
						const visibility = access.predicate(subject, action, collection);
						registerExecutionInvariant(collection, action, visibility);
						if (action === 'update') yield* ensureGraphRowUnlocked(collection, id);
						// A field mask constrains the submitted patch, not fields trusted workspace code
						// derives in update.before. Keep the declarative/approval graph on the same
						// ordering as the flat update path: inspect the caller-owned shape before input
						// decoding and hooks, then authorize the complete prepared record below.
						if (
							action === 'update' &&
							visibility.fields !== undefined &&
							Object.keys(own).some((field) => !visibility.fields?.includes(field))
						)
							return yield* new AccessControl.AccessDenied({
								action: 'update',
								resource: collection,
								reason: 'update includes fields outside the matching policy grant'
							});

						if (action === 'create') {
							const decoded = yield* decodeCreateInput(collection, own, module);
							own = decoded;
							if (options.runHooks) {
								const prepared = yield* runCreatePrepare(
									effectId,
									subject,
									collection,
									[decoded],
									module,
									hookDepth + depth,
									stageHookWrites
								);
								const hooked = yield* runCreateHooks(
									effectId,
									subject,
									{ collection, id, values: decoded },
									module,
									hookDepth + depth,
									prepared,
									stageHookWrites
								);
								const returned = yield* splitGraphPayload(collection, hooked, action);
								own = returned.own;
								const byName = new Map(included.map((entry) => [entry.edge.name, entry]));
								for (const entry of returned.included) byName.set(entry.edge.name, entry);
								included = [...byName.values()];
							}
						} else {
							previous = yield* readRowElevated(effectId, collection, id);
							snapshot = yield* recordSnapshot(collection, id);
							if (module?.update?.input !== undefined) {
								own = (yield* Schema.decodeUnknownEffect(module.update.input)(own).pipe(
									Effect.mapError(
										() =>
											new AccessControl.AccessDenied({
												action: 'update',
												resource: collection,
												reason: 'hook input validation failed'
											})
									)
								)) as Readonly<Record<string, Schema.Json>>;
							}
							if (options.runHooks && module?.update?.perRecord?.before !== undefined) {
								const api = buildApi(
									effectId,
									subject,
									false,
									hookDepth + depth + 1,
									stageHookWrites
								);
								const before = yield* runHook(
									module.update.perRecord.before,
									{ input: own, existing: previous, api },
									api,
									{ collection, action: 'update.before' }
								);
								if (before != null && typeof before === 'object' && !Array.isArray(before)) {
									const returned = yield* splitGraphPayload(
										collection,
										before as Readonly<Record<string, unknown>>,
										action
									);
									own = returned.own;
									const byName = new Map(included.map((entry) => [entry.edge.name, entry]));
									for (const entry of returned.included) byName.set(entry.edge.name, entry);
									included = [...byName.values()];
								}
							}
						}

						// Relationship ownership comes from the graph position, never from a writable payload.
						// Existing children are proved to belong to this parent above. Their owner key is stripped
						// rather than assigned, so it can neither reparent the row nor turn `{ id }` into a false
						// update with version/history/event side effects.
						if (ownership !== undefined) {
							const owned = { ...own };
							delete owned[ownership.column];
							own =
								action === 'create' ? { ...owned, [ownership.column]: ownership.parentId } : owned;
						}
						own = encodeMutationValues(own, definition.fields);
						const referenceProblem = referenceValueProblem(own, definition.fields);
						if (referenceProblem !== undefined)
							return yield* graphRefusal(collection, action, referenceProblem);
						const context =
							action === 'update'
								? {
										previous: previous ?? { id },
										changes: own,
										record: { ...(previous ?? {}), id, ...own }
									}
								: { record: { id, ...own } };
						if (options.runHooks)
							yield* authorizePolicyWrite(
								EffectId.make(`${effectId}:graph:policy-authorization:${collection}:${id}`),
								subject,
								visibility,
								action,
								collection,
								context
							);
						const approval = yield* resolveApproval(
							EffectId.make(`${effectId}:graph:approval-flow:${collection}:${id}`),
							subject,
							visibility,
							action,
							collection,
							context,
							options.runHooks
						);
						if (approval !== undefined)
							approvalRequirements.push({
								collection,
								action,
								approval
							});
						operations.splice(operationPosition, 0, {
							action,
							collection,
							id,
							values: own,
							definition,
							visibility,
							...(previous === undefined ? {} : { previous }),
							...(snapshot === undefined ? {} : { snapshot }),
							...(module === undefined ? {} : { module }),
							depth,
							taskScope: scope(),
							...(identity?.clearLock === true ? { clearLock: true } : {})
						});

						for (const relation of included) {
							const related =
								action === 'create' ? undefined : yield* relatedRows(scope(), relation.edge, id);
							if (related !== undefined)
								registerRelationshipSnapshot(relation.edge, id, related.json);
							const existing = related?.rows ?? [];
							const byId = new Map(
								existing.flatMap((row) =>
									typeof row['id'] === 'string' ? [[row['id'], row] as const] : []
								)
							);
							const desiredIds = new Set<string>();
							for (const child of relation.rows) {
								const childId = child['id'];
								if (childId !== undefined && (typeof childId !== 'string' || childId.length === 0))
									return yield* graphRefusal(
										relation.edge.childCollection,
										'update',
										`The id of a nested ${relation.edge.childCollection} mutation must be a non-empty string.`
									);
								if (typeof childId === 'string') {
									if (desiredIds.has(childId))
										return yield* graphRefusal(
											relation.edge.childCollection,
											'update',
											`The desired ${relation.edge.name} relationship contains ${childId} more than once.`
										);
									if (!byId.has(childId))
										return yield* graphRefusal(
											relation.edge.childCollection,
											'update',
											`${childId} is not currently owned by ${collection} ${id}, so this relationship mutation cannot move or overwrite it.`
										);
									desiredIds.add(childId);
								}
								yield* prepareNode(relation.edge.childCollection, child, depth + 1, {
									column: relation.edge.childColumn,
									parentId: id
								});
							}
							for (const [childId, row] of byId) {
								if (!desiredIds.has(childId))
									yield* prepareDelete(relation.edge.childCollection, row, depth + 1);
							}
						}
						return id;
					}
				);

				/**
				 * Before-hook writes are planned into this graph instead of reaching the database while the
				 * graph is still being validated. Their hooks and authorization still run canonically, but
				 * every resulting statement joins the parent/relationship transaction and therefore rolls
				 * back with it. The record returned to the hook is explicitly the staged desired row.
				 */
				let stagedWriteCalls = 0;
				const stagedRecord = (
					collection: string,
					id: string,
					action: 'create' | 'update'
				): Effect.Effect<Readonly<Record<string, unknown>>, AuthoredRefusal> => {
					const planned = operations.findLast(
						(operation) => operation.collection === collection && operation.id === id
					);
					return planned === undefined
						? storedNothing(action, collection, id)
						: Effect.succeed({ ...(planned.previous ?? {}), id, ...planned.values });
				};
				const stageHookWrites: HookWriteOps = {
					create: (collection, id, values) =>
						Effect.gen(function* () {
							yield* refuseRunawayHooks('staged create', collection, ++stagedWriteCalls);
							const own = Object.fromEntries(
								Object.entries(values).filter(([name]) => name !== 'id')
							);
							yield* prepareNode(collection, { ...own, id }, 0, undefined, {
								id,
								action: 'create',
								clearLock: false
							});
							return yield* stagedRecord(collection, id, 'create');
						}),
					update: (collection, id, values) =>
						Effect.gen(function* () {
							yield* refuseRunawayHooks('staged update', collection, ++stagedWriteCalls);
							yield* prepareNode(collection, { ...values, id }, 0, undefined, {
								id,
								action: 'update',
								clearLock: false
							});
							return yield* stagedRecord(collection, id, 'update');
						}),
					delete: (collection, id) =>
						Effect.gen(function* () {
							yield* refuseRunawayHooks('staged delete', collection, ++stagedWriteCalls);
							const existing = yield* readRowElevated(scope(), collection, id);
							if (existing !== undefined) yield* prepareDelete(collection, existing, 0);
						}),
					mutate: (collection, payloads) =>
						Effect.gen(function* () {
							yield* refuseRunawayHooks('staged mutate', collection, ++stagedWriteCalls);
							const records: Array<Readonly<Record<string, unknown>>> = [];
							for (const payload of payloads) {
								const submittedId = payload['id'];
								const id = typeof submittedId === 'string' ? submittedId : randomId();
								const action = typeof submittedId === 'string' ? 'update' : 'create';
								yield* prepareNode(collection, { ...payload, id }, 0, undefined, {
									id,
									action,
									clearLock: false
								});
								records.push(yield* stagedRecord(collection, id, action));
							}
							return records;
						})
				};

				const rootId = yield* prepareNode(rootCollection, rootPayload, 0, undefined, {
					id: options.rootId,
					action: options.rootAction,
					clearLock: options.clearRootLock
				});
				const policyFingerprint = approvalFingerprint(
					executionInvariants.toSorted((left, right) =>
						approvalFingerprint(left).localeCompare(approvalFingerprint(right))
					)
				);
				const firstApproval = approvalRequirements[0];
				let approvalReview: DeclarativeReview | undefined;
				if (firstApproval !== undefined) {
					const fingerprint = approvalRouteFingerprint(firstApproval.approval);
					const mixed = approvalRequirements.find(
						(requirement) => approvalRouteFingerprint(requirement.approval) !== fingerprint
					);
					if (mixed !== undefined)
						return yield* graphRefusal(
							rootCollection,
							options.rootAction,
							`The mutation graph resolves to different approval routes (${firstApproval.collection}.${firstApproval.action} and ${mixed.collection}.${mixed.action}); one atomic graph must have one concrete flow.`
						);
					const review: DeclarativeReview = {
						version: 1,
						rows: operations
							.flatMap((operation) =>
								operation.snapshot === undefined
									? []
									: [
											{
												collection: operation.collection,
												id: operation.id,
												snapshot: operation.snapshot
											}
										]
							)
							.toSorted((left, right) =>
								`${left.collection}\u0000${left.id}`.localeCompare(
									`${right.collection}\u0000${right.id}`
								)
							),
						relationships: [...relationshipSnapshots.values()]
							.map(reviewedRelationshipOf)
							.toSorted((left, right) =>
								`${left.childCollection}\u0000${left.childColumn}\u0000${left.parentId}`.localeCompare(
									`${right.childCollection}\u0000${right.childColumn}\u0000${right.parentId}`
								)
							),
						policyFingerprint
					};
					approvalReview = review;
					if (options.approved) {
						if (options.expectedPolicyFingerprint !== policyFingerprint)
							return yield* graphRefusal(
								rootCollection,
								options.rootAction,
								'The approval policy changed after this mutation graph was reviewed.'
							);
					} else {
						return yield* new GraphApprovalRequired({
							collection: firstApproval.collection,
							action: firstApproval.action,
							...(firstApproval.approval === undefined ? {} : { approval: firstApproval.approval }),
							review
						});
					}
				} else if (options.approved && options.expectedPolicyFingerprint !== undefined) {
					return yield* graphRefusal(
						rootCollection,
						options.rootAction,
						'The approval requirement was removed after this mutation graph was reviewed.'
					);
				}
				return {
					rootId,
					operations,
					relationshipSnapshots: [...relationshipSnapshots.values()],
					...(approvalReview === undefined ? {} : { review: approvalReview })
				};
			});

			const applyDeclarativeGraph = Effect.fn('Collections.applyDeclarativeGraph')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				operations: ReadonlyArray<PreparedGraphOperation>,
				relationshipSnapshots: ReadonlyArray<RelationshipSnapshot>,
				elevated: boolean,
				review?: DeclarativeReview
			) {
				const creates = operations.filter((operation) => operation.action === 'create');
				const existingOperations = operations.filter(
					(operation) => operation.action === 'update' || operation.action === 'delete'
				);
				const updates = operations.filter(
					(operation) =>
						operation.action === 'update' &&
						(Object.keys(operation.values).length > 0 || operation.clearLock === true)
				);
				const deletes = operations
					.filter((operation) => operation.action === 'delete')
					.toSorted((left, right) => right.depth - left.depth);
				const createLayers = insertionLayers(creates, workspace.definition);
				const plannedCreates: Array<CreateStatementNode> = creates.map((operation, index) => ({
					input: {
						collection: operation.collection,
						id: operation.id,
						values: operation.values
					},
					definition: operation.definition,
					visibility: elevated ? AccessControl.unrestricted : operation.visibility,
					layer: createLayers[index] ?? 0
				}));
				for (const operation of [...deletes, ...updates, ...creates])
					yield* announceFlush(effectId, operation.collection, operation.action);
				/**
				 * Locks and proves every existing row before any graph statement can write. A row predicate
				 * that matches nothing therefore raises division-by-zero inside the transaction, rolling the
				 * whole graph back before a child, history entry, sync record or integration delivery lands.
				 * The subquery is bounded by the primary key, so its count is exactly one or zero.
				 */
				const guards = existingOperations.map((operation) => {
					const visibility = elevated ? AccessControl.unrestricted : operation.visibility;
					const messageIndex = visibility.parameters.length + 2;
					return transactionSql(
						`select bolt_assert((select count(*) = 1 from (select id from ${quoteIdentifier(operation.collection)} where id = $1 and (${offsetParameters(visibility.sql, 1)}) for update) as bolt_authorized_row), $${messageIndex})`,
						[
							operation.id,
							...visibility.parameters,
							`${operation.collection} ${operation.id} is absent or outside the mutation predicate`
						]
					);
				});
				const createGuards = creates.map((operation) =>
					transactionSql(
						`select bolt_assert(exists(select 1 from ${quoteIdentifier(operation.collection)} where id = $1), $2)`,
						[
							operation.id,
							`${operation.collection} ${operation.id} was rejected by the create predicate`
						]
					)
				);
				const reviewedRows =
					review?.rows ??
					existingOperations.flatMap((operation) =>
						operation.snapshot === undefined
							? []
							: [
									{
										collection: operation.collection,
										id: operation.id,
										snapshot: operation.snapshot
									}
								]
					);
				const reviewedRelationships =
					review?.relationships ?? relationshipSnapshots.map(reviewedRelationshipOf);
				const tableLocks = [
					...new Set([
						...operations.map((operation) => operation.collection),
						...reviewedRows.map((row) => row.collection),
						...reviewedRelationships.map((snapshot) => snapshot.childCollection)
					])
				]
					.toSorted()
					.map((table) =>
						transactionSql(`lock table ${quoteIdentifier(table)} in share row exclusive mode`)
					);
				const recordAssertions = reviewedRows.map((row) =>
					transactionSql(
						`select bolt_assert((select to_jsonb(record) from ${quoteIdentifier(row.collection)} as record where id = $1) = $2::jsonb, $3)`,
						[
							row.id,
							row.snapshot,
							`${row.collection} ${row.id} changed while its mutation graph was prepared`
						]
					)
				);
				const relationshipAssertions = reviewedRelationships.map((snapshot) =>
					transactionSql(
						`select bolt_assert((select coalesce(jsonb_agg(to_jsonb(child) order by child.id), '[]'::jsonb) from ${quoteIdentifier(snapshot.childCollection)} as child where ${quoteIdentifier(snapshot.childColumn)} = $1) = $2::jsonb, $3)`,
						[
							snapshot.parentId,
							snapshot.snapshot,
							`${snapshot.childCollection} membership changed while ${snapshot.parentCollection} ${snapshot.parentId} was prepared`
						]
					)
				);
				const appliedOperations = [...deletes, ...updates, ...creates];
				const capturedOperations = appliedOperations.filter(
					(operation) => operation.action === 'create' || operation.action === 'update'
				);
				const captureParameters: Array<Schema.Json> = [];
				const captureSql = capturedOperations
					.map((operation, index) => {
						const ordinalParameter = captureParameters.push(index);
						const collectionParameter = captureParameters.push(operation.collection);
						const idParameter = captureParameters.push(operation.id);
						return transactionSql(
							`select $${ordinalParameter}::integer as "__bolt_graph_ordinal", $${collectionParameter}::text as "__bolt_graph_collection", $${idParameter}::text as "__bolt_graph_id", to_jsonb(stored) as "__bolt_graph_record" from ${quoteIdentifier(operation.collection)} as stored where stored.id = $${idParameter}::uuid`
						).sql;
					})
					.join(' union all ');
				const captureStatement = transactionSql(
					captureSql.length > 0
						? `${captureSql} order by "__bolt_graph_ordinal"`
						: 'select null::integer as "__bolt_graph_ordinal", null::text as "__bolt_graph_collection", null::text as "__bolt_graph_id", null::jsonb as "__bolt_graph_record" where false',
					captureParameters
				);
				const statements = [
					...tableLocks,
					...guards,
					...recordAssertions,
					...relationshipAssertions,
					...deletes.flatMap((operation) =>
						deleteStatements(
							operation.taskScope,
							subject,
							operation.collection,
							operation.id,
							operation.definition,
							elevated ? AccessControl.unrestricted : operation.visibility,
							operation.previous
						)
					),
					...updates.flatMap((operation) =>
						updateStatements(
							operation.taskScope,
							subject,
							{
								collection: operation.collection,
								id: operation.id,
								values: operation.values
							},
							operation.definition,
							elevated ? AccessControl.unrestricted : operation.visibility,
							operation.clearLock === true,
							operation.previous
						)
					),
					...createStatements(effectId, subject, plannedCreates),
					...createGuards,
					captureStatement
				];
				const result = yield* database.execute(effectId, { _tag: 'Transaction', statements });
				const records = new Map<string, Readonly<Record<string, unknown>>>();
				for (const row of result.rows) {
					if (!isJsonObject(row)) continue;
					const ordinal = row['__bolt_graph_ordinal'];
					const record = row['__bolt_graph_record'];
					if (typeof ordinal !== 'number' || !isJsonObject(record)) continue;
					const operation = capturedOperations[ordinal];
					if (operation === undefined) continue;
					records.set(
						`${operation.collection}\u0000${operation.id}`,
						decodeReferenceRow(record, operation.definition.fields) as Readonly<
							Record<string, unknown>
						>
					);
				}
				return { operations: appliedOperations, records } satisfies AppliedDeclarativeGraph;
			});

			const settleDeclarativeGraph = Effect.fn('Collections.settleDeclarativeGraph')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				applied: AppliedDeclarativeGraph,
				hookDepth: number
			) {
				const { operations, records } = applied;
				const committed = operations.map((operation) => operation.id);
				const settleStep = <A, E>(
					step: NonNullable<MutationPhaseFailure['step']>,
					collection: string,
					effect: Effect.Effect<A, E>
				) =>
					effect.pipe(
						Effect.catchCause((cause) =>
							Effect.fail(
								mutationPhaseFailure('settle', collection, committed, Cause.squash(cause), step)
							)
						)
					);
				const touched = [...new Set(operations.map((operation) => operation.collection))];
				if (touched.length > 0)
					yield* settleStep('wake', touched.join(','), wake.announce(effectId, touched));
				for (const operation of operations) {
					const api = buildApi(operation.taskScope, subject, true, hookDepth + operation.depth + 1);
					// Deletes are their own shape: the record a delete hook receives is the row as it stood,
					// not one read back out of `records`.
					if (operation.action === 'delete') {
						const removed = operation.module?.delete?.perRecord?.after;
						if (removed === undefined) continue;
						yield* settleStep(
							'after-hook',
							operation.collection,
							runHook(removed, { record: operation.previous, api }, api, {
								collection: operation.collection,
								action: 'delete.after'
							})
						);
						continue;
					}
					// An update that changed no column and released no lock ran no statement, so it is not a
					// change and owes no hook.
					if (
						operation.action === 'update' &&
						Object.keys(operation.values).length === 0 &&
						operation.clearLock !== true
					)
						continue;
					const hook =
						operation.action === 'create'
							? operation.module?.create?.perRecord?.after
							: operation.module?.update?.perRecord?.after;
					if (hook === undefined) continue;
					const record = records.get(`${operation.collection}\u0000${operation.id}`);
					if (record === undefined) continue;
					yield* settleStep(
						'after-hook',
						operation.collection,
						runHook(
							hook,
							operation.action === 'update'
								? { previous: operation.previous, changes: operation.values, record, api }
								: { record, api },
							api,
							{
								collection: operation.collection,
								action: `${operation.action}.after`
							}
						)
					);
				}
				for (const [key, grouped] of Map.groupBy(
					operations.filter(
						(operation) =>
							operation.action !== 'update' ||
							Object.keys(operation.values).length > 0 ||
							operation.clearLock === true
					),
					(operation) => `${operation.collection}\u0000${operation.action}`
				)) {
					const [collection, action] = key.split('\u0000') as [
						string,
						'create' | 'update' | 'delete'
					];
					yield* settleStep(
						'change-events',
						collection,
						emitChangeEventsMany(
							effectId,
							collection,
							grouped.flatMap((operation) => {
								const record =
									action === 'delete'
										? operation.previous
										: records.get(`${operation.collection}\u0000${operation.id}`);
								return record === undefined
									? []
									: [{ taskScope: operation.taskScope, row: record }];
							}),
							action === 'create' ? 'created' : action === 'update' ? 'updated' : 'deleted'
						)
					);
				}
				return records;
			});

			type GraphApprovalContext = Readonly<{
				readonly approved: boolean;
				readonly rootId?: string;
				readonly rootAction?: 'create' | 'update';
				readonly clearRootLock?: boolean;
				readonly approvalRequestId?: string;
				readonly review?: DeclarativeReview;
			}>;

			const synchronizeGraph = Effect.fn('Collections.synchronizeGraph')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				payload: Readonly<Record<string, unknown>>,
				elevated: boolean,
				depth: number,
				approval: GraphApprovalContext
			) {
				const submittedId = payload['id'];
				if (
					submittedId !== undefined &&
					(typeof submittedId !== 'string' || submittedId.length === 0)
				)
					return yield* graphRefusal(
						collection,
						'update',
						`The id of a ${collection} mutation must be a non-empty string.`
					);
				const rootAction =
					approval.rootAction ?? (typeof submittedId === 'string' ? 'update' : 'create');
				const rootId =
					approval.rootId ?? (typeof submittedId === 'string' ? submittedId : randomId());
				const rootValues = Object.fromEntries(
					Object.entries(payload).filter(([key]) => key !== 'id')
				);
				const prepare = (
					approved: boolean,
					runHooks: boolean,
					expectedPolicyFingerprint?: string
				) =>
					prepareDeclarativeGraph(effectId, subject, collection, payload, depth, {
						approved,
						runHooks,
						rootId,
						rootAction,
						clearRootLock: approval.clearRootLock === true,
						...(approval.approvalRequestId === undefined
							? {}
							: { approvalRequestId: approval.approvalRequestId }),
						...(expectedPolicyFingerprint === undefined ? {} : { expectedPolicyFingerprint })
					});
				const phasePrepare = <A, E>(effect: Effect.Effect<A, E>) =>
					effect.pipe(
						Effect.catchCause((cause) => {
							const failure = Cause.squash(cause);
							return Effect.fail(
								failure instanceof GraphApprovalRequired
									? failure
									: mutationPhaseFailure('prepare', collection, [], failure)
							);
						})
					);
				const hold = (cause: GraphApprovalRequired) =>
					Effect.gen(function* () {
						const values = yield* Schema.decodeUnknownEffect(JsonObject)(rootValues).pipe(
							Effect.mapError(
								() =>
									new AuthoredRefusal({
										collection,
										action: rootAction,
										message: 'The mutation graph cannot be stored as an approval operation.'
									})
							)
						);
						return yield* holdForApproval(
							effectId,
							subject,
							{ collection, id: rootId, values },
							rootAction,
							cause.approval,
							'declarative',
							cause.review
						);
					});
				let prepared;
				if (approval.approved) {
					if (approval.review === undefined)
						return yield* new ApprovalConflict({
							requestId: approval.approvalRequestId ?? rootId,
							reason: 'stored declarative approval review is missing'
						});
					prepared = yield* phasePrepare(
						prepare(true, true, approval.review.policyFingerprint)
					).pipe(
						Effect.catchTag('Bolt.Collections.GraphApprovalRequired', () =>
							graphRefusal(
								collection,
								rootAction,
								'An approved mutation graph unexpectedly requested another approval.'
							)
						)
					);
					if (
						prepared.review === undefined ||
						!Schema.toEquivalence(DeclarativeReview)(prepared.review, approval.review)
					) {
						if (approval.approvalRequestId !== undefined)
							yield* approvals.conflict(
								EffectId.make(`${effectId}:stale-review-conflict`),
								approval.approvalRequestId,
								'the reviewed mutation graph changed while approval was pending'
							);
						return yield* new ApprovalConflict({
							requestId: approval.approvalRequestId ?? rootId,
							reason: 'the reviewed mutation graph changed while approval was pending'
						});
					}
				} else {
					// Hooks prepare the candidate before authorization and routing, for unconditional and
					// conditional approvals alike. Their writes are staged into this graph, so running them here
					// cannot leak a partial mutation. Approval resume runs the hooks again and compares the rebuilt
					// review byte-for-byte before committing it.
					prepared = yield* phasePrepare(prepare(false, true)).pipe(
						Effect.catchTag('Bolt.Collections.GraphApprovalRequired', hold)
					);
				}
				const applied = yield* applyDeclarativeGraph(
					effectId,
					subject,
					prepared.operations,
					prepared.relationshipSnapshots,
					elevated,
					approval.review
				).pipe(
					Effect.catchCause((cause) =>
						Effect.gen(function* () {
							const failure = Cause.squash(cause);
							if (
								approval.approved &&
								approval.approvalRequestId !== undefined &&
								!Cause.hasInterruptsOnly(cause)
							) {
								yield* approvals
									.conflict(
										EffectId.make(`${effectId}:commit-review-conflict`),
										approval.approvalRequestId,
										'the reviewed mutation graph changed while approval was pending'
									)
									.pipe(Effect.ignore);
							}
							return yield* Effect.fail(mutationPhaseFailure('commit', collection, [], failure));
						})
					)
				);
				const committed = applied.operations.map((operation) => operation.id);
				const records = yield* settleDeclarativeGraph(effectId, subject, applied, depth).pipe(
					Effect.catchCause((cause) =>
						Effect.fail(mutationPhaseFailure('settle', collection, committed, Cause.squash(cause)))
					)
				);
				const root = records.get(`${collection}\u0000${prepared.rootId}`);
				// The public command is completion-only; the identifier fallback only lets dispatch perform
				// its subject-filtered compatibility read without a post-commit elevated reread here.
				return [root ?? { id: prepared.rootId }];
			});
			const mutateBatch = Effect.fn('Collections.mutateBatch')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				identified: ReadonlyArray<{
					readonly id: string;
					readonly values: Readonly<Record<string, Schema.Json>>;
				}>,
				definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
				elevated: boolean,
				depth: number
			) {
				const module = authored.hooks[collection];
				/**
				 * One effect id per row, never the batch's.
				 *
				 * The database facility is idempotent on `(scope, effectId)` — that is what makes a
				 * retried invocation safe — so N statements issued under one id are one statement and
				 * N cached copies of its result. An earlier implementation ran every row's `applyCreate`
				 * under the batch id, which is that fault directly.
				 */
				const rowId = (index: number): EffectId => EffectId.make(`${effectId}:mutate:${index}`);
				/**
				 * PREPARE, and the FLATTEN that finishes it. Outside the transaction, so any refusal fails
				 * the batch with nothing written rather than half applied.
				 *
				 * Decoded, then prepared, then the per-record hooks. `prepare` is the one place a batch is
				 * visible to authored code, and it exists so the *reads* can be batched while every rule
				 * stays written once, for one record — four thousand rows asking "is this day owned by
				 * leave" become one query over the window they span.
				 *
				 * FLATTEN turns every prepared graph into rows, parent first. Where a hook returned only
				 * its own columns this is one row and costs nothing; where it returned the records that
				 * belong to it — a payroll run and its payslips, an agreement and its instalments — every
				 * one of them joins the same transaction below. That is the whole point of doing it here:
				 * the parent is not a fact until its children are. It sits inside this phase rather than
				 * beside it because it writes nothing, which is the only thing the phase tag promises.
				 */
				const preparation = yield* Effect.gen(function* () {
					const decoded = yield* Effect.all(
						identified.map((row) => decodeCreateInput(collection, row.values, module)),
						{ concurrency: 'unbounded' }
					);
					const prepared = yield* runCreatePrepare(
						effectId,
						subject,
						collection,
						decoded,
						module,
						depth
					);
					const built = yield* Effect.all(
						identified.map((row, index) =>
							runCreateHooks(
								rowId(index),
								subject,
								{ collection, id: row.id, values: decoded[index] ?? row.values },
								module,
								depth,
								prepared
							).pipe(Effect.map((values) => ({ id: row.id, values })))
						),
						{ concurrency: 'unbounded' }
					);
					const flattened = yield* Effect.all(
						built.map((row) => flattenGraph(collection, row.values, row.id, 0)),
						{ concurrency: 'unbounded' }
					);
					return { built, nodes: flattened.flat() };
				}).pipe(
					Effect.catch((cause) =>
						Effect.fail(mutationPhaseFailure('prepare', collection, [], cause))
					)
				);
				const { built, nodes } = preparation;
				// COMMIT. One transaction for the batch, whatever it grew into — and atomic, so a failure
				// here wrote nothing either. It is a phase of its own because the cause is a different
				// kind of thing: `prepare` fails on a business rule, `commit` fails on the database.
				yield* applyGraph(effectId, subject, nodes, elevated).pipe(
					Effect.catch((cause) =>
						Effect.fail(mutationPhaseFailure('commit', collection, [], cause))
					)
				);
				/**
				 * SETTLE. One read, and everything downstream reads from it: an `after` hook's record and
				 * a change trigger's `incoming_record` are the same row this already holds.
				 *
				 * The transaction is behind us, so a failure from here is not a failed write — it is a
				 * completed write whose aftermath went wrong, and a caller that retries it writes the
				 * batch twice. That is why the ids the transaction carried are attached to the failure:
				 * they are the only way to find out what is now true.
				 */
				const committed = nodes.map((node) => node.id);
				return yield* Effect.gen(function* () {
					const rows = yield* readBack(effectId, collection, built);
					/**
					 * The rows that are actually there, still carrying the index they were submitted under.
					 *
					 * A row the visibility predicate refused inserted nothing, so there is no record for a
					 * hook to receive and nothing for a trigger to fire on. It is dropped here, once, and
					 * everything below reads from what is left: the `after` hooks, the change events, and
					 * the answer this batch returns. The index travels with it because `rowId(index)` is the
					 * identity every statement and every enqueued task is filed under, and it must not shift
					 * when a row ahead of it was refused.
					 */
					const settled = rows.flatMap((record, index) =>
						record === undefined ? [] : [{ index, record }]
					);
					if (module?.create?.perRecord?.after !== undefined) {
						const after = module.create.perRecord.after;
						yield* Effect.all(
							settled.map(({ index, record }) =>
								Effect.suspend(() => {
									const api = buildApi(rowId(index), subject, true, depth + 1);
									return runHook(after, { record, api }, api, {
										collection,
										action: 'create.after'
									});
								})
							),
							{ concurrency: 'unbounded' }
						);
					}
					yield* emitChangeEventsMany(
						effectId,
						collection,
						settled.map(({ index, record }) => ({ taskScope: rowId(index), row: record })),
						'created'
					);
					return settled.map(({ record }) => record);
				}).pipe(
					Effect.catch((cause) =>
						Effect.fail(mutationPhaseFailure('settle', collection, committed, cause))
					)
				);
			});
			/**
			 * How many rows one call may write before it has to say how it wants them cut up.
			 *
			 * A transaction is serialised into a single `postMessage` out of the isolate, and that encode
			 * is the one stretch of a batch that cannot be broken up without breaking the transaction —
			 * so it is the one place batch size is load-bearing for the host's 2s span budget rather than
			 * merely for how much a failure loses. Exceeding it is refused rather than split silently:
			 * splitting would break the only promise this surface makes, and it would break it at exactly
			 * the size where nobody is still watching.
			 */
			const MAX_BATCH_ROWS = 5_000;
			const mutate = Effect.fn('Collections.mutate')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				payloads: ReadonlyArray<Readonly<Record<string, unknown>>>,
				elevated: boolean,
				depth: number,
				options?: {
					readonly batchSize?: number;
					readonly declarative?: boolean;
					readonly root?: Readonly<{ readonly id: string; readonly action: 'create' | 'update' }>;
				}
			) {
				yield* refuseRunawayHooks('mutate', collection, depth);
				const definition = yield* workspace.collection(collection);
				const explicitRoot =
					options?.declarative === true && payloads.length === 1 ? options.root : undefined;
				if (!elevated) {
					for (const payload of payloads)
						yield* validateSubmittedCreateFields(
							subject,
							collection,
							payload,
							explicitRoot?.action ?? (typeof payload['id'] === 'string' ? 'update' : 'create')
						);
				}
				/**
				 * A submitted relationship changes the operation from a flat batch into state
				 * synchronization. The browser sends one root, while the authored bulk surface may still send
				 * many scalar rows; preserving the old flat batch path keeps its constant facility-call budget.
				 * Merely naming an endpointless `many` is enough to enter the graph path so it is refused there
				 * rather than leaking through as an SQL column.
				 */
				const root = payloads[0];
				if (options?.declarative === true) {
					if (payloads.length !== 1 || root === undefined)
						return yield* graphRefusal(
							collection,
							'create',
							'A declarative mutation must contain exactly one root record.'
						);
					return yield* synchronizeGraph(effectId, subject, collection, root, elevated, depth, {
						approved: false,
						...(explicitRoot === undefined
							? {}
							: { rootId: explicitRoot.id, rootAction: explicitRoot.action })
					});
				}
				const declaresRelationship =
					payloads.length === 1 &&
					root !== undefined &&
					hasDeclaredManyRelationship(workspace.definition, collection, root);
				if (root !== undefined && declaresRelationship)
					return yield* synchronizeGraph(effectId, subject, collection, root, elevated, depth, {
						approved: false
					});
				/**
				 * Flat authored batches retain their established per-update path. The public declarative
				 * graph has already branched above; no relationship synchronization reaches this loop.
				 */
				const updates = payloads.filter(
					(payload) => typeof payload['id'] === 'string'
				) as ReadonlyArray<Readonly<Record<string, Schema.Json>>>;
				const inserts = payloads.filter((payload) => typeof payload['id'] !== 'string');
				// A public batch is the subject's create and must hold the collection grant. An elevated batch
				// can only come from the trusted post-write API after the root mutation was authorized; requiring
				// the same subject to create engine-owned output rows (for example payslips) defeats that
				// capability and turns every non-admin after hook into an access denial.
				if (inserts.length > 0 && !elevated) yield* access.authorize(subject, 'create', collection);
				const updated: Array<Readonly<Record<string, unknown>>> = [];
				for (let index = 0; index < updates.length; index += 1) {
					const payload = updates[index];
					if (payload === undefined) continue;
					const { id: id, ...values } = payload;
					yield* update(
						EffectId.make(`${effectId}:update:${index}`),
						subject,
						{ collection, id: String(id), values },
						depth
					);
				}
				if (updates.length > 0)
					updated.push(
						// An update whose row the predicate would not write matched nothing, exactly as a
						// refused insert does, and there is no stored row to answer with. It is left out
						// rather than answered with the patch that was submitted; every payload here names
						// its own `id`, so a caller comparing what it sent against what came back
						// can still say which ones did not land.
						...(yield* readBack(
							EffectId.make(`${effectId}:update:readback`),
							collection,
							updates.map((payload) => ({ id: String(payload['id']), values: payload }))
						)).filter((row) => row !== undefined)
					);
				const identified = inserts.map((payload) => ({
					id: randomId(),
					values: payload as Readonly<Record<string, Schema.Json>>
				}));
				// An approval-gated collection is written one row at a time, through `create`, because what
				// a gate does to a create is not "write it" — it writes the row and then holds it under an
				// approval, and each held row is its own request. Batching that would either lose the holds
				// or invent one request covering rows a reviewer has to decide on separately.
				if (hasApprovalGate(access.predicate(subject, 'create', collection))) {
					for (let index = 0; index < identified.length; index += 1) {
						const row = identified[index];
						if (row !== undefined)
							yield* create(
								EffectId.make(`${effectId}:mutate:${index}`),
								subject,
								{ collection, id: row.id, values: row.values },
								depth
							);
					}
					return [
						...updated,
						...(yield* readBack(effectId, collection, identified)).filter(
							(row) => row !== undefined
						)
					];
				}
				const size = options?.batchSize ?? identified.length;
				if (size > MAX_BATCH_ROWS)
					return yield* Effect.fail(
						new AuthoredRefusal({
							message: `A single transaction may carry ${MAX_BATCH_ROWS.toLocaleString('en')} rows; this one asks for ${size.toLocaleString('en')}. Pass a batchSize rather than relying on one transaction for all of them.`,
							collection,
							action: 'create'
						})
					);
				const written: Array<Readonly<Record<string, unknown>>> = [];
				// Sequential, deliberately. See the note above `mutateBatch`.
				for (let offset = 0; offset < identified.length; offset += Math.max(size, 1)) {
					const slice = identified.slice(offset, offset + Math.max(size, 1));
					// A single batch keeps the call's own effect id, so the ids every statement and every
					// enqueued task is filed under do not move when nobody asked for batching.
					const batchId =
						slice.length === identified.length
							? effectId
							: EffectId.make(`${effectId}:b${offset / Math.max(size, 1)}`);
					written.push(
						...(yield* mutateBatch(
							batchId,
							subject,
							collection,
							slice,
							definition,
							elevated,
							depth
						))
					);
				}
				return [...updated, ...written];
			});
			/**
			 * What the database holds for these ids, one slot per submitted row, in the order submitted.
			 *
			 * `undefined` in a slot means the row is not there, and that is a real outcome rather than an
			 * anomaly: a create's visibility predicate is a `where` on the insert, so a row the subject may
			 * not write matches nothing and inserts nothing while the rest of the batch proceeds. The read
			 * is deliberately unfiltered — it asks what exists, not what this subject may see — so an
			 * absent slot is never "stored but hidden from the reader".
			 *
			 * It used to fill an absent slot in from the caller's own submission. That handed back the
			 * payload dressed as a stored record: the write was refused, and the answer said it was a row.
			 * Everything downstream then treated the fiction as a fact — an `after` hook ran for a record
			 * that does not exist, and a change trigger was enqueued carrying it as `incoming_record`. The
			 * slot is left empty instead, and each consumer decides what an empty slot means to it; none of
			 * them may invent one.
			 */
			const readBack = Effect.fn('Collections.readBack')(function* (
				effectId: EffectId,
				collection: string,
				rows: ReadonlyArray<{
					readonly id: string;
					readonly values: Readonly<Record<string, Schema.Json>>;
				}>
			) {
				if (rows.length === 0) return [];
				const definition = yield* workspace.collection(collection);
				const table = queryTableFor(collection, definition.fields);
				const columns = columnsOf(table);
				const result = yield* executeBuilt(
					effectId,
					database,
					composer
						.select(columns)
						.from(table)
						.where(
							inArray(
								columns['id']!,
								rows.map((row) => row.id)
							)
						)
				);
				const stored = new Map<string, Readonly<Record<string, unknown>>>();
				for (const row of result.rows) {
					if (typeof row !== 'object' || row === null) continue;
					const id = Reflect.get(row, 'id');
					if (typeof id === 'string')
						stored.set(
							id,
							decodeReferenceRow(row as Readonly<Record<string, unknown>>, definition.fields)
						);
				}
				return rows.map((row) => stored.get(row.id));
			});
			const count = Effect.fn('Collections.count')(function* (effectId, subject, input) {
				const definition = yield* workspace.collection(input.collection);
				yield* access.authorize(subject, 'read', input.collection);
				const context = makeWhereContext(input.collection, definition.fields, workspace.definition);
				const compiled = yield* compiledFilter(input, context);
				// The same search the rows are read through. A count that ignored it reported the whole
				// collection under a filtered page — "1 of 335" beside three rows.
				const searched = searchClause(definition.fields, input.search);
				const visibility = access.predicate(subject, 'read', input.collection);
				// `after` is deliberately absent here. A count answers how large the filtered set is, which
				// is what a "1 of 335" reads from; counting only the rows past the cursor would shrink that
				// total on every page turn.
				const table = queryTableFor(input.collection, definition.fields);
				const result = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({ count: countRows() })
						.from(table)
						.where(
							and(compiled, queryFragment(searched), AccessControl.predicateExpression(visibility))
						)
				);
				const row = result.rows[0];
				const value =
					typeof row === 'object' && row !== null ? Reflect.get(row, 'count') : undefined;
				return typeof value === 'number' ? value : Number(value ?? 0);
			});
			const update = Effect.fn('Collections.update')(function* (
				effectId,
				subject,
				input,
				depth = 0
			) {
				yield* refuseRunawayHooks('update', input.collection, depth);
				const definition = yield* workspace.collection(input.collection);
				yield* access.authorize(subject, 'update', input.collection);
				const visibility = access.predicate(subject, 'update', input.collection);
				const module = authored.hooks[input.collection];
				const api = buildApi(effectId, subject, false, depth + 1);
				// A field mask constrains the caller, not trusted workspace code. Check the submitted patch
				// before decoding or `update.before`, so a hook may derive a server-owned field and cannot
				// erase evidence that the caller attempted to set one.
				if (
					visibility.fields !== undefined &&
					Object.keys(input.values).some((field) => !visibility.fields?.includes(field))
				) {
					return yield* new AccessControl.AccessDenied({
						action: 'update',
						resource: input.collection,
						reason: 'update includes fields outside the matching policy grant'
					});
				}
				let values = input.values;
				if (module?.update?.input !== undefined) {
					values = yield* Schema.decodeUnknownEffect(module.update.input)(values).pipe(
						Effect.mapError(
							(cause) =>
								new AccessControl.AccessDenied({
									action: 'update',
									resource: input.collection,
									reason: 'hook input validation failed'
								})
						)
					) as Effect.Effect<Readonly<Record<string, Schema.Json>>>;
				}
				// Read once and used twice where both want it. An outbound binding needs it because a
				// trigger is asked `previous.status !== record.status` and a patch alone cannot answer that;
				// the hook needs it because it always has. The read is skipped entirely when neither does,
				// so a collection with no `update` hook and no outbound binding costs nothing for it.
				const wantsPrevious =
					module?.update?.perRecord?.before !== undefined ||
					module?.update?.perRecord?.after !== undefined ||
					needsPreviousRow(input.collection, 'update') ||
					visibility.authorization !== undefined ||
					visibility.approval !== undefined;
				const existing = wantsPrevious
					? yield* readRowElevated(effectId, input.collection, input.id)
					: undefined;
				if (module?.update?.perRecord?.before !== undefined) {
					const before = yield* runHook(
						module.update.perRecord.before,
						{ input: values, existing, api },
						api,
						{ collection: input.collection, action: 'update.before' }
					);
					if (before != null && typeof before === 'object') {
						values = before as Readonly<Record<string, Schema.Json>>;
					}
				}
				values = encodeMutationValues(values, definition.fields);
				const context = {
					previous: existing ?? { id: input.id },
					changes: values,
					record: { ...(existing ?? {}), id: input.id, ...values }
				};
				yield* authorizePolicyWrite(
					EffectId.make(`${effectId}:policy-authorization`),
					subject,
					visibility,
					'update',
					input.collection,
					context
				);
				const approval = yield* resolveApproval(
					EffectId.make(`${effectId}:approval-flow`),
					subject,
					visibility,
					'update',
					input.collection,
					context
				);
				if (approval !== undefined) {
					return yield* holdForApproval(
						effectId,
						subject,
						{ ...input, values },
						'update',
						approval
					);
				}
				yield* applyUpdate(
					effectId,
					subject,
					{ ...input, values },
					definition,
					false,
					false,
					existing
				);
				if (module?.update?.perRecord?.after !== undefined) {
					const afterApi = buildApi(effectId, subject, true, depth + 1);
					const record = yield* readRowElevated(effectId, input.collection, input.id);
					yield* runHook(
						module.update.perRecord.after,
						{ previous: existing, changes: values, record, api: afterApi },
						afterApi,
						{
							collection: input.collection,
							action: 'update.after'
						}
					);
				}
				yield* emitChangeEvents(effectId, input.collection, input.id, 'updated');
			});
			const deleteRecord = Effect.fn('Collections.delete')(function* (
				effectId,
				subject,
				collection,
				id,
				depth = 0
			) {
				yield* refuseRunawayHooks('delete', collection, depth);
				const definition = yield* workspace.collection(collection);
				yield* access.authorize(subject, 'delete', collection);
				const visibility = access.predicate(subject, 'delete', collection);
				const module = authored.hooks[collection];
				const api = buildApi(effectId, subject, false, depth + 1);
				let existing: Readonly<Record<string, unknown>> | undefined;
				if (
					module?.delete?.perRecord?.before !== undefined ||
					needsPreviousRow(collection, 'delete') ||
					visibility.authorization !== undefined ||
					visibility.approval !== undefined
				) {
					// An outbound delete binding needs this read for a reason no hook has: after the statement
					// runs there is no row left to describe, so a delivery that did not capture it first can
					// only say that *something* with this id is gone.
					existing = yield* readRowElevated(effectId, collection, id);
				}
				if (module?.delete?.perRecord?.before !== undefined) {
					yield* runHook(module.delete.perRecord.before, { existing, api }, api, {
						collection,
						action: 'delete.before'
					});
				}
				const context = { record: existing ?? { id } };
				yield* authorizePolicyWrite(
					EffectId.make(`${effectId}:policy-authorization`),
					subject,
					visibility,
					'delete',
					collection,
					context
				);
				const approval = yield* resolveApproval(
					EffectId.make(`${effectId}:approval-flow`),
					subject,
					visibility,
					'delete',
					collection,
					context
				);
				if (approval !== undefined) {
					return yield* holdForApproval(
						effectId,
						subject,
						{ collection, id, values: {} },
						'delete',
						approval
					);
				}
				const record =
					module?.delete?.perRecord?.after !== undefined
						? (existing ?? (yield* readRowElevated(effectId, collection, id)))
						: undefined;
				yield* applyDelete(effectId, subject, collection, id, definition, false, existing);
				if (module?.delete?.perRecord?.after !== undefined) {
					const afterApi = buildApi(effectId, subject, true, depth + 1);
					yield* runHook(module.delete.perRecord.after, { record, api: afterApi }, afterApi, {
						collection,
						action: 'delete.after'
					});
				}
				yield* emitChangeEvents(effectId, collection, id, 'deleted');
			});
			/**
			 * The record an approval request was opened over, from whichever state the request reached.
			 *
			 * Written as one reader because `resume` and `discard` differ in what they do with the record,
			 * never in how they find it.
			 */
			const storedOperation = Effect.fn('Collections.storedOperation')(function* (
				requestId: string,
				stored: unknown
			) {
				if (stored === undefined || !isJsonObject(stored)) {
					return yield* new ApprovalConflict({
						requestId,
						reason: 'stored approval operation is missing'
					});
				}
				return yield* Schema.decodeUnknownEffect(CollectionOperation)(stored).pipe(
					Effect.mapError(
						() =>
							new ApprovalConflict({ requestId, reason: 'stored approval operation is malformed' })
					)
				);
			});

			/**
			 * Undoes the provisional write behind a request that was refused.
			 *
			 * Write-then-lock means the record exists before anyone has decided about it, so a refusal has
			 * something to clean up and cannot simply be recorded. What "clean up" means depends on the
			 * action: a rejected `create` must not be allowed to become live — releasing its lock alone
			 * would publish exactly the payroll run somebody just refused — so the provisional row goes.
			 * An `update` or `delete` was never applied, so the record is already what it should be and
			 * only the lock has to come off.
			 */
			const discard = Effect.fn('Collections.discard')(function* (
				effectId: EffectId,
				requestId: string
			) {
				const state = yield* approvals.status(effectId, requestId);
				if (state === undefined)
					return yield* new ApprovalConflict({
						requestId,
						reason: 'approval request was not found'
					});
				if (
					state._tag !== 'Rejected' &&
					state._tag !== 'ChangesRequested' &&
					state._tag !== 'Withdrawn'
				) {
					return yield* new ApprovalConflict({ requestId, reason: 'approval was not refused' });
				}
				const operation = yield* storedOperation(requestId, state.operation);
				const definition = yield* workspace.collection(operation.collection);
				if (operation.action === 'create') {
					// A declarative graph is held before any part of it is written. Rejecting it is
					// therefore already atomic cleanup: there is no provisional root (or child) to delete.
					if (operation.mode === 'declarative') return;
					yield* applyDelete(
						effectId,
						operation.subject,
						operation.collection,
						operation.id,
						definition,
						true
					);
					return;
				}
				yield* releaseLock(effectId, operation.collection, operation.id, requestId);
			});

			const resume = Effect.fn('Collections.resume')(function* (
				effectId: EffectId,
				requestId: string
			) {
				const state = yield* approvals.status(effectId, requestId);
				if (state === undefined)
					return yield* new ApprovalConflict({
						requestId,
						reason: 'approval request was not found'
					});
				yield* approvals.authorizeResume(state);
				const operation = yield* storedOperation(requestId, state.operation);
				const definition = yield* workspace.collection(operation.collection);
				if (
					(operation.action === 'create' || operation.action === 'update') &&
					operation.mode === 'declarative'
				) {
					// The approval operation stores the original root graph as one durable value. Rebuild
					// the canonical plan only after the final decision, then reconcile every explicitly
					// included relationship inside the same transaction as the root. `approved` bypasses
					// only approval interception; authorization, predicates, hooks and validation still run.
					yield* synchronizeGraph(
						effectId,
						operation.subject,
						operation.collection,
						{ ...operation.values, id: operation.id },
						false,
						0,
						{
							approved: true,
							rootId: operation.id,
							rootAction: operation.action,
							clearRootLock: operation.action === 'update',
							approvalRequestId: requestId,
							...(operation.review === undefined ? {} : { review: operation.review })
						}
					).pipe(
						Effect.catchTag('Bolt.Collections.PendingApproval', (pending) =>
							Effect.fail(
								new ApprovalConflict({
									requestId: pending.requestId,
									reason: 'approved mutation graph unexpectedly requested a new approval'
								})
							)
						),
						Effect.catchCause((cause) =>
							Effect.gen(function* () {
								if (!Cause.hasInterruptsOnly(cause)) {
									yield* approvals
										.conflict(
											EffectId.make(`${effectId}:approval-settlement-conflict`),
											requestId,
											'the reviewed mutation graph could not be settled'
										)
										.pipe(Effect.ignore);
								}
								return yield* Effect.failCause(cause);
							})
						)
					);
					return;
				}
				switch (operation.action) {
					case 'create': {
						// The row was written when the create was intercepted, so approving it releases the
						// lock rather than inserting anything — re-applying would collide with the row that is
						// already there. `create.after` runs here and not at write time because that is what
						// "approved" means for a created record: the engine, the notification, the side effect
						// the workspace attached to a real one, all of which must not fire for a record still
						// waiting on a decision.
						yield* releaseLock(effectId, operation.collection, operation.id, requestId);
						const createdModule = authored.hooks[operation.collection];
						if (createdModule?.create?.perRecord?.after !== undefined) {
							const api = buildApi(effectId, operation.subject, true);
							const record = yield* readRowElevated(effectId, operation.collection, operation.id);
							yield* runHook(createdModule.create.perRecord.after, { record, api }, api, {
								collection: operation.collection,
								action: 'create.after'
							});
						}
						yield* emitChangeEvents(effectId, operation.collection, operation.id, 'created');
						return;
					}
					case 'update': {
						const previous = yield* readRowElevated(effectId, operation.collection, operation.id);
						yield* applyUpdate(
							effectId,
							operation.subject,
							operation,
							definition,
							true,
							false,
							previous
						);
						const updatedModule = authored.hooks[operation.collection];
						if (updatedModule?.update?.perRecord?.after !== undefined) {
							const api = buildApi(effectId, operation.subject, true);
							const record = yield* readRowElevated(effectId, operation.collection, operation.id);
							yield* runHook(
								updatedModule.update.perRecord.after,
								{ previous, changes: operation.values, record, api },
								api,
								{
									collection: operation.collection,
									action: 'update.after'
								}
							);
						}
						yield* emitChangeEvents(effectId, operation.collection, operation.id, 'updated');
						return;
					}
					case 'delete': {
						const record = yield* readRowElevated(effectId, operation.collection, operation.id);
						yield* applyDelete(
							effectId,
							operation.subject,
							operation.collection,
							operation.id,
							definition,
							false,
							record
						);
						const deletedModule = authored.hooks[operation.collection];
						if (deletedModule?.delete?.perRecord?.after !== undefined) {
							const api = buildApi(effectId, operation.subject, true);
							yield* runHook(deletedModule.delete.perRecord.after, { record, api }, api, {
								collection: operation.collection,
								action: 'delete.after'
							});
						}
						yield* emitChangeEvents(effectId, operation.collection, operation.id, 'deleted');
						return;
					}
					default: {
						const _exhaustive: never = operation.action;
						return yield* new ApprovalConflict({
							requestId,
							reason: `unsupported stored action ${_exhaustive}`
						});
					}
				}
			});
			return Service.of({
				findMany,
				approvalFindFirst: (effectId, subject, input) =>
					findMany(effectId, subject, {
						collection: 'approval_request',
						...input,
						limit: 1
					}).pipe(Effect.map((rows) => rows[0])),
				findFirst: Effect.fn('Collections.findFirst')(function* (effectId, subject, input) {
					return (yield* findMany(effectId, subject, { ...input, limit: 1 }))[0];
				}),
				findNearest,
				count,
				create,
				createMany,
				mutate: (effectId, subject, collection, payloads, elevated = false, depth = 0, options) =>
					mutate(effectId, subject, collection, payloads, elevated, depth, options),
				update,
				delete: deleteRecord,
				resume,
				discard,
				import: Effect.fn('Collections.import')(function* (effectId, subject, inputs) {
					const pipeline = authored.pipelines[inputs[0]?.collection ?? ''];
					// The handler is bound to a local before the guard, rather than reached through
					// `pipeline.import` inside the thunk below. A narrowing does not survive into a closure —
					// TypeScript has to assume `pipeline` was reassigned by the time the thunk runs — so the
					// deferred form this now takes turned a checked access into an unchecked one. On a
					// collection with no import pipeline that is a real throw, not a type complaint.
					const declared = pipeline?.import;
					if (declared !== undefined) {
						const api = buildApi(effectId, subject);
						/**
						 * The handler is given the document that was posted, not an array of them.
						 *
						 * An import is one workbook, and an authored `import` schema says so: every one of them
						 * is a `Schema.Struct` carrying the header fields the sheet is read under — the roster
						 * to attach to, the month, the legal entity, the timezone — with the rows nested
						 * inside. Those header fields have no row to ride on, which is why the document is the
						 * unit and not the row.
						 *
						 * This wrapped the values in an array, so every pipeline decoded an array against a
						 * struct and threw before reading anything. Nothing caught it: `CollectionPipelines`
						 * types the handler context as `{ input: unknown }`, so the mismatch was invisible to
						 * the compiler, and the code below already assumed one input and many rows — it
						 * resolves each output row's collection as `inputs[index] ?? inputs[0]`.
						 */
						const document = inputs[0]?.values;
						const rows = yield* runAuthoredHandler(() =>
							declared.handler({ input: document, api }, api)
						);
						if (!Array.isArray(rows)) {
							return yield* new AccessControl.AccessDenied({
								action: 'import',
								resource: inputs[0]?.collection ?? '',
								reason: 'import pipeline returned no rows'
							});
						}
						yield* createMany(
							effectId,
							subject,
							rows.map((row, index) => ({
								collection: inputs[index]?.collection ?? inputs[0]?.collection ?? '',
								id:
									typeof row === 'object' &&
									row !== null &&
									typeof Reflect.get(row, 'id') === 'string'
										? (Reflect.get(row, 'id') as string)
										: deriveRecordId(`${inputs[0]?.collection ?? ''}:${effectId}:${index}`),
								values: row as Readonly<Record<string, Schema.Json>>
							}))
						);
						return rows.length;
					}
					yield* createMany(effectId, subject, inputs);
					return inputs.length;
				}),
				export: Effect.fn('Collections.export')(function* (effectId, subject, input) {
					// Bound before the guard, for the reason `import` above is: the thunk defers the call past
					// the point where the narrowing holds.
					const declared = authored.pipelines[input.collection]?.export;
					if (declared !== undefined) {
						const api = buildApi(effectId, subject);
						const records = yield* findMany(effectId, subject, input);
						return yield* runAuthoredHandler(() => declared.handler({ records, api }, api));
					}
					return yield* findMany(effectId, subject, input);
				}) as Interface['export'],
				history: Effect.fn('Collections.history')(function* (effectId, subject, collection, id) {
					yield* workspace.collection(collection);
					yield* access.authorize(subject, 'history', collection);
					const result = yield* executeBuilt(
						effectId,
						database,
						composer
							.select({
								sequence: collectionHistoryTable.sequence,
								created_at: collectionHistoryTable.created_at,
								snapshot: collectionHistoryTable.snapshot
							})
							.from(collectionHistoryTable)
							.where(
								and(
									eq(collectionHistoryTable.collection_name, collection),
									eq(collectionHistoryTable.record_id, id)
								)
							)
							.orderBy(asc(collectionHistoryTable.sequence))
					);
					const rows = yield* Schema.decodeUnknownEffect(
						Schema.Array(PersistedCollectionHistoryRow)
					)(result.rows).pipe(
						Effect.mapError(
							() =>
								new Database.FacilityError({
									operation: 'collections.history',
									code: 'malformed_persistence',
									message: 'Stored collection history rows do not satisfy the history schema',
									retryable: false,
									outcome: 'known'
								})
						)
					);
					return collectionHistorySnapshots(rows);
				})
			});
		})
	);

export const layer = layerWith();
