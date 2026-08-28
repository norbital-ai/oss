import { deriveRecordId } from '#lib/runtime/derive-record-id.js';
import {
	and,
	asc,
	count as countRows,
	eq,
	getColumns,
	inArray,
	isNotNull,
	sql,
	type AnyDBQueryConfig,
	type SQL,
	type SQLChunk
} from 'drizzle-orm';
import { alias as tableAlias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { Cause, Clock, Context, Effect, Layer, Result, Schema, SchemaAST } from 'effect';
import {
	CollectionMutationBaseVersion,
	CollectionMutationDeviceSequence,
	CollectionMutationIdempotencyKey,
	COLLECTION_MUTATION_RETRY_HORIZON_MILLIS,
	COLLECTION_MUTATION_SCHEMA_COMPATIBILITY_HORIZON_MILLIS,
	EffectId
} from '@norbital-ai/bolt-protocol';
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
	compileSearch,
	compileWhere,
	makeWhereContext,
	whereExpression,
	WhereCompileError,
	type OrderTerm,
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
	type BrowserMutationFence,
	type BrowserMutationConfirmation,
	type BrowserMutationDelivery,
	type BrowserMutationRejection,
	type BrowserMutationPartitionBinding,
	type BrowserMutationPartitionIdentity,
	BrowserMutationBegin,
	BrowserMutationOutcome,
	type BrowserMutationScope,
	type CollectionHistorySnapshot,
	type Interface,
	MutationIdempotencyConflict,
	MutationInProgress,
	type MutationError,
	type MutationInput,
	type MutationPhase,
	MutationRetryExpired,
	MutationQuarantined,
	MutationVersionConflict,
	type QueryError,
	type NearestQueryInput,
	type QueryInput,
	type QueryRow,
	type ResumeError
} from './collections.contract.js';
export {
	BrowserMutationOutcome,
	BrowserMutationBegin,
	MutationPhaseFailure,
	MutationIdempotencyConflict,
	MutationInProgress,
	MutationRetryExpired,
	MutationQuarantined,
	MutationVersionConflict,
	PendingApproval,
	Service,
	mutationPhaseFailure
} from './collections.contract.js';
export type {
	Interface,
	BatchMutationError,
	BrowserMutationFence,
	BrowserMutationConfirmation,
	BrowserMutationDelivery,
	BrowserMutationRejection,
	BrowserMutationScope,
	BrowserMutationPartitionBinding,
	BrowserMutationPartitionIdentity,
	CollectionHistorySnapshot,
	MutationError,
	QueryError,
	ResumeError
} from './collections.contract.js';
import { collectionQueryTable, relationalSchema } from '#lib/compiler/relational-schema.js';
import {
	orderingExpressions,
	planRelations,
	readRelationalRows,
	ROOT_ALIAS,
	type MaskRow,
	type PlanContext
} from '#lib/runtime/collections/relation-query.js';
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
	makePolicyDecisionApi,
	MAX_STRUCTURED_INFERENCE_OUTPUT_TOKENS,
	runAuthoredHandler,
	runAutomationOp,
	inferenceTurnContent,
	type AuthoringOps,
	type AuthoringReadOps,
	type AuthoredCollectionHookModule,
	type RuntimeAuthoringApi
} from '#lib/runtime/collections/authored.js';
import { AuthoredRefusal, refusalAt, type RefusalSite } from '#lib/authoring/refusal.js';
import * as InvocationBudget from '#lib/runtime/budget.js';
import { approvalFlowDescriptor } from '#lib/authoring/approval-flow.js';
import { approvalStepId } from '#lib/authoring/policy-introspection.js';
import {
	aliased,
	always,
	composer,
	executeBuilt,
	lessThanOrEqual,
	relationalComposer,
	rowJson,
	toStatement,
	transactionSql,
	vectorDistance,
	type RelationalBuilder
} from '#lib/runtime/persistence.js';

const {
	bolt_collection_history: collectionHistoryTable,
	bolt_integration_outbox: integrationOutboxTable
} = SYSTEM_MODEL_TABLES;

/** The pgvector operator each accepted metric measures with. */
const NEAREST_OPERATORS = { cosine: '<=>', l2: '<->', ip: '<#>' } as const;

/** Browser mutation dedup is private runtime bookkeeping and is never a queryable collection. */
const BROWSER_MUTATION_TABLE = 'bolt_browser_mutation';
const BROWSER_PARTITION_REGISTRY_TABLE = 'bolt_sync_partition_registry';
/** Keep answers past the 14-day offline compatibility horizon so cleanup cannot reopen a key. */
export const BROWSER_MUTATION_RETENTION_MILLIS = 21 * 24 * 60 * 60 * 1000;
/** Opportunistic bounded cleanup; mutation latency can never grow with the ledger. */
const BROWSER_MUTATION_CLEANUP_LIMIT = 256;
/** Physical partitions outlive every schema adapter that may still refer to them. */
const BROWSER_PARTITION_RETENTION_MILLIS = 21 * 24 * 60 * 60 * 1000;
const BROWSER_PARTITION_CLEANUP_LIMIT = 128;
/**
 * The evaluator lease outlives every request the server can still accept for this key.
 *
 * Taking a running claim over inside the retry horizon would evaluate authored hooks twice after a
 * slow or partitioned first invocation. Five minutes of accepted future clock skew is included so
 * even a key minted just ahead of the server expires as a request before its evaluator lease does.
 * A crashed evaluator therefore resolves as explicit expiry, never as a second evaluation.
 */
const BROWSER_MUTATION_LEASE_SECONDS =
	(Math.max(
		COLLECTION_MUTATION_RETRY_HORIZON_MILLIS,
		COLLECTION_MUTATION_SCHEMA_COMPATIBILITY_HORIZON_MILLIS
	) +
		5 * 60 * 1000) /
	1000;

/** Internal control signal when another invocation won the same durable key concurrently. */
class BrowserMutationReplay extends Error {
	readonly outcome: BrowserMutationOutcome;

	constructor(outcome: BrowserMutationOutcome) {
		super('Browser mutation already has a durable outcome.');
		this.outcome = outcome;
	}
}

const isBrowserMutationReplay = (cause: unknown): cause is BrowserMutationReplay =>
	cause instanceof BrowserMutationReplay;

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
const PersistedCollectionHistoryRow = Schema.Struct({
	sequence: Schema.Number,
	created_at: Schema.String,
	snapshot: Schema.NullOr(JsonObject)
});
type PersistedCollectionHistoryRow = typeof PersistedCollectionHistoryRow.Type;
/** The `JsonObject` predicate, built once: it is consulted for every row the facility hands back. */
const isJsonObject = Schema.is(JsonObject);
const queryRowOf = Schema.decodeUnknownSync(JsonObject);
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

/** Maximum exact grouped membership; the SQL query fails closed instead of truncating past it. */
const GROUPED_RESULT_LIMIT = 5000;
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
/**
 * Immutable browser provenance retained by an approval operation.
 *
 * Approval may outlive the invocation that acquired it. Keeping the complete fence beside the
 * reviewed operation lets resume close the original ledger row and attribute its authoritative
 * outbox entries to the original browser mutation rather than inventing a replacement identity.
 */
const StoredBrowserMutationFence = Schema.Struct({
	scope: Schema.Struct({
		tenantId: Schema.NonEmptyString,
		environment: Schema.NonEmptyString,
		principalId: Schema.NonEmptyString,
		authorityId: Schema.NonEmptyString,
		command: Schema.Literal('collections.mutate')
	}),
	idempotencyKey: CollectionMutationIdempotencyKey,
	requestDigest: Schema.NonEmptyString,
	issuedAtEpochMs: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThan(0),
		Schema.isFinite()
	),
	deviceSequence: CollectionMutationDeviceSequence,
	partitionKey: Schema.NonEmptyString,
	schemaFingerprint: Schema.NonEmptyString,
	currentSchemaFingerprint: Schema.NonEmptyString,
	baseVersions: Schema.Array(CollectionMutationBaseVersion),
	outcome: BrowserMutationOutcome
});
const CollectionOperation = Schema.Struct({
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	values: Schema.Record(Schema.String, Schema.Json),
	action: CollectionAction,
	subject: Subject,
	mode: Schema.optionalKey(Schema.Literal('declarative')),
	review: Schema.optionalKey(DeclarativeReview),
	browserMutation: Schema.optionalKey(StoredBrowserMutationFence)
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

/**
 * The same declared `input`, with every column optional.
 *
 * There is one write and one shape for it, and the shape is stated as a record: `schema('x', {
 * columns: { … } })` names the columns a caller may send. On a create that record is what a caller
 * must send, so it decodes as declared. On an update the caller sends a patch — the columns it is
 * changing and no others — so decoding it against a shape that requires all of them would refuse
 * every partial write. The declaration does not change; what a patch is checked against is this.
 *
 * Effect v4 has no `Schema.partial`, and the runtime holds an erased `Schema.Codec` rather than the
 * `Struct` an author built, so this rebuilds the struct from the one thing that survives erasure:
 * the AST's property signatures, each re-wrapped with `optionalKey`. `Suspend` is resolved on the
 * way, because `schema()` returns one so that a shape declared at module init does not need the
 * collection registry populated yet.
 *
 * A declaration whose AST is not an object is refused rather than ignored. `input` describes a
 * record; one that describes a string is a mistake in the workspace, and the write that discovers it
 * should say so instead of quietly writing every column the caller sent.
 */
const objectAst = (ast: SchemaAST.AST): SchemaAST.Objects | undefined => {
	let current = ast;
	// Bounded rather than recursive: a `Suspend` whose thunk returns another `Suspend` is legal, and
	// one that returns itself is a workspace that would otherwise hang the isolate here.
	for (let hop = 0; hop < 8; hop += 1) {
		if (current._tag === 'Objects') return current;
		if (current._tag !== 'Suspend') return undefined;
		current = current.thunk();
	}
	return undefined;
};

const partialInputs = new WeakMap<object, Schema.Codec<unknown, unknown>>();

const partialInput = (
	collection: string,
	input: Schema.Codec<unknown, unknown>
): Schema.Codec<unknown, unknown> => {
	const cached = partialInputs.get(input);
	if (cached !== undefined) return cached;
	const objects = objectAst(input.ast);
	if (objects === undefined)
		throw new TypeError(
			`${collection} declares an \`input\` that is not a record, so a partial write cannot be checked against it. \`export const input\` names the columns a caller may send.`
		);
	const fields: Record<PropertyKey, Schema.Top> = {};
	for (const property of objects.propertySignatures)
		fields[property.name] = Schema.optionalKey(Schema.make<Schema.Top>(property.type));
	// The one cast: `Schema.Struct` is exact about the fields it was handed and the runtime carries
	// every authored schema erased, which is the same erasure `input` itself arrives under.
	const built = Schema.Struct(fields) as unknown as Schema.Codec<unknown, unknown>;
	partialInputs.set(input, built);
	return built;
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
	const authored =
		input.where === undefined
			? Result.succeed(
					queryFragment(
						input.predicate === undefined
							? { sql: 'true', parameters: [] }
							: compilePredicate(input.predicate)
					)
				)
			: Result.map(compileWhere(input.where, context), whereExpression);
	if (Result.isFailure(authored)) return Effect.fail(authored.failure);
	if (input.userFilter === undefined) return Effect.succeed(authored.success);
	const narrowed = compileWhere(input.userFilter, context);
	return Result.isFailure(narrowed)
		? Effect.fail(narrowed.failure)
		: Effect.succeed(and(authored.success, whereExpression(narrowed.success)) ?? authored.success);
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
			/** The authenticated composite key, in the same order as the unique database index. */
			const browserMutationScopeParameters = (
				scope: BrowserMutationScope,
				idempotencyKey: BrowserMutationFence['idempotencyKey']
			): ReadonlyArray<Schema.Json> => [
				scope.tenantId,
				scope.environment,
				scope.principalId,
				scope.authorityId,
				scope.command,
				idempotencyKey
			];
			const invalidBrowserMutationLedger = (message: string) =>
				new Database.FacilityError({
					operation: 'browser-mutation-ledger',
					code: 'invalid_mutation_ledger',
					message,
					retryable: false,
					outcome: 'known'
				});
			const browserPartitionBindingParameters = (
				binding: BrowserMutationPartitionBinding
			): ReadonlyArray<Schema.Json> => [
				binding.tenantId,
				binding.environment,
				binding.actorId,
				binding.effectiveSubjectId,
				binding.impersonationBinding
			];
			const browserPartitionIdentityOf = (
				value: unknown
			): BrowserMutationPartitionIdentity | undefined => {
				if (!isJsonObject(value)) return undefined;
				const key = value['key'];
				const tenantId = value['tenantId'];
				const environment = value['environment'];
				const effectivePolicyHolder = value['effectivePolicyHolder'];
				const impersonationTarget = value['impersonationTarget'];
				const authorityGeneration = value['authorityGeneration'];
				const schemaFingerprint = value['schemaFingerprint'];
				if (
					typeof key !== 'string' ||
					key.length === 0 ||
					typeof tenantId !== 'string' ||
					tenantId.length === 0 ||
					typeof environment !== 'string' ||
					environment.length === 0 ||
					typeof effectivePolicyHolder !== 'string' ||
					effectivePolicyHolder.length === 0 ||
					(impersonationTarget !== null &&
						(typeof impersonationTarget !== 'string' || impersonationTarget.length === 0)) ||
					typeof authorityGeneration !== 'number' ||
					!Number.isSafeInteger(authorityGeneration) ||
					authorityGeneration < 0 ||
					typeof schemaFingerprint !== 'string' ||
					schemaFingerprint.length === 0
				)
					return undefined;
				return {
					key,
					tenantId,
					environment,
					effectivePolicyHolder,
					impersonationTarget,
					authorityGeneration,
					schemaFingerprint
				};
			};
			const registerBrowserMutationPartition = Effect.fn(
				'Collections.registerBrowserMutationPartition'
			)(function* (
				effectId: EffectId,
				binding: BrowserMutationPartitionBinding,
				identity: BrowserMutationPartitionIdentity
			) {
				if (
					identity.tenantId !== binding.tenantId ||
					identity.environment !== binding.environment
				)
					return yield* invalidBrowserMutationLedger(
						'The physical sync partition identity does not match its tenant/environment binding.'
					);
				const retentionSeconds = BROWSER_PARTITION_RETENTION_MILLIS / 1000;
				const parameters: ReadonlyArray<Schema.Json> = [
					identity.key,
					...browserPartitionBindingParameters(binding),
					identity.schemaFingerprint,
					identity.authorityGeneration,
					identity as Schema.Json,
					retentionSeconds,
					BROWSER_PARTITION_CLEANUP_LIMIT
				];
				const result = yield* database.execute(effectId, {
					_tag: 'Query',
					// repository-health:allow SQL1 -- fixed private tables; identity values are bound.
					sql: `with cleaned as (delete from ${BROWSER_PARTITION_REGISTRY_TABLE} as registry where registry.ctid in (select candidate.ctid from ${BROWSER_PARTITION_REGISTRY_TABLE} as candidate where candidate.expires_at < now() and not exists (select 1 from ${BROWSER_MUTATION_TABLE} as mutation where mutation.partition_key = candidate.partition_key and mutation.status = 'terminal' and mutation.outcome->>'_tag' = 'Quarantined') order by candidate.expires_at limit $11)), issued as (insert into ${BROWSER_PARTITION_REGISTRY_TABLE} (partition_key, tenant_id, environment, actor_id, effective_subject_id, impersonation_binding, schema_fingerprint, authority_generation, identity, issued_at, last_seen_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), now(), now() + make_interval(secs => $10)) on conflict (partition_key, tenant_id, environment, actor_id, effective_subject_id, impersonation_binding) do update set last_seen_at = now(), expires_at = greatest(${BROWSER_PARTITION_REGISTRY_TABLE}.expires_at, excluded.expires_at) where ${BROWSER_PARTITION_REGISTRY_TABLE}.identity = excluded.identity returning partition_key) select partition_key from issued`,
					parameters
				});
				if (result.rows.length === 0)
					return yield* invalidBrowserMutationLedger(
						'The physical sync partition key is already registered to different authenticated facts.'
					);
				return identity;
			});
			const browserMutationPartition = Effect.fn('Collections.browserMutationPartition')(
				function* (
					effectId: EffectId,
					binding: BrowserMutationPartitionBinding,
					partitionKey: string
				) {
					const result = yield* database.execute(effectId, {
						_tag: 'Query',
						// repository-health:allow SQL1 -- fixed private table; every lookup value is bound.
						sql: `update ${BROWSER_PARTITION_REGISTRY_TABLE} set last_seen_at = now() where partition_key = $1 and tenant_id = $2 and environment = $3 and actor_id = $4 and effective_subject_id = $5 and impersonation_binding = $6 returning identity, schema_fingerprint, authority_generation`,
						parameters: [partitionKey, ...browserPartitionBindingParameters(binding)]
					});
					const row = result.rows[0];
					if (row === undefined) return undefined;
					if (!isJsonObject(row))
						return yield* invalidBrowserMutationLedger(
							'The physical sync partition registry returned a non-object row.'
						);
					const identity = browserPartitionIdentityOf(row['identity']);
					if (
						identity === undefined ||
						identity.key !== partitionKey ||
						identity.tenantId !== binding.tenantId ||
						identity.environment !== binding.environment ||
						identity.schemaFingerprint !== row['schema_fingerprint'] ||
						identity.authorityGeneration !== row['authority_generation']
					)
						return yield* invalidBrowserMutationLedger(
							'The physical sync partition registry contains an invalid identity.'
						);
					return identity;
				}
			);
			const browserMutationDelivery = Effect.fn(
				'Collections.browserMutationDelivery'
			)(function* (
				effectId: EffectId,
				scope: BrowserMutationScope,
				idempotencyKeys: ReadonlyArray<string>,
				through: Readonly<{ readonly xid: number; readonly sequence: number }>
			) {
				if (idempotencyKeys.length === 0)
					return {
						ownedMutationIds: [],
						confirmations: [],
						rejections: []
					} satisfies BrowserMutationDelivery;
				const unique = [...new Set(idempotencyKeys)];
				const keyPlaceholders = unique.map((_, index) => `$${index + 6}`).join(', ');
				const result = yield* database.execute(effectId, {
					_tag: 'Query',
					// repository-health:allow SQL1 -- fixed private table; the bounded IN list contains placeholders only.
					sql: `select idempotency_key, status, outcome, confirmed_xid, confirmed_sequence from ${BROWSER_MUTATION_TABLE} where tenant_id = $1 and environment = $2 and principal_id = $3 and authority_id = $4 and command = $5 and idempotency_key in (${keyPlaceholders}) order by idempotency_key`,
					parameters: [
						scope.tenantId,
						scope.environment,
						scope.principalId,
						scope.authorityId,
						scope.command,
						...unique
					]
				});
				const ownedMutationIds: Array<string> = [];
				const confirmations: Array<BrowserMutationConfirmation> = [];
				const rejections: Array<BrowserMutationRejection> = [];
				for (const row of result.rows) {
					if (!isJsonObject(row))
						return yield* invalidBrowserMutationLedger(
							'The browser mutation confirmation query returned a non-object row.'
						);
					const mutationId = row['idempotency_key'];
					if (typeof mutationId !== 'string' || mutationId.length === 0)
						return yield* invalidBrowserMutationLedger(
							'The browser mutation delivery query returned an invalid identity.'
						);
					ownedMutationIds.push(mutationId);
					if (row['status'] === 'running') continue;
					if (row['status'] !== 'terminal')
						return yield* invalidBrowserMutationLedger(
							'The browser mutation delivery query returned an unknown status.'
						);
					const outcome = yield* Schema.decodeUnknownEffect(BrowserMutationOutcome)(
						row['outcome']
					).pipe(
						Effect.mapError(() =>
							invalidBrowserMutationLedger(
								'The browser mutation delivery query returned an invalid durable outcome.'
							)
						)
					);
					if (outcome._tag === 'Rejected') {
						rejections.push({
							mutationId,
							code: outcome.code,
							message: outcome.message
						});
						continue;
					}
					if (outcome._tag !== 'Committed') continue;
					if (row['confirmed_xid'] == null || row['confirmed_sequence'] == null) continue;
					const xid =
						typeof row['confirmed_xid'] === 'number'
							? row['confirmed_xid']
							: Number(row['confirmed_xid']);
					const sequence =
						typeof row['confirmed_sequence'] === 'number'
							? row['confirmed_sequence']
							: Number(row['confirmed_sequence']);
					if (
						!Number.isSafeInteger(xid) ||
						xid < 0 ||
						!Number.isSafeInteger(sequence) ||
						sequence < 0
					)
						return yield* invalidBrowserMutationLedger(
							'The browser mutation confirmation query returned an invalid cursor.'
						);
					if (xid < through.xid || (xid === through.xid && sequence <= through.sequence))
						confirmations.push({ mutationId, cursor: { xid, sequence } });
				}
				return {
					ownedMutationIds,
					confirmations,
					rejections
				} satisfies BrowserMutationDelivery;
			});
			/**
			 * Reads a previously committed answer before authored code runs.
			 *
			 * The key is useful only with the canonical request digest. Reusing it for a changed body is a
			 * conflict, not a cache miss: treating it as new would turn an idempotency control into an
			 * attacker-selected alias for unrelated writes.
			 */
			const browserMutationOutcome = Effect.fn('Collections.browserMutationOutcome')(function* (
				effectId: EffectId,
				scope: BrowserMutationScope,
				idempotencyKey: BrowserMutationFence['idempotencyKey'],
				requestDigest: string
			) {
				// repository-health:allow SQL1 -- fixed private table; every scope value remains bound.
				const result = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: `select request_digest, status, outcome from ${BROWSER_MUTATION_TABLE} where tenant_id = $1 and environment = $2 and principal_id = $3 and authority_id = $4 and command = $5 and idempotency_key = $6 limit 1`,
					parameters: browserMutationScopeParameters(scope, idempotencyKey)
				});
				const row = result.rows[0];
				if (row === undefined) return undefined;
				if (!isJsonObject(row))
					return yield* invalidBrowserMutationLedger(
						'The browser mutation ledger returned a non-object row.'
					);
				if (row['request_digest'] !== requestDigest)
					return yield* new MutationIdempotencyConflict({ idempotencyKey });
				if (row['status'] === 'running') return undefined;
				if (row['status'] !== 'terminal')
					return yield* invalidBrowserMutationLedger(
						'The browser mutation ledger contains an unknown status.'
					);
				return yield* Schema.decodeUnknownEffect(BrowserMutationOutcome)(row['outcome']).pipe(
					Effect.mapError(() =>
						invalidBrowserMutationLedger(
							'The browser mutation ledger contains an invalid durable outcome.'
						)
					)
				);
			});
			const beginBrowserMutation = Effect.fn('Collections.beginBrowserMutation')(function* (
				effectId: EffectId,
				fence: BrowserMutationFence
			) {
				const insertParameters: ReadonlyArray<Schema.Json> = [
					...browserMutationScopeParameters(fence.scope, fence.idempotencyKey),
					fence.deviceSequence,
					fence.partitionKey,
					fence.schemaFingerprint,
					fence.requestDigest,
					fence.issuedAtEpochMs,
					BROWSER_MUTATION_RETENTION_MILLIS,
					BROWSER_MUTATION_LEASE_SECONDS,
					BROWSER_MUTATION_CLEANUP_LIMIT
				];
				// repository-health:allow SQL1 -- fixed private table; cleanup and claim are one bounded statement.
				const inserted = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: `with cleaned as (delete from ${BROWSER_MUTATION_TABLE} where ctid in (select ctid from ${BROWSER_MUTATION_TABLE} where expires_at < now() order by expires_at limit $14)), claimed as (insert into ${BROWSER_MUTATION_TABLE} (tenant_id, environment, principal_id, authority_id, command, idempotency_key, device_sequence, partition_key, schema_fingerprint, request_digest, status, issued_at, lease_expires_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'running', to_timestamp($11 / 1000.0), now() + make_interval(secs => $13), to_timestamp(($11 + $12) / 1000.0)) on conflict (tenant_id, environment, principal_id, authority_id, command, idempotency_key) do nothing returning id) select id from claimed`,
					parameters: insertParameters
				});
				if (inserted.rows.length > 0) return { _tag: 'Acquired' } as const;

				// repository-health:allow SQL1 -- fixed private table; every scope value remains bound.
				const current = yield* database.execute(EffectId.make(`${effectId}:current`), {
					_tag: 'Query',
					sql: `select request_digest, status, outcome, greatest(1, ceil(extract(epoch from (lease_expires_at - now()))))::integer as retry_after_seconds from ${BROWSER_MUTATION_TABLE} where tenant_id = $1 and environment = $2 and principal_id = $3 and authority_id = $4 and command = $5 and idempotency_key = $6 limit 1`,
					parameters: browserMutationScopeParameters(fence.scope, fence.idempotencyKey)
				});
				const row = current.rows[0];
				if (!isJsonObject(row))
					return yield* invalidBrowserMutationLedger(
						'The browser mutation claim disappeared before it could be observed.'
					);
				if (row['request_digest'] !== fence.requestDigest)
					return yield* new MutationIdempotencyConflict({
						idempotencyKey: fence.idempotencyKey
					});
				if (row['status'] === 'terminal') {
					const outcome = yield* Schema.decodeUnknownEffect(BrowserMutationOutcome)(
						row['outcome']
					).pipe(
						Effect.mapError(() =>
							invalidBrowserMutationLedger(
								'The browser mutation ledger contains an invalid durable outcome.'
							)
						)
					);
					return BrowserMutationBegin.cases.Replay.make({ outcome });
				}
				if (row['status'] !== 'running')
					return yield* invalidBrowserMutationLedger(
						'The browser mutation ledger contains an unknown status.'
					);

				// Defensive recovery for a clock correction or manually repaired timestamp. In normal
				// operation dispatch rejects the request as expired before this lease can be taken over.
				const takeover = yield* database.execute(EffectId.make(`${effectId}:takeover`), {
					_tag: 'Query',
					// repository-health:allow SQL1 -- fixed private table; the authenticated key remains bound.
					sql: `update ${BROWSER_MUTATION_TABLE} set lease_expires_at = now() + make_interval(secs => $7) where tenant_id = $1 and environment = $2 and principal_id = $3 and authority_id = $4 and command = $5 and idempotency_key = $6 and request_digest = $8 and status = 'running' and lease_expires_at <= now() returning id`,
					parameters: [
						...browserMutationScopeParameters(fence.scope, fence.idempotencyKey),
						BROWSER_MUTATION_LEASE_SECONDS,
						fence.requestDigest
					]
				});
				if (takeover.rows.length > 0) return { _tag: 'Acquired' } as const;
				const retryAfter = row['retry_after_seconds'];
				return BrowserMutationBegin.cases.InProgress.make({
					retryAfterSeconds:
						typeof retryAfter === 'number' && Number.isInteger(retryAfter) && retryAfter > 0
							? retryAfter
							: 1
				});
			});

			/** Persists a no-write terminal answer (approval acquisition or an explicit conflict). */
			const rememberBrowserMutationOutcome = Effect.fn(
				'Collections.rememberBrowserMutationOutcome'
			)(function* (
				effectId: EffectId,
				fence: BrowserMutationFence,
				outcome: BrowserMutationOutcome
			) {
				const parameters: ReadonlyArray<Schema.Json> = [
					...browserMutationScopeParameters(fence.scope, fence.idempotencyKey),
					fence.requestDigest,
					outcome
				];
				// repository-health:allow SQL1 -- completes only the live authenticated claim.
				yield* database.execute(effectId, {
					_tag: 'Query',
					sql: `update ${BROWSER_MUTATION_TABLE} set status = 'terminal', outcome = $8::jsonb, lease_expires_at = null where tenant_id = $1 and environment = $2 and principal_id = $3 and authority_id = $4 and command = $5 and idempotency_key = $6 and request_digest = $7 and status = 'running'`,
					parameters
				});
				return yield* browserMutationOutcome(
					EffectId.make(`${effectId}:verify`),
					fence.scope,
					fence.idempotencyKey,
					fence.requestDigest
				);
			});
			const replayBrowserMutationOutcome = (
				outcome: BrowserMutationOutcome
			): Effect.Effect<
				never,
				| PendingApproval
				| MutationVersionConflict
				| BrowserMutationReplay
				| MutationQuarantined
				| AuthoredRefusal
				| AccessControl.AccessDenied
			> => {
				switch (outcome._tag) {
					case 'Committed':
						return Effect.fail(new BrowserMutationReplay(outcome));
					case 'PendingApproval':
						return Effect.fail(
							new PendingApproval({
								requestId: outcome.requestId,
								collection: outcome.collection,
								id: outcome.id,
								action: outcome.action
							})
						);
					case 'VersionConflict':
						return Effect.fail(
							new MutationVersionConflict({
								collection: outcome.collection,
								id: outcome.id,
								baseVersion: outcome.baseVersion,
								currentVersion: outcome.currentVersion
							})
						);
					case 'Rejected':
						return outcome.code === 'refused'
							? Effect.fail(
									new AuthoredRefusal({
										/**
										 * A refusal that arrives with nothing to say still refused.
										 *
										 * `message` is `NonEmptyString`, so an empty one makes this constructor
										 * throw — and a `Schema.TaggedError` that throws yields an object with no
										 * `_tag` and no properties, whose message is the literal "Schema validation
										 * failed". Every `instanceof` below then misses it and a refusal becomes a
										 * generic 500 carrying none of the reason. `refuse()` already guards its own
										 * sentence for exactly this; an outcome decoded off the wire deserves the
										 * same, because nothing here can vouch for what the other side sent.
										 */
										message:
											typeof outcome.message === 'string' && outcome.message.trim() !== ''
												? outcome.message
												: 'This operation was refused by a workspace rule.',
										...(outcome.collection === undefined ? {} : { collection: outcome.collection }),
										...(outcome.action === undefined ? {} : { action: outcome.action })
									})
								)
							: Effect.fail(
									new AccessControl.AccessDenied({
										action: outcome.action ?? 'mutate',
										resource: outcome.collection ?? 'collection',
										reason: outcome.message
									})
								);
					case 'Quarantined':
						return Effect.fail(
							new MutationQuarantined({
								idempotencyKey: outcome.idempotencyKey,
								deviceSequence: outcome.deviceSequence,
								schemaFingerprint: outcome.schemaFingerprint,
								reason: outcome.reason
							})
						);
				}
			};
			const assertBrowserBaseVersion = Effect.fn('Collections.assertBrowserBaseVersion')(function* (
				effectId: EffectId,
				fence: BrowserMutationFence,
				collection: string,
				id: string,
				previous: Readonly<Record<string, unknown>> | undefined
			) {
				const declared = fence.baseVersions.find(
					(entry) => entry.row.collection === collection && entry.row.recordId === id
				)?.rowVersion;
				const expected = declared ?? null;
				if (expected === null) {
					const quarantined: BrowserMutationOutcome = {
						_tag: 'Quarantined',
						idempotencyKey: fence.idempotencyKey,
						deviceSequence: fence.deviceSequence,
						schemaFingerprint: fence.schemaFingerprint,
						reason: `The mutation graph did not carry the whole-row base version for ${collection} ${id}.`
					};
					const persisted = yield* rememberBrowserMutationOutcome(
						EffectId.make(`${effectId}:missing-base-version`),
						fence,
						quarantined
					);
					return yield* replayBrowserMutationOutcome(persisted ?? quarantined);
				}
				const storedVersion = previous?.['row_version'];
				const currentVersion = previous === undefined ? null : storedVersion;
				if (currentVersion === expected) return;
				if (
					currentVersion !== null &&
					(typeof currentVersion !== 'number' ||
						!Number.isInteger(currentVersion) ||
						currentVersion < 1)
				)
					return yield* invalidBrowserMutationLedger(
						`The authoritative ${collection} ${id} has no valid row_version.`
					);
				const conflict: BrowserMutationOutcome = {
					_tag: 'VersionConflict',
					collection,
					id,
					baseVersion: expected,
					currentVersion,
					schemaFingerprint: fence.currentSchemaFingerprint
				};
				const persisted = yield* rememberBrowserMutationOutcome(
					EffectId.make(`${effectId}:version-conflict`),
					fence,
					conflict
				);
				return yield* replayBrowserMutationOutcome(persisted ?? conflict);
			});

			/** Completes the pre-hook claim in the exact transaction that makes the row mutation visible. */
			const browserMutationClaimStatement = (
				fence: BrowserMutationFence
			): Readonly<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }> => {
				const parameters: Array<Schema.Json> = [
					...browserMutationScopeParameters(fence.scope, fence.idempotencyKey),
					fence.requestDigest,
					fence.outcome
				];
				const messageIndex = parameters.push(
					'The browser mutation key was already committed by another invocation.'
				);
				// repository-health:allow SQL1 -- fixed private table and function; every request value is bound.
				return transactionSql(
					`with completed as (update ${BROWSER_MUTATION_TABLE} set status = 'terminal', outcome = $8::jsonb, confirmed_xid = pg_current_xact_id()::text::bigint, confirmed_sequence = (select max(sequence) from bolt_sync_outbox where xid = pg_current_xact_id()::text::bigint and mutation_id = $6), lease_expires_at = null where tenant_id = $1 and environment = $2 and principal_id = $3 and authority_id = $4 and command = $5 and idempotency_key = $6 and request_digest = $7 and status = 'running' returning id) select bolt_assert(exists(select 1 from completed), $${messageIndex})`,
					parameters
				);
			};
			/** Makes every sync trigger in the surrounding transaction carry the original journal key. */
			const browserMutationStampStatement = (
				fence: BrowserMutationFence
			): Readonly<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }> =>
				transactionSql(`select set_config('bolt.mutation_id', $1, true)`, [fence.idempotencyKey]);
			const pendingApprovalIdentity = (
				requestId: string,
				collection: string,
				id: string,
				action: typeof CollectionAction.Type
			): Schema.Json => ({
				_tag: 'PendingApproval',
				requestId,
				collection,
				id,
				action
			});
			/** Locks the original terminal approval outcome before a resumed graph touches domain rows. */
			const browserMutationApprovalGuardStatement = (
				fence: BrowserMutationFence,
				requestId: string,
				collection: string,
				id: string,
				action: typeof CollectionAction.Type
			): Readonly<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }> => {
				const parameters: Array<Schema.Json> = [
					...browserMutationScopeParameters(fence.scope, fence.idempotencyKey),
					fence.requestDigest,
					JSON.stringify(pendingApprovalIdentity(requestId, collection, id, action))
				];
				const messageIndex = parameters.push(
					'The pending browser mutation approval was already settled by another invocation.'
				);
				// repository-health:allow SQL1 -- fixed private table and function; every identity value is bound.
				return transactionSql(
					`select bolt_assert((select count(*) = 1 from (select id from ${BROWSER_MUTATION_TABLE} where tenant_id = $1 and environment = $2 and principal_id = $3 and authority_id = $4 and command = $5 and idempotency_key = $6 and request_digest = $7 and status = 'terminal' and outcome @> $8::jsonb for update) as pending_browser_mutation), $${messageIndex})`,
					parameters
				);
			};
			/**
			 * Converts the durable PendingApproval answer to its original Committed answer after every row
			 * and trigger has run. The ledger coordinate and the mutation are therefore one database fact.
			 */
			const browserMutationApprovalSettlementStatement = (
				fence: BrowserMutationFence,
				requestId: string,
				collection: string,
				id: string,
				action: typeof CollectionAction.Type
			): Readonly<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }> => {
				const parameters: Array<Schema.Json> = [
					...browserMutationScopeParameters(fence.scope, fence.idempotencyKey),
					fence.requestDigest,
					fence.outcome,
					JSON.stringify(pendingApprovalIdentity(requestId, collection, id, action))
				];
				const messageIndex = parameters.push(
					'The pending browser mutation approval was already settled by another invocation.'
				);
				// repository-health:allow SQL1 -- fixed private tables and function; every identity value is bound.
				return transactionSql(
					`with completed as (update ${BROWSER_MUTATION_TABLE} set status = 'terminal', outcome = $8::jsonb, confirmed_xid = pg_current_xact_id()::text::bigint, confirmed_sequence = (select max(sequence) from bolt_sync_outbox where xid = pg_current_xact_id()::text::bigint and mutation_id = $6), lease_expires_at = null where tenant_id = $1 and environment = $2 and principal_id = $3 and authority_id = $4 and command = $5 and idempotency_key = $6 and request_digest = $7 and status = 'terminal' and outcome @> $9::jsonb returning id) select bolt_assert(exists(select 1 from completed), $${messageIndex})`,
					parameters
				);
			};
			/** Closes a rejected approval without attaching an authoritative mutation confirmation. */
			const browserMutationApprovalRejectionStatement = (
				fence: BrowserMutationFence,
				requestId: string,
				collection: string,
				id: string,
				action: typeof CollectionAction.Type,
				outcome: BrowserMutationOutcome
			): Readonly<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }> => {
				const parameters: Array<Schema.Json> = [
					...browserMutationScopeParameters(fence.scope, fence.idempotencyKey),
					fence.requestDigest,
					outcome,
					JSON.stringify(pendingApprovalIdentity(requestId, collection, id, action))
				];
				const messageIndex = parameters.push(
					'The pending browser mutation approval was already settled by another invocation.'
				);
				// repository-health:allow SQL1 -- fixed private table and function; every identity value is bound.
				return transactionSql(
					`with rejected as (update ${BROWSER_MUTATION_TABLE} set status = 'terminal', outcome = $8::jsonb, confirmed_xid = null, confirmed_sequence = null, lease_expires_at = null where tenant_id = $1 and environment = $2 and principal_id = $3 and authority_id = $4 and command = $5 and idempotency_key = $6 and request_digest = $7 and status = 'terminal' and outcome @> $9::jsonb returning id) select bolt_assert(exists(select 1 from rejected), $${messageIndex})`,
					parameters
				);
			};
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
			/**
			 * The workspace's relationships, as Drizzle's relational query builder needs them.
			 *
			 * Built once from the same declaration the schema plan emits foreign keys from, over the same
			 * table descriptors the ordinary composed selects use, and resolved through the same
			 * `resolveWritableManyRelation` the graph writer resolves a parent's children by.
			 */
			const workspaceRelations = relationalSchema(workspace.definition, {
				table: (name, fields) => queryTableFor(name, fields),
				resolveMany: resolveWritableManyRelation
			});
			const relational = relationalComposer(workspaceRelations);
			/**
			 * The relational query builder for one collection, once the workspace has declared it.
			 *
			 * Opaque because the workspace is: Drizzle types `db.query` from a relations map known at
			 * compile time, and this one is derived from the artifact at layer construction.
			 */
			const relationalBuilders = relational.query as unknown as Readonly<
				Record<string, RelationalBuilder | undefined>
			>;
			// Announced from here rather than from the command boundary, because this is the only place
			// every write actually passes through: a command, an agent tool, an import, an automation and a
			// browser mutation all land on these three functions. Announcing at `dispatch` would
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
			 * Turns a browser write outside its row predicate into a typed, durable refusal before hooks run.
			 *
			 * The identical predicate remains on the transactional mutation guard below: this read explains
			 * the authority that exists now, while the guard closes the race if authority changes before
			 * commit. A database assertion alone reaches dispatch as an infrastructure failure and cannot be
			 * recorded as the browser journal's terminal `forbidden` settlement.
			 */
			const authorizeBrowserMutationRow = Effect.fn('Collections.authorizeBrowserMutationRow')(
				function* (
					effectId: EffectId,
					collection: string,
					id: string,
					action: 'update' | 'delete',
					visibility: AccessControl.RowPredicate
				) {
					const definition = yield* workspace.collection(collection);
					const table = queryTableFor(collection, definition.fields);
					const columns = columnsOf(table);
					const result = yield* executeBuilt(
						effectId,
						database,
						composer
							.select({ id: columns['id']! })
							.from(table)
							.where(
								and(
									eq(columns['id']!, id),
									AccessControl.predicateExpression(visibility)
								)
							)
							.limit(1)
					);
					if (result.rows.length > 0) return;
					return yield* new AccessControl.AccessDenied({
						action,
						resource: collection,
						reason: `${collection} ${id} is outside the matching policy grant`
					});
				}
			);
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
			 * After hooks use the same singular `db.<collection>.mutate` surface as every other context.
			 * Their bound operation is elevated because the record already passed authorization; authority
			 * changes, while vocabulary does not.
			 */
			type HookWriteOps = Pick<AuthoringOps, 'mutate'>;
			const buildReadOps = (effectId: EffectId, subject: Identity.Subject): AuthoringReadOps => ({
				findMany: (collection, input) => findMany(effectId, subject, { collection, ...input }),
				findFirst: (collection, input) =>
					findMany(effectId, subject, { collection, ...input, limit: 1 }).pipe(
						Effect.map((rows) => rows[0])
					),
				count: (collection, input) => count(effectId, subject, { collection, ...input }),
				findNearest: (collection, input) =>
					findNearest(effectId, subject, {
						collection,
						...input,
						column: typeof input['column'] === 'string' ? input['column'] : '',
						probe: Array.isArray(input['probe']) ? (input['probe'] as ReadonlyArray<number>) : [],
						metric:
							input['metric'] === 'cosine' || input['metric'] === 'ip' ? input['metric'] : 'l2'
					})
			});
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
			): AuthoringOps => {
				return {
					...buildReadOps(effectId, subject),
					runAutomation: runAutomationOp(effectId, automations),
					mutate:
						staged?.mutate ??
						((collection, values) =>
							mutate(effectId, subject, collection, [values], elevated, depth, {
								declarative: true
							}).pipe(Effect.asVoid)),
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
				makeAuthoringApi(buildOps(effectId, subject, elevated, depth, staged));
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
			 * **One decode, because there is one input.** There used to be two — `create.input` and
			 * `update.input` — describing the same operation and free to drift; `input` is now a binding
			 * of the collection's own, which is also what lets it type `api.db.x.mutate` and
			 * `client.db.x.mutate` from the same declaration the runtime enforces.
			 *
			 * The action is not a second contract, only which half of one applies: a create must carry
			 * the record the shape names, an update carries a patch of it. Everything a caller sent that
			 * the shape does not name is stripped either way, which is the security property this decode
			 * exists for.
			 *
			 * Lifted out of the before hook because `prepare` sees the batch's inputs and must see them in
			 * the same shape the hook will: a collection that declares two fields where the table has
			 * twenty would otherwise hand its batch read the raw payload and its handler the decoded one.
			 */
			const decodeMutateInput = Effect.fn('Collections.decodeMutateInput')(function* (
				collection: string,
				values: Readonly<Record<string, Schema.Json>>,
				module: AuthoredCollectionHookModule | undefined,
				action: 'create' | 'update'
			) {
				const declared = module?.input;
				if (declared === undefined) return values;
				const shape = action === 'create' ? declared : partialInput(collection, declared);
				const decoded = yield* Schema.decodeUnknownEffect(shape)(values).pipe(
					Effect.mapError(
						() =>
							new AccessControl.AccessDenied({
								action,
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
			const runMutatePrepare = Effect.fn('Collections.runMutatePrepare')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				inputs: ReadonlyArray<Readonly<Record<string, Schema.Json>>>,
				module: AuthoredCollectionHookModule | undefined,
				depth: number,
				staged?: HookWriteOps
			) {
				const prepare = module?.mutate?.prepare;
				if (prepare === undefined) return undefined;
				const api = buildApi(effectId, subject, false, depth + 1, staged);
				return yield* runAuthoredHandler(() => prepare({ inputs, api }, api)).pipe(
					Effect.mapError((cause) => refusalAt(cause, { collection, action: 'mutate.prepare' }))
				);
			});
			/**
			 * The one per-record rule, for the one write.
			 *
			 * `existing` is what tells a create from an update, and it is the same fact the runtime
			 * decided the operation from a moment earlier — the stored row this write lands on, or
			 * `undefined` because there is not one yet. Two hooks used to answer that question by which
			 * of them was called, which is how their two return types drifted apart while the runtime
			 * split a graph out of both.
			 */
			const runMutateBefore = Effect.fn('Collections.runMutateBefore')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				input: MutationInput,
				existing: Readonly<Record<string, unknown>> | undefined,
				module: AuthoredCollectionHookModule | undefined,
				depth = 0,
				prepared: unknown = undefined,
				staged?: HookWriteOps
			) {
				const api = buildApi(effectId, subject, false, depth + 1, staged);
				// Already decoded by the caller. `prepare` sees the batch's inputs and the handler sees one
				// of them, and they must be the same shape — a collection declaring two fields where the
				// table has twenty would otherwise hand its batch read the raw payload and its handler the
				// decoded one.
				const values = input.values;
				const before = yield* runHook(
					module?.mutate?.perRecord?.before,
					{ input: values, existing, prepared, api },
					api,
					{
						collection: input.collection,
						action: 'mutate.before'
					}
				);
				return before != null && typeof before === 'object' && !Array.isArray(before)
					? (before as Readonly<Record<string, Schema.Json>>)
					: values;
			});
			/** The subject-bound facts a `with` clause is planned against. */
			const planContextFor = (subject: Identity.Subject): PlanContext => ({
				definition: workspace.definition,
				relations: workspaceRelations,
				authorize: (collection: string) => access.authorize(subject, 'read', collection),
				predicate: (collection: string) => access.predicate(subject, 'read', collection)
			});
			/** A field mask, bound to this subject and applied against each level's own collection. */
			const maskFor =
				(subject: Identity.Subject): MaskRow =>
				(collection, row) =>
					access.mask(subject, 'read', collection, row);
			/**
			 * One relational read: the rows, and every relation the caller asked for, in one statement.
			 *
			 * Every level's row-visibility predicate is pushed into that level's own lateral subquery, so
			 * a related record is filtered by exactly the predicate a direct read of its collection would
			 * carry. `with` cannot become a way to read rows the subject could not otherwise see, and it
			 * no longer costs a query per relation per level to say so.
			 */
			const readRelational = Effect.fn('Collections.readRelational')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				config: Readonly<{
					readonly where: SQL;
					readonly ordering: ReadonlyArray<OrderTerm>;
					readonly limit: number;
					readonly with: unknown;
				}>
			) {
				const builder = relationalBuilders[collection];
				if (builder === undefined) {
					return yield* new WhereCompileError({
						collection,
						field: 'collection',
						message: `'${collection}' has no relational descriptor in this workspace.`
					});
				}
				const planned = yield* planRelations(planContextFor(subject), collection, config.with);
				// The same load-bearing cast `relation-query.ts` explains at length: Drizzle's declared
				// `RelationsFilter` does not model the `RAW` key that `relationsFilterToSQL` reads before
				// every other, so a bound predicate cannot be handed to a typed filter. The root read
				// carries the subject's row predicate through exactly that key.
				const query = builder.findMany({
					where: { RAW: config.where },
					orderBy: (table: unknown) => [...orderingExpressions(table, config.ordering)],
					limit: config.limit,
					...(planned.with === undefined ? {} : { with: planned.with })
				} as unknown as AnyDBQueryConfig);
				const result = yield* executeBuilt(effectId, database, query);
				// `source` is the same page as `rows`, in the same order, before reference decoding and
				// masking. Only grouping wants it: a lane is a fact about the stored column, and a field
				// mask must not be able to merge two lanes by hiding the column they differ on.
				const source = result.rows as ReadonlyArray<Readonly<Record<string, unknown>>>;
				return { rows: readRelationalRows(source, planned.level, maskFor(subject)), source };
			});
			const findMany: Interface['findMany'] = Effect.fn('Collections.findMany')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				input: QueryInput
			) {
				const definition = yield* workspace.collection(input.collection);
				yield* access.authorize(subject, 'read', input.collection);
				const context = makeWhereContext(
					input.collection,
					definition.fields,
					workspace.definition,
					ROOT_ALIAS
				);
				const compiled = yield* compiledFilter(input, context);
				const searched = compileSearch(definition.fields, input.search, ROOT_ALIAS);
				const visibility = access.predicate(subject, 'read', input.collection);
				const ordering = compileOrderTerms(input.orderBy, context);
				const seek = yield* compileCollectionCursorSeek(input.after, ordering, input.collection);
				const read = yield* readRelational(effectId, subject, input.collection, {
					where:
						and(
							compiled,
							queryFragment(searched),
							AccessControl.predicateExpression(visibility),
							queryFragment(seek)
						) ?? always(),
					ordering,
					limit: Math.max(1, input.limit ?? 100),
					with: input.with
				});
				return read.rows;
			});
			/**
			 * The rows nearest a probe vector, closest first.
			 *
			 * Ordering by the pgvector distance expression is the whole point: an HNSW index can answer
			 * `ORDER BY column <-> probe`, and the same measurement taken after the rows are read cannot
			 * — it would have to read the collection to sort it.
			 *
			 * Narrowing is the ordinary `where` compiler. The version this replaces carried its own
			 * `excludeIds`, which was a second filtering vocabulary that only this one call understood:
			 * it could exclude by id and by nothing else, while `where` already excludes by anything the
			 * collection has. Excluding the probe's own row is `{ id: { ne: record.id } }`.
			 *
			 * `distance` is attached beside the record rather than merged into it, because it describes
			 * the comparison and not the row — and a collection is free to have a column of that name.
			 */
			const findNearest: Interface['findNearest'] = Effect.fn('Collections.findNearest')(
				function* (effectId: EffectId, subject: Identity.Subject, input: NearestQueryInput) {
					const definition = yield* workspace.collection(input.collection);
					yield* access.authorize(subject, 'read', input.collection);
					const refuse = (field: string, message: string) =>
						new WhereCompileError({ collection: input.collection, field, message });
					const column = input.column;
					if (!Object.hasOwn(definition.fields, column)) {
						return yield* refuse(
							'column',
							`'${column}' is not a column of ${input.collection}; findNearest needs the vector column to measure against.`
						);
					}
					const operator = NEAREST_OPERATORS[input.metric];
					if (operator === undefined) {
						return yield* refuse(
							'metric',
							`No distance metric '${String(input.metric)}'. Accepted metrics: ${Object.keys(NEAREST_OPERATORS).join(', ')}.`
						);
					}
					if (
						input.probe.length === 0 ||
						!input.probe.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
					) {
						return yield* refuse(
							'probe',
							"probe must be a non-empty array of finite numbers with the column's dimension."
						);
					}
					if (input.maxDistance !== undefined && !Number.isFinite(input.maxDistance)) {
						return yield* refuse('maxDistance', 'maxDistance must be a finite number.');
					}
					const context = makeWhereContext(
						input.collection,
						definition.fields,
						workspace.definition
					);
					const compiled = yield* compiledFilter(input, context);
					const visibility = access.predicate(subject, 'read', input.collection);
					const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
					const table = queryTableFor(input.collection, definition.fields);
					const columns = columnsOf(table);
					const vectorColumn = columns[column]!;
					const distance = vectorDistance(vectorColumn, operator, input.probe);
					const result = yield* executeBuilt(
						effectId,
						database,
						composer
							.select({ ...columns, distance: aliased(distance, 'distance') })
							.from(table)
							.where(
								and(
									isNotNull(vectorColumn),
									compiled,
									AccessControl.predicateExpression(visibility),
									input.maxDistance === undefined
										? undefined
										: lessThanOrEqual(distance, input.maxDistance)
								)
							)
							.orderBy(distance)
							.limit(limit)
					);
					return result.rows.map((value) => {
						const { distance: measured, ...record } = queryRowOf(value);
						return {
							...access.mask(
								subject,
								'read',
								input.collection,
								decodeReferenceRow(record, definition.fields)
							),
							distance: typeof measured === 'number' ? measured : Number(measured ?? Number.NaN)
						};
					});
				}
			);
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
			/**
			 * The request a write belongs to, taken from the record it is changing.
			 *
			 * A locked record carries `approval_id`, and a write that reaches a locked record is by
			 * definition a write under that request - the revision path is the only way past the gate.
			 * Stamping the history row with it makes the request's record set derivable instead of
			 * tracked, so a record a revision creates, or one a cascade removes, is in the ledger
			 * because it wrote history, not because something remembered to add it.
			 */
			const governingRequest = (
				previous: Readonly<Record<string, unknown>> | undefined
			): string | null => {
				const held = previous?.['approval_id'];
				return typeof held === 'string' && held !== '' ? held : null;
			};

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
										approval_id: governingRequest(previous),
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
										subject_id: subject.userId,
										approval_id: governingRequest(previous),
										// The row as it was, so a rejected delete has something to restore. Serialised
										// the same way the approval path serialises its snapshot.
										snapshot: JSON.stringify(previous ?? {})
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
				previous: Readonly<Record<string, unknown>> | undefined = undefined,
				browserMutation?: BrowserMutationFence,
				approvalRequestId?: string
			) {
				const visibility = elevated
					? AccessControl.unrestricted
					: access.predicate(subject, 'delete', collection);
				const statements = [
					...(browserMutation === undefined
						? []
						: [
								...(approvalRequestId === undefined
									? []
									: [
											browserMutationApprovalGuardStatement(
												browserMutation,
												approvalRequestId,
												collection,
												id,
												'delete'
											)
										]),
								browserMutationStampStatement(browserMutation)
							]),
					...deleteStatements(effectId, subject, collection, id, definition, visibility, previous),
					...(browserMutation === undefined
						? []
						: [
								approvalRequestId === undefined
									? browserMutationClaimStatement(browserMutation)
									: browserMutationApprovalSettlementStatement(
											browserMutation,
											approvalRequestId,
											collection,
											id,
											'delete'
										)
							])
				];
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
			const approvalReleaseStatement = (
				collection: string,
				id: string,
				requestId: string
			): Readonly<{ readonly sql: string; readonly parameters: ReadonlyArray<Schema.Json> }> =>
				transactionSql(
					`update ${quoteIdentifier(collection)} set approval_id = null where approval_id = $1 and id = $2`,
					[requestId, id]
				);
			const holdForApproval = Effect.fn('Collections.holdForApproval')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				input: MutationInput,
				action: typeof CollectionAction.Type,
				approval?: Schema.Json,
				mode?: 'declarative',
				review?: DeclarativeReview,
				browserMutation?: BrowserMutationFence
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
						...(durableReview === undefined ? {} : { review: durableReview }),
						...(browserMutation === undefined ? {} : { browserMutation })
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
				const api = makePolicyDecisionApi(buildReadOps(effectId, subject), subject);
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
				const api = makePolicyDecisionApi(buildReadOps(effectId, subject), subject);
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
				const decoded = yield* decodeMutateInput(input.collection, input.values, module, 'create');
				const prepared = yield* runMutatePrepare(
					effectId,
					subject,
					input.collection,
					[decoded],
					module,
					depth
				);
				const values = yield* runMutateBefore(
					effectId,
					subject,
					{ ...input, values: decoded },
					// A create has no stored row, and that absence is the whole discriminator: the hook is
					// told what the runtime already decided from the missing id, rather than a second flag.
					undefined,
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
				if (module?.mutate?.perRecord?.after !== undefined) {
					const api = buildApi(effectId, subject, true, depth + 1);
					const record = yield* readRowElevated(effectId, input.collection, input.id);
					yield* runHook(
						module.mutate.perRecord.after,
						{ previous: undefined, changes: preparedValues, record, api },
						api,
						{
							collection: input.collection,
							action: 'mutate.after'
						}
					);
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

			type RelatedRowsRequest = Readonly<{
				edge: WritableManyRelation;
				parentId: string;
			}>;
			type RelatedRowsResult = Readonly<{
				rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
				raw: ReadonlyArray<Readonly<Record<string, unknown>>>;
				json: string;
			}>;
			type StoredGraphRow = Readonly<{
				row: Readonly<Record<string, unknown>>;
				snapshot: string;
			}>;
			const relatedRowsKey = (edge: WritableManyRelation, parentId: string): string =>
				`${edge.childCollection}\u0000${edge.childColumn}\u0000${parentId}`;
			const storedGraphRowKey = (collection: string, id: string): string =>
				`${collection}\u0000${id}`;

			/** Exact existing nodes named by a submitted graph, batched across heterogeneous tables. */
			const storedGraphRowsMany = Effect.fn('Collections.storedGraphRowsMany')(function* (
				effectId: EffectId,
				requests: ReadonlyArray<Readonly<{ collection: string; id: string }>>
			) {
				const unique = new Map<string, Readonly<{ collection: string; id: string }>>();
				for (const request of requests) {
					const key = storedGraphRowKey(request.collection, request.id);
					if (!unique.has(key)) unique.set(key, request);
				}
				const ordered = [...unique.entries()].toSorted(([left], [right]) =>
					left.localeCompare(right)
				);
				const loaded = new Map<string, StoredGraphRow | undefined>();
				if (ordered.length === 0) return loaded;
				const parameters: Array<Schema.Json> = [];
				const branches = ordered.map(([, request], ordinal) => {
					const ordinalParameter = parameters.push(ordinal);
					const idParameter = parameters.push(request.id);
					return `select $${ordinalParameter}::integer as "__bolt_graph_row_ordinal", to_jsonb(record) as "__bolt_graph_row_record" from ${quoteIdentifier(request.collection)} as record where record.id = $${idParameter}`;
				});
				const result = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: branches.join(' union all '),
					parameters
				});
				const rawByOrdinal = new Map<number, Readonly<Record<string, unknown>>>();
				for (const row of result.rows) {
					if (!isJsonObject(row)) continue;
					const ordinal = row['__bolt_graph_row_ordinal'];
					const record = row['__bolt_graph_row_record'];
					if (typeof ordinal === 'number' && isJsonObject(record)) rawByOrdinal.set(ordinal, record);
				}
				for (const [[key, request], ordinal] of ordered.map((entry, index) => [entry, index] as const)) {
					const raw = rawByOrdinal.get(ordinal);
					if (raw === undefined) {
						loaded.set(key, undefined);
						continue;
					}
					const definition = yield* workspace.collection(request.collection);
					loaded.set(key, {
						row: decodeReferenceRow(raw, definition.fields) as Readonly<Record<string, unknown>>,
						snapshot: JSON.stringify(raw)
					});
				}
				return loaded;
			});

			/**
			 * Reads every requested ownership edge in one statement.
			 *
			 * A recursive graph used to issue this SELECT from inside `prepareNode`: one facility call for
			 * every existing parent and every included relationship. The rows are still exact, elevated
			 * pre-images — hooks, authorization, approval review and omission planning all keep consuming
			 * the same value — but heterogeneous child tables are projected to one JSON shape and unioned.
			 * The ordinal is an integer rather than the internal NUL-delimited cache key because PostgreSQL
			 * text values cannot carry a NUL byte.
			 */
			const relatedRowsMany = Effect.fn('Collections.relatedRowsMany')(function* (
				effectId: EffectId,
				requests: ReadonlyArray<RelatedRowsRequest>
			) {
				const unique = new Map<string, RelatedRowsRequest>();
				for (const request of requests) {
					const key = relatedRowsKey(request.edge, request.parentId);
					if (!unique.has(key)) unique.set(key, request);
				}
				const ordered = [...unique.entries()].toSorted(([left], [right]) =>
					left.localeCompare(right)
				);
				const empty = new Map<string, RelatedRowsResult>();
				if (ordered.length === 0) return empty;
				const parameters: Array<Schema.Json> = [];
				const branches = ordered.map(([, request], ordinal) => {
					const ordinalParameter = parameters.push(ordinal);
					const parentParameter = parameters.push(request.parentId);
					return `select $${ordinalParameter}::integer as "__bolt_relation_ordinal", to_jsonb(child) as "__bolt_relation_record" from ${quoteIdentifier(request.edge.childCollection)} as child where child.${quoteIdentifier(request.edge.childColumn)} = $${parentParameter}`;
				});
				const result = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: `select * from (${branches.join(' union all ')}) as planned order by "__bolt_relation_ordinal", "__bolt_relation_record"->>'id'`,
					parameters
				});
				const rawByOrdinal = new Map<number, Array<Readonly<Record<string, unknown>>>>();
				for (const row of result.rows) {
					if (!isJsonObject(row)) continue;
					const ordinal = row['__bolt_relation_ordinal'];
					const record = row['__bolt_relation_record'];
					if (typeof ordinal !== 'number' || !isJsonObject(record)) continue;
					const bucket = rawByOrdinal.get(ordinal) ?? [];
					bucket.push(record);
					rawByOrdinal.set(ordinal, bucket);
				}
				const loaded = new Map<string, RelatedRowsResult>();
				for (const [[key, request], ordinal] of ordered.map((entry, index) => [entry, index] as const)) {
					const definition = yield* workspace.collection(request.edge.childCollection);
					const raw = rawByOrdinal.get(ordinal) ?? [];
					loaded.set(key, {
						rows: raw.map(
							(row) =>
								decodeReferenceRow(row, definition.fields) as Readonly<Record<string, unknown>>
						),
						raw,
						json: JSON.stringify(raw)
					});
				}
				return loaded;
			});

			/**
			 * Builds the complete mixed create/update/delete plan before the transaction. Every hook and
			 * authorization check therefore fails in `prepare`, while every statement it admits commits in
			 * one envelope. Relationship omission is read by key presence: no key means no query and no
			 * operation; an explicit empty array plans deletion of every stored child.
			 */
			type DeclarativePreparationOptions = Readonly<{
				readonly approved: boolean;
				readonly elevated: boolean;
				readonly runHooks: boolean;
				readonly rootId: string;
				readonly rootAction: 'create' | 'update';
				readonly clearRootLock: boolean;
				readonly approvalRequestId?: string;
				readonly expectedPolicyFingerprint?: string;
				readonly browserMutation?: BrowserMutationFence;
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
				const relatedRowsCache = new Map<string, RelatedRowsResult>();
				const storedGraphRowsCache = new Map<string, StoredGraphRow | undefined>();
				const cacheRelatedRows = (
					request: RelatedRowsRequest,
					value: RelatedRowsResult
				): void => {
					relatedRowsCache.set(relatedRowsKey(request.edge, request.parentId), value);
					for (const [index, row] of value.rows.entries()) {
						const id = row['id'];
						const raw = value.raw[index];
						if (typeof id !== 'string' || raw === undefined) continue;
						storedGraphRowsCache.set(
							storedGraphRowKey(request.edge.childCollection, id),
							{ row, snapshot: JSON.stringify(raw) }
						);
					}
				};
				const relatedRows = Effect.fn('Collections.relatedRows')(function* (
					requestEffectId: EffectId,
					edge: WritableManyRelation,
					parentId: string
				) {
					const key = relatedRowsKey(edge, parentId);
					const cached = relatedRowsCache.get(key);
					if (cached !== undefined) return cached;
					const loaded = yield* relatedRowsMany(requestEffectId, [{ edge, parentId }]);
					const value = loaded.get(key) ?? { rows: [], raw: [], json: '[]' };
					cacheRelatedRows({ edge, parentId }, value);
					return value;
				});
				const cascadeEdgesFrom = (collection: string): ReadonlyArray<WritableManyRelation> =>
					workspace.definition.relations.flatMap((relation) => {
						if (relation.source !== collection || relation.cardinality !== 'many') return [];
						const edge = resolveWritableManyRelation(
							workspace.definition,
							collection,
							relation.name
						);
						return edge?.cascade === true && edge.parentColumn === 'id' ? [edge] : [];
					});
				type PrimedRelationshipRequest = RelatedRowsRequest &
					Readonly<{ desiredIds: ReadonlySet<string> }>;
				const primeRelatedRows = Effect.fn('Collections.primeRelatedRows')(function* () {
					const initial = new Map<string, PrimedRelationshipRequest>();
					const rows = new Map<string, Readonly<{ collection: string; id: string }>>();
					const collect = (
						collection: string,
						payload: Readonly<Record<string, unknown>>,
						id: string,
						action: 'create' | 'update'
					): void => {
						if (action === 'update') {
							const key = storedGraphRowKey(collection, id);
							if (!rows.has(key)) rows.set(key, { collection, id });
						}
						for (const [name, value] of Object.entries(payload)) {
							const edge = resolveWritableManyRelation(workspace.definition, collection, name);
							if (edge === undefined || !Array.isArray(value)) continue;
							const desiredIds = new Set(
								value.flatMap((child) => {
									if (child === null || typeof child !== 'object' || Array.isArray(child)) return [];
									const childId = Reflect.get(child, 'id');
									return typeof childId === 'string' && childId.length > 0 ? [childId] : [];
								})
							);
							if (action === 'update') {
								const key = relatedRowsKey(edge, id);
								if (!initial.has(key)) initial.set(key, { edge, parentId: id, desiredIds });
							}
							for (const child of value) {
								if (child === null || typeof child !== 'object' || Array.isArray(child)) continue;
								const childPayload = child as Readonly<Record<string, unknown>>;
								const childId = childPayload['id'];
								if (typeof childId !== 'string' || childId.length === 0) continue;
								const browserExisting = options.browserMutation?.baseVersions.some(
									(entry) =>
										entry.row.collection === edge.childCollection &&
										entry.row.recordId === childId
								);
								collect(
									edge.childCollection,
									childPayload,
									childId,
									options.browserMutation === undefined || browserExisting === true
										? 'update'
										: 'create'
								);
							}
						}
					};
					collect(rootCollection, rootPayload, options.rootId, options.rootAction);
					const stored = yield* storedGraphRowsMany(
						EffectId.make(`${effectId}:graph:row-wave`),
						[...rows.values()]
					);
					for (const [key, value] of stored) storedGraphRowsCache.set(key, value);
					let wave = [...initial.values()];
					const visited = new Set<string>();
					let waveNumber = 0;
					while (wave.length > 0) {
						const pending = wave.filter(
							(request) => !visited.has(relatedRowsKey(request.edge, request.parentId))
						);
						if (pending.length === 0) break;
						for (const request of pending)
							visited.add(relatedRowsKey(request.edge, request.parentId));
						const loaded = yield* relatedRowsMany(
							EffectId.make(`${effectId}:graph:relationship-wave:${waveNumber++}`),
							pending
						);
						for (const request of pending) {
							const value = loaded.get(relatedRowsKey(request.edge, request.parentId));
							if (value !== undefined) cacheRelatedRows(request, value);
						}
						const next = new Map<string, PrimedRelationshipRequest>();
						for (const request of pending) {
							if (!request.edge.cascade) continue;
							const rows = loaded.get(relatedRowsKey(request.edge, request.parentId))?.rows ?? [];
							for (const row of rows) {
								const childId = row['id'];
								if (typeof childId !== 'string' || request.desiredIds.has(childId)) continue;
								for (const edge of cascadeEdgesFrom(request.edge.childCollection)) {
									const key = relatedRowsKey(edge, childId);
									if (!visited.has(key) && !next.has(key))
										next.set(key, { edge, parentId: childId, desiredIds: new Set() });
								}
							}
						}
						wave = [...next.values()];
					}
				});
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
				const storedGraphRow = Effect.fn('Collections.storedGraphRow')(function* (
					rowEffectId: EffectId,
					collection: string,
					id: string
				) {
					const key = storedGraphRowKey(collection, id);
					if (storedGraphRowsCache.has(key)) return storedGraphRowsCache.get(key);
					const loaded = yield* storedGraphRowsMany(rowEffectId, [{ collection, id }]);
					const value = loaded.get(key);
					storedGraphRowsCache.set(key, value);
					return value;
				});
				const recordSnapshot = Effect.fn('Collections.recordSnapshot')(function* (
					collection: string,
					id: string
				) {
					const stored = yield* storedGraphRow(
						EffectId.make(`${effectId}:graph:snapshot:${collection}:${id}`),
						collection,
						id
					);
					if (stored === undefined)
						return yield* graphRefusal(
							collection,
							'update',
							`${collection} ${id} no longer exists.`
						);
					return stored.snapshot;
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
					depth: number,
					/** False for server-derived cascades and authored-hook writes. */
					requiresBrowserBaseVersion: boolean
				) => Effect.Effect<
					void,
					| Workspace.WorkspaceLookupError
					| AccessControl.AccessDenied
					| Database.FacilityError
					| ApprovalConflict
					| PendingApproval
					| MutationIdempotencyConflict
					| MutationVersionConflict
					| MutationQuarantined
					| BrowserMutationReplay
					| AuthoredRefusal
					| InvocationBudget.NestingLimitExceeded
				> = Effect.fn('Collections.prepareGraphDelete')(function* (
					collection,
					row,
					depth,
					requiresBrowserBaseVersion
				) {
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
					if (options.browserMutation !== undefined && requiresBrowserBaseVersion)
						yield* assertBrowserBaseVersion(
							EffectId.make(`${effectId}:base-version:${collection}:${id}`),
							options.browserMutation,
							collection,
							id,
							row
						);
					yield* ensureGraphRowUnlocked(collection, id);
					if (!options.elevated) yield* access.authorize(subject, 'delete', collection);
					const visibility = options.elevated
						? AccessControl.unrestricted
						: access.predicate(subject, 'delete', collection);
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
							yield* prepareDelete(edge.childCollection, child, depth + 1, false);
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
					}>,
					/** False when trusted authored code, rather than the browser graph, introduced this node. */
					requiresBrowserBaseVersion?: boolean
				) => Effect.Effect<
					string,
					| Workspace.WorkspaceLookupError
					| AccessControl.AccessDenied
					| Database.FacilityError
					| ApprovalConflict
					| PendingApproval
					| MutationIdempotencyConflict
					| MutationVersionConflict
					| MutationQuarantined
					| BrowserMutationReplay
					| AuthoredRefusal
					| GraphApprovalRequired
					| InvocationBudget.NestingLimitExceeded
				> = Effect.fn('Collections.prepareGraphNode')(
					// repository-health:allow COMPLEX1 -- This recursive graph planner is the single policy/hook/relationship owner; guard clauses bound every branch and splitting it would duplicate the shared atomic plan state.
					function* (
						collection,
						payload,
						depth,
						ownership,
						identity,
						requiresBrowserBaseVersion = true
					) {
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
						// A before hook may add a relationship graph the browser never observed. Those rows are
						// trusted server-derived work and cannot honestly be required to carry client base versions.
						const browserRelationshipNames = new Set(
							requiresBrowserBaseVersion
								? submitted.included.map((entry) => entry.edge.name)
								: []
						);
						let own: Readonly<Record<string, Schema.Json>> = submitted.own;
						let included = submitted.included;
						let previous: Readonly<Record<string, unknown>> | undefined;
						let snapshot: string | undefined;
						if (!options.elevated) yield* access.authorize(subject, action, collection);
						if (action === 'create' && typeof submittedId === 'string') {
							const collision = yield* readRowElevated(
								EffectId.make(`${effectId}:create-identity:${collection}:${id}`),
								collection,
								id
							);
							if (collision !== undefined)
								return yield* graphRefusal(
									collection,
									'create',
									`The requested ${collection} identity is already in use.`
								);
						}
						const visibility = options.elevated
							? AccessControl.unrestricted
							: access.predicate(subject, action, collection);
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

						// Only an update has anything to read first: the row it lands on, the fence the browser
						// declared against it, and the snapshot the ledger keeps. Everything after this — the
						// decode, `prepare`, `before`, and the graph split of what `before` returned — is one
						// path, because it is one write.
						if (action === 'update') {
							previous = (
								yield* storedGraphRow(
									EffectId.make(`${effectId}:graph:row:${collection}:${id}`),
									collection,
									id
								)
							)?.row;
							if (
								options.browserMutation !== undefined &&
								!options.elevated &&
								previous !== undefined
							)
								yield* authorizeBrowserMutationRow(
									EffectId.make(`${effectId}:row-authorization:${collection}:${id}`),
									collection,
									id,
									'update',
									visibility
								);
							if (options.browserMutation !== undefined && requiresBrowserBaseVersion)
								yield* assertBrowserBaseVersion(
									EffectId.make(`${effectId}:base-version:${collection}:${id}`),
									options.browserMutation,
									collection,
									id,
									previous
								);
							snapshot = yield* recordSnapshot(collection, id);
						}
						own = yield* decodeMutateInput(collection, own, module, action);
						if (options.runHooks) {
							// The id rides the input on an update and only there. It is the one thing a
							// `prepare` can read to tell a recalculation from a first build, because it sees a
							// batch of inputs and no rows; `before` is told the same fact as `existing`.
							const hookInput = action === 'update' ? { ...own, id } : own;
							const prepared = yield* runMutatePrepare(
								effectId,
								subject,
								collection,
								[hookInput],
								module,
								hookDepth + depth,
								stageHookWrites
							);
							const hooked = yield* runMutateBefore(
								effectId,
								subject,
								{ collection, id, values: hookInput },
								previous,
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
							const relationshipRequiresBrowserBaseVersion =
								requiresBrowserBaseVersion && browserRelationshipNames.has(relation.edge.name);
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
								let childIdentity:
									| Readonly<{
											readonly id: string;
											readonly action: 'create' | 'update';
											readonly clearLock: boolean;
									  }>
									| undefined;
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
									if (byId.has(childId)) {
										childIdentity = { id: childId, action: 'update', clearLock: false };
									} else if (relationshipRequiresBrowserBaseVersion) {
										const declaredExisting = options.browserMutation?.baseVersions.some(
											(entry) =>
												entry.row.collection === relation.edge.childCollection &&
												entry.row.recordId === childId
										);
										if (declaredExisting === true)
											return yield* graphRefusal(
												relation.edge.childCollection,
												'update',
												`${childId} is not currently owned by ${collection} ${id}, so this relationship mutation cannot move or overwrite it.`
											);
										childIdentity = { id: childId, action: 'create', clearLock: false };
									} else {
										return yield* graphRefusal(
											relation.edge.childCollection,
											'update',
											`${childId} is not currently owned by ${collection} ${id}, so this relationship mutation cannot move or overwrite it.`
										);
									}
									desiredIds.add(childId);
								}
								yield* prepareNode(
									relation.edge.childCollection,
									child,
									depth + 1,
									{
										column: relation.edge.childColumn,
										parentId: id
									},
									childIdentity,
									relationshipRequiresBrowserBaseVersion
								);
							}
							// Inclusion authorizes reconciliation of the children it names, but absence is
							// destructive only for an owned edge. A non-cascade `many` is a convenient write
							// surface over independently-lived rows; treating its array as ownership would let a
							// partial editor delete siblings it does not own.
							for (const [childId, row] of byId) {
								if (relation.edge.cascade && !desiredIds.has(childId))
									yield* prepareDelete(
										relation.edge.childCollection,
										row,
										depth + 1,
										relationshipRequiresBrowserBaseVersion
									);
							}
						}
						return id;
					}
				);

				/**
				 * Before-hook writes are planned into this graph instead of reaching the database while the
				 * graph is still being validated. Their hooks and authorization still run canonically, but
				 * every resulting statement joins the parent/relationship transaction and therefore rolls
				 * back with it.
				 */
				let stagedWriteCalls = 0;
				const stageHookWrites: HookWriteOps = {
					mutate: (collection, values) =>
						Effect.gen(function* () {
							yield* refuseRunawayHooks('staged mutate', collection, ++stagedWriteCalls);
							const submittedId = values['id'];
							const id = typeof submittedId === 'string' ? submittedId : randomId();
							const action = typeof submittedId === 'string' ? 'update' : 'create';
							yield* prepareNode(
								collection,
								{ ...values, id },
								0,
								undefined,
								{
									id,
									action,
									clearLock: false
								},
								false
							);
						})
				};

				// Prime the complete submitted graph before recursive preparation starts. Relationship reads
				// introduced only by a hook retain the single-request fallback above; authored input and every
				// cascade descendant discovered from its omissions consume the wave cache.
				if (!options.elevated)
					yield* access.authorize(subject, options.rootAction, rootCollection);
				yield* primeRelatedRows();
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
				review?: DeclarativeReview,
				browserMutation?: BrowserMutationFence,
				approvalRequestId?: string,
				approvalRoot?: Readonly<{
					readonly collection: string;
					readonly id: string;
					readonly action: typeof CollectionAction.Type;
				}>
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
					...(browserMutation === undefined
						? []
						: [
								...(approvalRequestId === undefined || approvalRoot === undefined
									? []
									: [
											browserMutationApprovalGuardStatement(
												browserMutation,
												approvalRequestId,
												approvalRoot.collection,
												approvalRoot.id,
												approvalRoot.action
											)
										]),
								browserMutationStampStatement(browserMutation)
							]),
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
					...(browserMutation === undefined
						? []
						: [
								approvalRequestId === undefined || approvalRoot === undefined
									? browserMutationClaimStatement(browserMutation)
									: browserMutationApprovalSettlementStatement(
											browserMutation,
											approvalRequestId,
											approvalRoot.collection,
											approvalRoot.id,
											approvalRoot.action
										)
							]),
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
					// One hook for a created row and an updated one, told apart by `previous` — which the
					// operation already carries as `undefined` for a create, because there was no row to read.
					const hook = operation.module?.mutate?.perRecord?.after;
					if (hook === undefined) continue;
					const record = records.get(`${operation.collection}\u0000${operation.id}`);
					if (record === undefined) continue;
					yield* settleStep(
						'after-hook',
						operation.collection,
						runHook(
							hook,
							{ previous: operation.previous, changes: operation.values, record, api },
							api,
							{
								collection: operation.collection,
								action: 'mutate.after'
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
				readonly browserMutation?: BrowserMutationFence;
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
						elevated,
						runHooks,
						rootId,
						rootAction,
						clearRootLock: approval.clearRootLock === true,
						...(approval.approvalRequestId === undefined
							? {}
							: { approvalRequestId: approval.approvalRequestId }),
						...(expectedPolicyFingerprint === undefined ? {} : { expectedPolicyFingerprint }),
						...(approval.browserMutation === undefined
							? {}
							: { browserMutation: approval.browserMutation })
					});
				const phasePrepare = <A, E>(effect: Effect.Effect<A, E>) =>
					effect.pipe(
						Effect.catchCause((cause) => {
							const failure = Cause.squash(cause);
							return Effect.fail(
								failure instanceof GraphApprovalRequired || failure instanceof BrowserMutationReplay
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
							cause.review,
							approval.browserMutation
						).pipe(
							Effect.catchTag('Bolt.Collections.PendingApproval', (pending) => {
								if (approval.browserMutation === undefined) return Effect.fail(pending);
								const outcome: BrowserMutationOutcome = {
									_tag: 'PendingApproval',
									requestId: pending.requestId,
									collection: pending.collection,
									id: pending.id,
									action: pending.action,
									schemaFingerprint: approval.browserMutation.currentSchemaFingerprint
								};
								return rememberBrowserMutationOutcome(
									EffectId.make(`${effectId}:pending-approval`),
									approval.browserMutation,
									outcome
								).pipe(
									Effect.flatMap((persisted) => replayBrowserMutationOutcome(persisted ?? outcome))
								);
							})
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
					approval.review,
					approval.browserMutation,
					approval.approvalRequestId,
					approval.approvalRequestId === undefined
						? undefined
						: { collection, id: rootId, action: rootAction }
				).pipe(
					Effect.catchCause((cause) =>
						Effect.gen(function* () {
							const failure = Cause.squash(cause);
							if (
								approval.browserMutation !== undefined &&
								!approval.approved &&
								!Cause.hasInterruptsOnly(cause)
							) {
								const replay = yield* browserMutationOutcome(
									EffectId.make(`${effectId}:concurrent-replay`),
									approval.browserMutation.scope,
									approval.browserMutation.idempotencyKey,
									approval.browserMutation.requestDigest
								).pipe(
									Effect.catchTag(
										'Bolt.Collections.MutationIdempotencyConflict',
										(conflict) =>
											Effect.fail(
												mutationPhaseFailure('commit', collection, [], conflict)
											)
									)
								);
								if (replay !== undefined) return yield* replayBrowserMutationOutcome(replay);
							}
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
						identified.map((row) => decodeMutateInput(collection, row.values, module, 'create')),
						{ concurrency: 'unbounded' }
					);
					const prepared = yield* runMutatePrepare(
						effectId,
						subject,
						collection,
						decoded,
						module,
						depth
					);
					const built = yield* Effect.all(
						identified.map((row, index) =>
							runMutateBefore(
								rowId(index),
								subject,
								{ collection, id: row.id, values: decoded[index] ?? row.values },
								// Every row on this path is an insert — the batch was routed here by having no
								// id — so there is no stored row for any of them.
								undefined,
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
					if (module?.mutate?.perRecord?.after !== undefined) {
						const after = module.mutate.perRecord.after;
						// The columns this write committed, taken from the flattened root rather than
						// re-derived: FLATTEN is where a returned graph became rows, so it is the only place
						// that knows which of them are this record's own.
						const committedValues = new Map(
							nodes.map((node) => [`${node.collection}\u0000${node.id}`, node.values])
						);
						yield* Effect.all(
							settled.map(({ index, record }) =>
								Effect.suspend(() => {
									const api = buildApi(rowId(index), subject, true, depth + 1);
									const id = built[index]?.id;
									return runHook(
										after,
										{
											previous: undefined,
											changes:
												id === undefined
													? {}
													: (committedValues.get(`${collection}\u0000${id}`) ?? {}),
											record,
											api
										},
										api,
										{
											collection,
											action: 'mutate.after'
										}
									);
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
					readonly browserMutation?: BrowserMutationFence;
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
							: { rootId: explicitRoot.id, rootAction: explicitRoot.action }),
						...(options.browserMutation === undefined
							? {}
							: { browserMutation: options.browserMutation })
					}).pipe(
						Effect.catchIf(isBrowserMutationReplay, (cause) =>
							cause.outcome._tag === 'Committed'
								? Effect.succeed([{ id: explicitRoot?.id ?? cause.outcome.id }])
								: Effect.fail(mutationPhaseFailure('commit', collection, [], cause))
						)
					);
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
				const searched = compileSearch(definition.fields, input.search, input.collection);
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
			/**
			 * One complete authoritative grouping.
			 *
			 * The rows are read once, bounded by the durable result cap, and sorted into their lanes
			 * here rather than by a `jsonb_agg` over a windowed subquery. That aggregate existed because
			 * the relation prefetch needed a flat row list to hand back afterwards; a relational read
			 * already returns whole rows in the requested order, so grouping them is a loop and the
			 * relations arrive with them instead of costing a query per relation afterwards.
			 *
			 * The lane is read off the record as the database returned it, before masking: a field mask
			 * narrows what a caller may see of a row, and it must not silently merge two lanes into one.
			 */
			const findGrouped: Interface['findGrouped'] = Effect.fn('Collections.findGrouped')(
				function* (effectId, subject, input) {
					const definition = yield* workspace.collection(input.collection);
					yield* access.authorize(subject, 'read', input.collection);
					if (input.lanes.length > GROUPED_RESULT_LIMIT) {
						return yield* new WhereCompileError({
							collection: input.collection,
							field: input.groupBy,
							message: `Grouped query exceeds the ${GROUPED_RESULT_LIMIT}-lane request limit.`
						});
					}
					const context = makeWhereContext(
						input.collection,
						definition.fields,
						workspace.definition,
						ROOT_ALIAS
					);
					const compiled = yield* compiledFilter(input, context);
					const searched = compileSearch(definition.fields, input.search, ROOT_ALIAS);
					const visibility = access.predicate(subject, 'read', input.collection);
					const table = queryTableFor(input.collection, definition.fields);
					if (
						columnsOf(table)[input.groupBy] === undefined ||
						definition.fields[input.groupBy]?.reference !== undefined ||
						definition.fields[input.groupBy]?.type === 'json' ||
						input.groupBy === 'sys_period'
					) {
						return yield* new WhereCompileError({
							collection: input.collection,
							field: input.groupBy,
							message: 'Grouped queries require one persisted scalar column.'
						});
					}
					// One sentinel row past the durable cap, so an oversized grouping fails closed instead
					// of installing a prefix as though it were the complete answer.
					const read = yield* readRelational(effectId, subject, input.collection, {
						where:
							and(
								compiled,
								queryFragment(searched),
								AccessControl.predicateExpression(visibility)
							) ?? always(),
						ordering: compileOrderTerms(input.orderBy, context),
						limit: GROUPED_RESULT_LIMIT + 1,
						with: input.with
					});
					if (read.rows.length > GROUPED_RESULT_LIMIT) {
						return yield* new WhereCompileError({
							collection: input.collection,
							field: input.groupBy,
							message: `Grouped query exceeds the exact ${GROUPED_RESULT_LIMIT}-row result limit.`
						});
					}
					const grouped = new Map<string, Array<QueryRow>>(
						input.lanes.map((lane) => [String(lane), []])
					);
					for (const [index, row] of read.rows.entries()) {
						const lane = String(read.source[index]?.[input.groupBy] ?? '');
						const bucket = grouped.get(lane) ?? [];
						bucket.push(row);
						grouped.set(lane, bucket);
					}
					return Object.fromEntries(grouped);
				}
			);
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
				let values = yield* decodeMutateInput(input.collection, input.values, module, 'update');
				// Read once and used twice where both want it. An outbound binding needs it because a
				// trigger is asked `previous.status !== record.status` and a patch alone cannot answer that;
				// the hook needs it because it is the fact that tells it this write is an update. The read
				// is skipped entirely when neither does, so a collection with no `mutate` hook and no
				// outbound binding costs nothing for it.
				const wantsPrevious =
					module?.mutate?.perRecord?.before !== undefined ||
					module?.mutate?.perRecord?.after !== undefined ||
					needsPreviousRow(input.collection, 'update') ||
					visibility.authorization !== undefined ||
					visibility.approval !== undefined;
				const existing = wantsPrevious
					? yield* readRowElevated(effectId, input.collection, input.id)
					: undefined;
				if (
					module?.mutate?.prepare !== undefined ||
					module?.mutate?.perRecord?.before !== undefined
				) {
					const hookInput = { ...values, id: input.id };
					const prepared = yield* runMutatePrepare(
						effectId,
						subject,
						input.collection,
						[hookInput],
						module,
						depth
					);
					const before = yield* runMutateBefore(
						effectId,
						subject,
						{ ...input, values: hookInput },
						existing,
						module,
						depth,
						prepared
					);
					/**
					 * The graph split this path did not have.
					 *
					 * A `before` return may carry the records that belong to this one — it is one hook and
					 * one return type now, and the runtime already split a graph out of the update arm on
					 * the declarative path. Here it did not: a returned relation key would have been handed
					 * to `encodeMutationValues` and dropped on the way to an `UPDATE`. So a return that names
					 * one leaves this path entirely for the graph planner, which is where reconciling a
					 * parent's children has always lived; the hooks it runs there are these same hooks, over
					 * the shape they already produced.
					 */
					const split = yield* splitGraphPayload(input.collection, before, 'update');
					if (split.included.length > 0)
						return yield* synchronizeGraph(
							effectId,
							subject,
							input.collection,
							{ ...before, id: input.id },
							false,
							depth,
							{ approved: false, rootId: input.id, rootAction: 'update' }
						).pipe(Effect.asVoid);
					values = split.own;
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
				if (module?.mutate?.perRecord?.after !== undefined) {
					const afterApi = buildApi(effectId, subject, true, depth + 1);
					const record = yield* readRowElevated(effectId, input.collection, input.id);
					yield* runHook(
						module.mutate.perRecord.after,
						{ previous: existing, changes: values, record, api: afterApi },
						afterApi,
						{
							collection: input.collection,
							action: 'mutate.after'
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
				depth = 0,
				options?: Readonly<{
					readonly baseVersion?: number;
					readonly browserMutation?: BrowserMutationFence;
				}>
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
					visibility.approval !== undefined ||
					options?.browserMutation !== undefined
				) {
					// An outbound delete binding needs this read for a reason no hook has: after the statement
					// runs there is no row left to describe, so a delivery that did not capture it first can
					// only say that *something* with this id is gone.
					existing = yield* readRowElevated(effectId, collection, id);
				}
				if (options?.browserMutation !== undefined)
					yield* assertBrowserBaseVersion(
						EffectId.make(`${effectId}:base-version`),
						options.browserMutation,
						collection,
						id,
						existing
					);
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
						approval,
						undefined,
						undefined,
						options?.browserMutation
					).pipe(
						Effect.catchTag('Bolt.Collections.PendingApproval', (pending) => {
							if (options?.browserMutation === undefined) return Effect.fail(pending);
							const outcome: BrowserMutationOutcome = {
								_tag: 'PendingApproval',
								requestId: pending.requestId,
								collection: pending.collection,
								id: pending.id,
								action: pending.action,
								schemaFingerprint: options.browserMutation.currentSchemaFingerprint
							};
							return rememberBrowserMutationOutcome(
								EffectId.make(`${effectId}:pending-approval`),
								options.browserMutation,
								outcome
							).pipe(
								Effect.flatMap((persisted) => replayBrowserMutationOutcome(persisted ?? outcome))
							);
						})
					);
				}
				const record =
					module?.delete?.perRecord?.after !== undefined
						? (existing ?? (yield* readRowElevated(effectId, collection, id)))
						: undefined;
				const replayed = yield* applyDelete(
					effectId,
					subject,
					collection,
					id,
					definition,
					false,
					existing,
					options?.browserMutation
				).pipe(
					Effect.as(false),
					Effect.catchCause((cause) => {
						if (options?.browserMutation === undefined || Cause.hasInterruptsOnly(cause))
							return Effect.failCause(cause);
						return browserMutationOutcome(
							EffectId.make(`${effectId}:concurrent-replay`),
							options.browserMutation.scope,
							options.browserMutation.idempotencyKey,
							options.browserMutation.requestDigest
						).pipe(
							Effect.flatMap((outcome) =>
								Effect.gen(function* () {
									if (outcome === undefined) return yield* Effect.failCause(cause);
									if (outcome._tag === 'Committed') return true;
									return yield* replayBrowserMutationOutcome(outcome);
								})
							)
						);
					})
				);
				if (replayed) return;
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
			const approvalBrowserMutationOutcome = Effect.fn(
				'Collections.approvalBrowserMutationOutcome'
			)(function* (effectId: EffectId, requestId: string, fence: BrowserMutationFence) {
				return yield* browserMutationOutcome(
					effectId,
					fence.scope,
					fence.idempotencyKey,
					fence.requestDigest
				).pipe(
					Effect.catchTag('Bolt.Collections.MutationIdempotencyConflict', () =>
						Effect.fail(
							new ApprovalConflict({
								requestId,
								reason: 'stored browser mutation approval provenance has a conflicting request digest'
							})
						)
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
				const browserMutation = operation.browserMutation;
				if (browserMutation !== undefined) {
					if (browserMutation.outcome._tag !== 'Committed')
						return yield* new ApprovalConflict({
							requestId,
							reason: 'stored browser mutation approval provenance has no committed outcome'
						});
					if (operation.action === 'create' && operation.mode !== 'declarative')
						return yield* new ApprovalConflict({
							requestId,
							reason: 'stored browser mutation approval provenance requires declarative create cleanup'
						});
					const message =
						state._tag === 'Rejected'
							? 'The approval request was rejected.'
							: state._tag === 'ChangesRequested'
								? 'Changes were requested for the approval request.'
								: 'The approval request was withdrawn.';
					const rejected: BrowserMutationOutcome = {
						_tag: 'Rejected',
						code: 'refused',
						message,
						schemaFingerprint: browserMutation.currentSchemaFingerprint,
						collection: operation.collection,
						action: operation.action
					};
					const durable = yield* approvalBrowserMutationOutcome(
						EffectId.make(`${effectId}:browser-mutation-approval-state`),
						requestId,
						browserMutation
					);
					if (
						durable?._tag === 'Rejected' &&
						Schema.toEquivalence(BrowserMutationOutcome)(durable, rejected)
					)
						return;
					if (
						durable?._tag !== 'PendingApproval' ||
						durable.requestId !== requestId ||
						durable.collection !== operation.collection ||
						durable.id !== operation.id ||
						durable.action !== operation.action
					)
						return yield* new ApprovalConflict({
							requestId,
							reason: 'stored browser mutation approval provenance does not match its ledger outcome'
						});
					const releasesRecord = operation.action !== 'create';
					const statements = [
						browserMutationApprovalGuardStatement(
							browserMutation,
							requestId,
							operation.collection,
							operation.id,
							operation.action
						),
						...(releasesRecord
							? [approvalReleaseStatement(operation.collection, operation.id, requestId)]
							: []),
						browserMutationApprovalRejectionStatement(
							browserMutation,
							requestId,
							operation.collection,
							operation.id,
							operation.action,
							rejected
						)
					];
					yield* database.execute(effectId, { _tag: 'Transaction', statements });
					if (releasesRecord)
						yield* wake
							.announce(EffectId.make(`${effectId}:approval-release-wake`), [operation.collection])
							.pipe(Effect.timeout(250), Effect.ignore);
					return;
				}
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
				const browserMutation = operation.browserMutation;
				if (browserMutation !== undefined) {
					if (browserMutation.outcome._tag !== 'Committed')
						return yield* new ApprovalConflict({
							requestId,
							reason: 'stored browser mutation approval provenance has no committed outcome'
						});
					const durable = yield* approvalBrowserMutationOutcome(
						EffectId.make(`${effectId}:browser-mutation-approval-state`),
						requestId,
						browserMutation
					);
					if (
						durable?._tag === 'Committed' &&
						Schema.toEquivalence(BrowserMutationOutcome)(durable, browserMutation.outcome)
					)
						return;
					if (
						durable?._tag !== 'PendingApproval' ||
						durable.requestId !== requestId ||
						durable.collection !== operation.collection ||
						durable.id !== operation.id ||
						durable.action !== operation.action
					)
						return yield* new ApprovalConflict({
							requestId,
							reason: 'stored browser mutation approval provenance does not match its ledger outcome'
						});
				}
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
							...(operation.review === undefined ? {} : { review: operation.review }),
							...(browserMutation === undefined ? {} : { browserMutation })
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
								if (browserMutation !== undefined && !Cause.hasInterruptsOnly(cause)) {
									const durable = yield* approvalBrowserMutationOutcome(
										EffectId.make(`${effectId}:browser-mutation-approval-replay`),
										requestId,
										browserMutation
									);
									if (
										durable?._tag === 'Committed' &&
										Schema.toEquivalence(BrowserMutationOutcome)(
											durable,
											browserMutation.outcome
										)
									)
										return;
								}
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
						),
						Effect.catchTag('Bolt.Collections.MutationIdempotencyConflict', (failure) =>
							Effect.fail(mutationPhaseFailure('commit', operation.collection, [], failure))
						),
						Effect.catchTag('Bolt.Collections.MutationVersionConflict', (failure) =>
							Effect.fail(mutationPhaseFailure('commit', operation.collection, [], failure))
						),
						Effect.catchTag('Bolt.Collections.MutationQuarantined', (failure) =>
							Effect.fail(mutationPhaseFailure('commit', operation.collection, [], failure))
						)
					);
					return;
				}
				if (browserMutation !== undefined && operation.action !== 'delete')
					return yield* new ApprovalConflict({
						requestId,
						reason: 'stored browser mutation approval provenance requires declarative resume'
					});
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
						if (createdModule?.mutate?.perRecord?.after !== undefined) {
							const api = buildApi(effectId, operation.subject, true);
							const record = yield* readRowElevated(effectId, operation.collection, operation.id);
							// `previous` is undefined because this settled an approved *create*; the unified
							// after-hook tells the two apart by exactly that, as the id does everywhere else.
							yield* runHook(
								createdModule.mutate.perRecord.after,
								{ previous: undefined, changes: operation.values, record, api },
								api,
								{
									collection: operation.collection,
									action: 'mutate.after'
								}
							);
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
						if (updatedModule?.mutate?.perRecord?.after !== undefined) {
							const api = buildApi(effectId, operation.subject, true);
							const record = yield* readRowElevated(effectId, operation.collection, operation.id);
							yield* runHook(
								updatedModule.mutate.perRecord.after,
								{ previous, changes: operation.values, record, api },
								api,
								{
									collection: operation.collection,
									action: 'mutate.after'
								}
							);
						}
						yield* emitChangeEvents(effectId, operation.collection, operation.id, 'updated');
						return;
					}
					case 'delete': {
						const record = yield* readRowElevated(effectId, operation.collection, operation.id);
						const replayed = yield* applyDelete(
							effectId,
							operation.subject,
							operation.collection,
							operation.id,
							definition,
							false,
							record,
							browserMutation,
							requestId
						).pipe(
							Effect.as(false),
							Effect.catchCause((cause) => {
								if (browserMutation === undefined || Cause.hasInterruptsOnly(cause))
									return Effect.failCause(cause);
								return approvalBrowserMutationOutcome(
									EffectId.make(`${effectId}:browser-mutation-approval-replay`),
									requestId,
									browserMutation
								).pipe(
									Effect.flatMap((outcome) =>
										outcome?._tag === 'Committed' &&
										Schema.toEquivalence(BrowserMutationOutcome)(
											outcome,
											browserMutation.outcome
										)
											? Effect.succeed(true)
											: Effect.failCause(cause)
									)
								);
							})
						);
						if (replayed) return;
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
				findFirst: Effect.fn('Collections.findFirst')(function* (effectId, subject, input) {
					return (yield* findMany(effectId, subject, { ...input, limit: 1 }))[0];
				}),
				count,
				findNearest,
				findGrouped,
				create,
				createMany,
				mutate: (effectId, subject, collection, payloads, elevated = false, depth = 0, options) =>
					mutate(effectId, subject, collection, payloads, elevated, depth, options).pipe(
						Effect.catchIf(isBrowserMutationReplay, (cause) =>
							cause.outcome._tag === 'Committed'
								? Effect.succeed([{ id: cause.outcome.id }])
								: Effect.fail(mutationPhaseFailure('commit', collection, [], cause))
						)
					),
				// The implementation carries a `depth` argument for its own recursion guard; the service
				// contract is the three-argument call, so the extra parameter stops here rather than
				// widening the published signature.
				update: (effectId, subject, input) =>
					update(effectId, subject, input).pipe(
						// A replayed browser mutation has already been decided; the update returns nothing
						// either way, so there is no outcome left to report. `delete` settles it identically.
						Effect.catchIf(isBrowserMutationReplay, () => Effect.void),
						// An update runs a graph, so it can fail inside a phase — but a single-row update has
						// no batch for a phase to be meaningful about, and its callers' error unions do not
						// carry one. The refusal underneath is the answer they wanted; the wrapper is not.
						Effect.catchIf(
							(cause): cause is MutationPhaseFailure => cause instanceof MutationPhaseFailure,
							(cause) => Effect.fail(cause.underlying as MutationError)
						)
					),
				delete: (effectId, subject, collection, id, options) =>
					deleteRecord(effectId, subject, collection, id, 0, options).pipe(
						Effect.catchIf(isBrowserMutationReplay, () => Effect.void)
					),
				browserMutationOutcome,
				registerBrowserMutationPartition,
				browserMutationPartition,
				browserMutationDelivery,
				beginBrowserMutation,
				rememberBrowserMutationOutcome,
				resume: (effectId, requestId) =>
					resume(effectId, requestId).pipe(
						Effect.catchIf(isBrowserMutationReplay, () => Effect.void),
						Effect.asVoid
					),
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
						for (let index = 0; index < rows.length; index += 1) {
							const row = rows[index];
							const collection = inputs[index]?.collection ?? inputs[0]?.collection ?? '';
							if (typeof row !== 'object' || row === null || Array.isArray(row)) {
								return yield* new AccessControl.AccessDenied({
									action: 'import',
									resource: collection,
									reason: `import pipeline row ${index + 1} is not a record`
								});
							}
							const record = row as Readonly<Record<string, unknown>>;
							const submittedId = record['id'];
							if (
								submittedId !== undefined &&
								(typeof submittedId !== 'string' || submittedId.length === 0)
							) {
								return yield* new AccessControl.AccessDenied({
									action: 'import',
									resource: collection,
									reason: `import pipeline row ${index + 1} has an invalid id`
								});
							}
							const action = typeof submittedId === 'string' ? 'update' : 'create';
							const id =
								typeof submittedId === 'string'
									? submittedId
									: deriveRecordId(`${collection}:${effectId}:${index}`);
							/**
							 * The runtime, not authored code, owns a create's identity. Supplying the derived id to
							 * the graph lets a retry choose the same row without misclassifying that id as an update;
							 * an authored id is the opposite assertion and deliberately selects update. Both then
							 * take the canonical declarative mutation path, including hooks, policy and relations.
							 */
							yield* mutate(
								EffectId.make(`${effectId}:${index}`),
								subject,
								collection,
								[{ ...record, id }],
								false,
								0,
								{ declarative: true, root: { id, action } }
							).pipe(
								// Imports never carry a browser-mutation fence, so replay cannot be a
								// recoverable outcome on this path. Keep that internal invariant out of
								// the public import error union instead of pretending it is a business error.
								Effect.catchIf(isBrowserMutationReplay, (cause) => Effect.die(cause)),
								Effect.catchIf(
									(cause): cause is MutationPhaseFailure => cause instanceof MutationPhaseFailure,
									(cause) => Effect.fail(cause.underlying as MutationError)
								)
							);
						}
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
