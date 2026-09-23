import { Secrets } from '#lib/runtime/secrets/secrets.js';
import { connectionReader } from '#lib/runtime/automations/connection.js';
import { webReader } from '#lib/runtime/automations/web.js';
import { deriveRecordId } from '#lib/runtime/derive-record-id.js';
import {
	DEFAULT_RECORD_EMBEDDING_DIMENSIONS,
	RECORD_EMBEDDING_COLUMN
} from '#lib/authoring/model-introspection.js';
import { emitChangeEventsMany as emitChangeEventsManyService } from '#lib/runtime/collections/services/change-events.js';
import { automationChannels, notifyStatements, outboundRows } from '#lib/runtime/channels/channels.js';
import type { NotifyInput } from '#lib/authoring/channels-schema.js';
import { syncOwnershipRefusal } from '#lib/runtime/integrations/integrations.js';
import { embedRecords as embedRecordsService } from '#lib/runtime/collections/services/embeddings.js';
import {
	and,
	asc,
	count as countRows,
	desc,
	eq,
	getColumns,
	isNotNull,
	sql,
	type SQL
} from 'drizzle-orm';
import { type AnyPgColumn } from 'drizzle-orm/pg-core';
import {
	Cause,
	Clock,
	Deferred,
	Effect,
	Layer,
	Result,
	Schema,
	SchemaAST,
	type Context
} from 'effect';
import {
	AIRequest,
	CollectionMutationBaseVersion,
	CollectionMutationIdempotencyKey,
	COLLECTION_MUTATION_RETRY_HORIZON_MILLIS,
	COLLECTION_MUTATION_QUARANTINE_RETENTION_MILLIS,
	compactSyncChanges,
	EffectId,
	ModelId,
	ProviderCallId,
	type CollectionMutationPush,
	type CollectionMutationSettlement,
	type SyncChange,
	type SyncOutcome,
	type SyncWriteStatus
} from '@norbital-ai/bolt-protocol';
import { toError } from '@norbital-ai/std';
import { decodeNumber } from '@norbital-ai/std/json';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import {
	compileCollectionPredicate,
	compileOrderTerms,
	policyIndexRequirements,
	WhereCompileError,
	type OrderTerm
} from '#lib/runtime/access/effective-plan.js';
import * as Approvals from '#lib/runtime/approvals/approvals.js';
import { ApprovalConflict } from '#lib/runtime/approvals/approvals.js';
import { refusalOf } from '#lib/authoring/refusal.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { record } from '#lib/runtime/telemetry.js';
import { AI, Connector, Files, HostTools, SyncCommit } from '#lib/runtime/facilities/services.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import * as Automations from '#lib/runtime/automations/automations.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import { Subject } from '#lib/runtime/identity/identity.js';
import { isWorkspaceSubject, workspaceSubject } from '#lib/runtime/identity/static-identity.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { describeCause } from '#lib/runtime/workspace.js';
import { AutomationProgression, type AutomationApi } from '#lib/authoring/automations-schema.js';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import { SYSTEM_COLLECTION_NAMES } from '#lib/runtime/schema/system-collections.js';
import type {
	CollectionDefinition,
	FieldDefinition,
	RelationDefinition,
	WorkspaceDefinition
} from '#lib/authoring/workspace-schema.js';
import type {
	AuthoredCollectionModule,
	CollectionInputSelection,
	CollectionLifecycleEvent
} from '#lib/authoring/collection-schema.js';
import {
	lowerDeclaredPayload,
	type DeclaredLowering
} from '#lib/runtime/collections/write/declared.js';
import {
	SEARCH_DOCUMENT_COLUMN,
	prepareSearchPlan,
	type NearestProbe,
	type SearchContext,
	type SearchInput
} from '#lib/runtime/collections/read/search.js';
import { SEARCH_DISTANCE_COLUMN } from '@norbital-ai/std/collection';
import {
	readRelational as readRelationalService,
	ROOT_ALIAS,
	type MaskRow,
	type PlanContext
} from '#lib/runtime/collections/read/index.js';
import {
	DEFAULT_HISTORY_HORIZON,
	PersistedCollectionAuditRow,
	PersistedCollectionHistoryRow,
	collectionAuditJoinStatement,
	collectionHistoryReadStatement,
	historyPatchesFromRows,
	historyPruneStatements,
	presentHistoryRevisions,
	projectHistory
} from '#lib/runtime/collections/services/history.js';
import { compileCollectionCursorSeek } from '#lib/runtime/collections/read/cursor.js';
import {
	type AppliedDeclarativeGraph,
	type GraphPreparedOperation
} from '#lib/runtime/collections/write/engine.js';
import { canonicalJson } from '#lib/canonical-json.js';
import { settleDeclarativeGraph as settleDeclarativeGraphService } from '#lib/runtime/collections/write/settle.js';
import {
	makeGraphReader,
	relatedRowsKey,
	storedGraphRowKey
} from '#lib/runtime/collections/write/graph-read.js';
import { deleteHistoryIdentity } from '#lib/runtime/collections/write/identity-snapshot.js';
import * as OneStatement from '#lib/runtime/collections/write/one-statement.js';
import { systemCollectionModules } from '#lib/runtime/schema/system-collections.js';
import {
	MAX_ORDINARY_MUTATION_CHANGED_ROWS,
	TRANSFORM_READ_WAVES,
	WRITE_DEPTH_LIMIT,
	captureFieldsForWorkspace,
	ordinaryMutationChangedRowCount,
	ownsManyRelation,
	releasesManyRelation,
	projectLinkAndRouteValues,
	writeOperationChangesRow,
	writeRecordKey,
	type DeclaredCaptureFields,
	type WritableManyRelation
} from '#lib/runtime/collections/write/plan.js';
import {
	statementPlanFor,
	type PredicateAssertionExpectation,
	type WriteStatementPlan
} from '#lib/runtime/collections/write/statements.js';
import {
	CollectionAction,
	MutationPhaseFailure,
	PendingApproval,
	Service,
	mutationPhaseFailure,
	type BatchMutationError,
	type BrowserMutationFence,
	BrowserMutationOutcome,
	type BrowserMutationScope,
	type CollectionAuditEntry,
	type CollectionHistorySnapshot,
	type CollectionMutationCommit,
	type Interface,
	ApprovalHeld,
	type WriteCommit,
	type WriteGroup,
	type WriteOptions,
	MutationIdempotencyConflict,
	MutationInProgress,
	type MutationError,
	type MutationInput,
	MutationRetryExpired,
	MutationQuarantined,
	MutationVersionConflict,
	ReadBudgetExceeded,
	type QueryError,
	type NearestQueryInput,
	type QueryInput,
	type QueryRow,
	type ResumeError
} from './collections.contract.js';
export {
	MutationPhaseFailure,
	MutationIdempotencyConflict,
	MutationInProgress,
	MutationRetryExpired,
	MutationQuarantined,
	MutationVersionConflict,
	PendingApproval,
	ReadBudgetExceeded,
	Service,
	mutationPhaseFailure
} from './collections.contract.js';
export type {
	Interface,
	BatchMutationError,
	CollectionAuditEntry,
	CollectionHistorySnapshot,
	ApprovalHeld,
	WriteCommit,
	WriteGroup,
	WriteOptions,
	MutationError,
	MutationInput,
	MutationPhase,
	QueryError,
	NearestQueryInput,
	QueryInput,
	QueryRow,
	ResumeError
} from './collections.contract.js';
import { collectionQueryTable, relationalSchema } from '#lib/runtime/schema/relational-schema.js';
import {
	decodeReferenceRow,
	encodeReferenceValues,
	referenceValueProblem
} from '#lib/runtime/collections/references.js';
import { describeInvalidCustomValue } from '#lib/runtime/collections/custom-values.js';
import {
	afterMillisOf,
	AuthoredRuntimeService,
	guardAuthoringOps,
	makeAutomationApi,
	embedRecordsSummary,
	makeAuthoringApi,
	makeAuthoringOps,
	makeAuthoringReadOps,
	makePolicyDecisionApi,
	makeTransformDb,
	runAuthoredHandler,
	type AuthoringPorts,
	type AutomationContinuation
} from '#lib/runtime/collections/authored.js';
import {
	PreparingReads,
	READ_CONFLICT_MESSAGE,
	executeObservedRead,
	readConsistencyStatements,
	type ReadSnapshot
} from '#lib/runtime/collections/read-consistency.js';
import { readFileAsset } from '#lib/runtime/collections/file-assets.js';
import { AuthoredRefusal, refusalAt, type RefusalSite } from '#lib/authoring/refusal.js';
import * as InvocationBudget from '#lib/runtime/budget.js';
import { approvalFlowDescriptor } from '#lib/authoring/approval-flow.js';
import { approvalStepId } from '#lib/authoring/policy-introspection.js';
import { drizzle } from 'drizzle-orm/pg-proxy';
import {
	aliased,
	always,
	composer,
	dbNow,
	executeBuilt,
	lessThanOrEqual,
	refuseExecution,
	toStatement,
	transactionSql,
	vectorDistance,
	type RelationalBuilder
} from '#lib/runtime/persistence.js';

const {
	bolt_collection_history: collectionHistoryTable,
	bolt_task: boltTaskTable
} = SYSTEM_MODEL_TABLES;

/** The pgvector operator each accepted metric measures with. */
const NEAREST_OPERATORS = { cosine: '<=>', l2: '<->', ip: '<#>' } as const;

/** Browser mutation dedup is private runtime bookkeeping and is never a queryable collection. */
const BROWSER_MUTATION_TABLE = 'bolt_browser_mutation';
/** Keep quarantined keys past the retention horizon so cleanup cannot reopen a live key. */
const BROWSER_MUTATION_RETENTION_MILLIS = 21 * 24 * 60 * 60 * 1000;
/** Opportunistic bounded cleanup; mutation latency can never grow with the ledger. */
const BROWSER_MUTATION_CLEANUP_LIMIT = 256;
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
		COLLECTION_MUTATION_QUARANTINE_RETENTION_MILLIS
	) +
		5 * 60 * 1000) /
	1000;

const sha256Hex = Effect.fn('Collections.sha256Hex')((value: string) =>
	Effect.tryPromise({
		try: async () => {
			const digest = await globalThis.crypto.subtle.digest(
				'SHA-256',
				new TextEncoder().encode(value)
			);
			return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
		},
		catch: toError
	})
);

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
/** The `JsonObject` predicate, built once: it is consulted for every row the facility hands back. */
const isJsonObject = Schema.is(JsonObject);
const queryRowOf = Schema.decodeUnknownSync(JsonObject);
const isNumber = Schema.is(Schema.Number);
const isNonEmptyString = Schema.is(Schema.NonEmptyString);
const isPlainRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isFiniteNumber = (value: unknown): boolean => isNumber(value) && Number.isFinite(value);
/**
 * Drizzle's connectionless `toSQL()` does not run a JSONB column's driver encoder.
 *
 * The facility receives plain parameters rather than a Drizzle session, so JSON values must cross
 * this boundary as JSON text. PostgreSQL then parses the bound text using the target JSONB column's
 * type. SQL null stays null; a JSON null is not used by these bookkeeping rows.
 */

/** Maximum exact grouped membership; the SQL query fails closed instead of truncating past it. */
const GROUPED_RESULT_LIMIT = 5000;
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
		authorityId: Schema.NonEmptyString
	}),
	idempotencyKey: CollectionMutationIdempotencyKey,
	requestDigest: Schema.NonEmptyString,
	issuedAtEpochMs: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isFinite()),
	partitionKey: Schema.NonEmptyString,
	schemaFingerprint: Schema.NonEmptyString,
	currentSchemaFingerprint: Schema.NonEmptyString,
	baseVersions: Schema.Array(CollectionMutationBaseVersion),
	outcome: BrowserMutationOutcome
});
const CollectionSql = {
	quoteIdentifier: (name: string): string => `"${name.replaceAll('"', '""')}"`
};
const quoteIdentifier = CollectionSql.quoteIdentifier;

/**
 * One row on its way into a table, before anything has decided which statement carries it.
 *
 * Rows that name the same columns of the same table are one `insert … select … from
 * jsonb_populate_recordset(null::table, $1)`: the recordset is typed by the table, so a column the
 * row omits takes the table's default (only the named columns are selected), a JSON column takes
 * the object as it is, and a batch of ten thousand rows is one parameter rather than a parameter
 * per cell.
 */
export type PlannedInsert = Readonly<{
	readonly table: string;
	readonly columns: ReadonlyArray<string>;
	/** Per column, the value as JSON — an object for a JSON column, never its string encoding. */
	readonly values: ReadonlyArray<Schema.Json>;
	/**
	 * The condition this row is written under, when it is not written unconditionally: the
	 * visibility predicate of a row the subject may not be allowed to write. A predicated row is
	 * written alone as `insert … select $1, $2 … where <predicate>`: a `VALUES` list has nowhere
	 * to hang a predicate, and a subquery would put the row's own columns in the predicate's scope,
	 * so a grant whose `where` names a column of the collection would resolve against the row
	 * being written instead of failing as it does today.
	 */
	readonly where?: Readonly<{
		readonly sql: string;
		readonly parameters: ReadonlyArray<Schema.Json>;
		/** The per-column casts the row's own placeholders carry (`::jsonb`, `::vector`). */
		readonly casts: ReadonlyArray<string>;
		readonly parameterValues: ReadonlyArray<Schema.Json>;
	}>;
	/** The piece name a predicated record is written under, so its bookkeeping can name it. */
	readonly key?: string;
	/** Written only if the piece named here wrote a row — bookkeeping that must not outlive its record. */
	readonly after?: string;
	/** An `on conflict` clause the insert carries, verbatim. */
	readonly onConflict?: string;
}>;

/** What two rows must share to be one statement: table, columns, condition and conflict clause. */
const insertSignature = (row: PlannedInsert): string =>
	`${row.table}\u0000${row.columns.join(',')}\u0000${row.after ?? ''}\u0000${row.onConflict ?? ''}`;

/** A plan's statements tallied by their first two words: `update "notes"=1 insert into=2 …`. */
const statementShapes = (statements: ReadonlyArray<{ readonly sql: string }>): string => {
	const tally = new Map<string, number>();
	for (const statement of statements) {
		const shape = statement.sql.trim().split(/\s+/).slice(0, 2).join(' ');
		tally.set(shape, (tally.get(shape) ?? 0) + 1);
	}
	return [...tally].map(([shape, count]) => `${shape}=${count}`).join(' ');
};

/** One insert group: the rows it writes and the piece that writes them. */
type InsertGroup = Readonly<{
	readonly key: string;
	readonly table: string;
	readonly rows: ReadonlyArray<PlannedInsert>;
	readonly fragment: OneStatement.Fragment;
}>;

const recordsetRows = (rows: ReadonlyArray<PlannedInsert>): string =>
	JSON.stringify(
		rows.map((row) =>
			Object.fromEntries(row.columns.map((column, index) => [column, row.values[index] ?? null]))
		)
	);

/**
 * Rows as the fewest inserts that write them, each returning what it wrote.
 *
 * Grouping is by the columns a row names rather than by "the batch", because a transform may
 * return different keys per row, and padding the gaps with explicit NULLs would write a NULL where
 * the column default belongs. A predicated row is a group of one, with the statement it has always
 * had; a row written `after` another piece is written only when that piece wrote its row.
 */
export const groupedInserts = (rows: ReadonlyArray<PlannedInsert>): ReadonlyArray<InsertGroup> => {
	const groups = new Map<string, Array<PlannedInsert>>();
	rows.forEach((row, index) => {
		const key = row.where === undefined ? insertSignature(row) : `\u0000row ${index}`;
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [row]);
		else group.push(row);
	});
	return [...groups.values()].map((group, index) => {
		const first = group[0]!;
		const key = first.key ?? `ins${index}`;
		const table = quoteIdentifier(first.table);
		const columns = first.columns.map(quoteIdentifier).join(', ');
		const conflict = first.onConflict === undefined ? '' : ` ${first.onConflict}`;
		if (first.where !== undefined) {
			const tuple = first.columns
				.map((_, index) => `$${index + 1}${first.where?.casts[index] ?? ''}`)
				.join(', ');
			return {
				key,
				table: first.table,
				rows: group,
				fragment: {
					sql: `insert into ${table} (${columns}) select ${tuple} where ${first.where.sql}${conflict} returning *`,
					parameters: [...first.where.parameterValues, ...first.where.parameters]
				}
			};
		}
		const selected = first.columns.map((column) => `v.${quoteIdentifier(column)}`).join(', ');
		const gate =
			first.after === undefined
				? ''
				: ` where exists (select 1 from ${OneStatement.cteName(first.after)})`;
		return {
			key,
			table: first.table,
			rows: group,
			fragment: {
				sql: `insert into ${table} (${columns}) select ${selected} from jsonb_populate_recordset(null::${table}, $1::jsonb) as v${gate}${conflict} returning *`,
				parameters: [recordsetRows(group)]
			}
		};
	});
};

type PlannedUpdate = Readonly<{
	readonly table: string;
	readonly id: string;
	/** The version the row was prepared at; the update applies only while the row is still there. */
	readonly rowVersion: number | undefined;
	/** The assigned columns in name order, their values as JSON. */
	readonly columns: ReadonlyArray<string>;
	readonly values: ReadonlyArray<Schema.Json>;
}>;

/** One update group: its rows and the piece that applies them; the caller asserts the count. */
type UpdateGroup = Readonly<{
	readonly key: string;
	readonly table: string;
	readonly rows: ReadonlyArray<PlannedUpdate>;
	readonly fragment: OneStatement.Fragment;
}>;

/**
 * Updates of one shape — one table, one set of assigned columns — are one statement, and the
 * version guard rides inside it: `jsonb_populate_recordset(null::table, $1)` carries each row's
 * prepared `row_version`, the update matches only a row still at that version, and the count of
 * rows it returns is asserted by the caller. A row another writer moved is re-read by the update
 * under READ COMMITTED with its new version, fails the match, and the count refuses the write.
 */
export const groupedUpdates = (rows: ReadonlyArray<PlannedUpdate>): ReadonlyArray<UpdateGroup> => {
	const groups = new Map<string, Array<PlannedUpdate>>();
	for (const row of rows) {
		const key = `${row.table}\u0000${row.columns.join(',')}`;
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [row]);
		else group.push(row);
	}
	return [...groups.values()].map((group, index) => {
		const first = group[0]!;
		const table = quoteIdentifier(first.table);
		const assignments = [
			...first.columns.map((column) => `${quoteIdentifier(column)} = v.${quoteIdentifier(column)}`),
			'updated_at = now()',
			'row_version = t.row_version + 1'
		];
		return {
			key: `upd${index}`,
			table: first.table,
			rows: group,
			fragment: {
				sql: `update ${table} as t set ${assignments.join(', ')} from jsonb_populate_recordset(null::${table}, $1::jsonb) as v where t.id = v.id and (v.row_version is null or t.row_version = v.row_version) returning t.*`,
				parameters: [
					JSON.stringify(
						group.map((row) =>
							Object.fromEntries([
								['id', row.id],
								['row_version', row.rowVersion ?? null],
								...row.columns.map((column, index) => [column, row.values[index] ?? null])
							])
						)
					)
				]
			}
		};
	});
};

/** One row a grouped delete is built from. */
type PlannedDelete = Readonly<{
	readonly table: string;
	readonly id: string;
	readonly rowVersion: number | undefined;
}>;

type DeleteGroup = Readonly<{
	readonly key: string;
	readonly table: string;
	readonly rows: ReadonlyArray<PlannedDelete>;
	readonly fragment: OneStatement.Fragment;
}>;

/** Deletes of one table as one statement, version-guarded the way a grouped update is. */
const groupedDeletes = (rows: ReadonlyArray<PlannedDelete>): ReadonlyArray<DeleteGroup> => {
	const byTable = Map.groupBy(rows, (row) => row.table);
	return [...byTable.entries()].map(([name, group], index) => {
		const table = quoteIdentifier(name);
		return {
			key: `del${index}`,
			table: name,
			rows: group,
			fragment: {
				sql: `delete from ${table} as t using jsonb_populate_recordset(null::${table}, $1::jsonb) as v where t.id = v.id and (v.row_version is null or t.row_version = v.row_version) returning t.id`,
				parameters: [
					JSON.stringify(group.map((row) => ({ id: row.id, row_version: row.rowVersion ?? null })))
				]
			}
		};
	});
};

const quoteStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * The read-back of the rows this statement wrote, from the pieces that wrote them.
 *
 * Every sub-statement of one `WITH` sees the snapshot the statement began with, so the tables
 * still show the rows as they were; what a piece wrote is in its `RETURNING` set and nowhere
 * else. The wanted list is one `values` clause; each writing piece is one join. The capture
 * guard refuses a missing row — a predicated insert the predicate declined, a version-guarded
 * update that matched nothing — which is what makes the count the write's last word.
 */
/** Where a written row is read back from: the piece that wrote it, or the table for a row left as it was. */
type CaptureSource = Readonly<
	{ readonly collection: string } & (
		{ readonly key: string } | { readonly ids: ReadonlyArray<string> }
	)
>;

const captureFinal = (
	operations: ReadonlyArray<Pick<GraphPreparedOperation, 'collection' | 'id'>>,
	sources: ReadonlyArray<CaptureSource>
): OneStatement.Fragment => {
	if (operations.length === 0)
		return {
			sql: 'select null::integer as "__bolt_graph_ordinal", null::text as "__bolt_graph_collection", null::text as "__bolt_graph_id", null::jsonb as "__bolt_graph_record" from anchor where false',
			parameters: []
		};
	const parameters: Array<Schema.Json> = [];
	const values = operations.map((operation, index) => {
		const ordinal = parameters.push(index);
		const collection = parameters.push(operation.collection);
		const id = parameters.push(operation.id);
		return index === 0
			? `($${ordinal}::integer, $${collection}::text, $${id}::text)`
			: `($${ordinal}, $${collection}, $${id})`;
	});
	// A source with no piece is a row the write named and left as it was (an update whose every
	// value was derived away): the table still shows it, and the snapshot is the row.
	const capturedSelects = sources.map((source) => {
		const from =
			'key' in source ? OneStatement.cteName(source.key) : quoteIdentifier(source.collection);
		const only =
			'key' in source
				? ''
				: ` and written.id::text = any($${parameters.push([...source.ids])}::text[])`;
		return `select wanted.ordinal as "__bolt_graph_ordinal", wanted.collection as "__bolt_graph_collection", wanted.id as "__bolt_graph_id", to_jsonb(written) as "__bolt_graph_record" from wanted join ${from} as written on wanted.collection = ${quoteStringLiteral(source.collection)} and written.id::text = wanted.id${only}`;
	});
	return {
		sql: `with wanted(ordinal, collection, id) as (values ${values.join(', ')}), captured as materialized (${capturedSelects.join(' union all ')}), capture_guard as materialized (select bolt_assert((select count(*) = ${operations.length} from captured), 'The ordinary mutation capture omitted an expected row.')) select captured.* from anchor cross join capture_guard left join captured on true where captured."__bolt_graph_ordinal" is not null order by captured."__bolt_graph_ordinal"`,
		parameters
	};
};

/**
 * The writable orientation of a declared parent-to-children relationship.
 *
 * Authored relationship modules normally put the endpoints on the inverse `one` edge, not on the
 * parent's `many` edge. Programmatic workspaces sometimes put them directly on `many`. Both spell
 * the same ownership fact, so the runtime resolves both and every graph consumer shares the answer.
 */
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
		cascade: boolean,
		setNull: boolean
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
					cascade,
					setNull
				};
	};

	const inverseRelations = definition.relations.filter(
		(relation) =>
			relation.source === many.target &&
			relation.target === parentCollection &&
			relation.cardinality === 'one'
	);
	const inverseCascade = inverseRelations.length === 1 && inverseRelations[0]?.cascade === true;
	const inverseSetNull = inverseRelations.length === 1 && inverseRelations[0]?.setNull === true;
	const direct = oriented(
		many.from,
		many.to,
		many.target,
		many.cascade === true || inverseCascade,
		many.setNull === true || inverseSetNull
	);
	if (direct !== undefined) return direct;
	// The two sides are independently named for the UI (`account_contacts` / `contact_account`), so
	// identity is the reversed collections and endpoints, not equal relation names. More than one
	// usable inverse is ambiguous and therefore not writable.
	const inverses = inverseRelations.flatMap((relation) => {
		const resolved = oriented(
			relation.from,
			relation.to,
			many.target,
			many.cascade === true || relation.cascade === true,
			many.setNull === true || relation.setNull === true
		);
		return resolved === undefined ? [] : [resolved];
	});
	return inverses.length === 1 ? inverses[0] : undefined;
};

/**
 * `AuthoredRefusal` is a member of every channel because authored code runs on every path: the
 * transform on a write, the import pipeline under `import`, the export pipeline under `export`.
 * It is stated rather than left to inference so that a caller which handles these unions
 * exhaustively has to decide what a business rule refusing means for it.
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
 * Resolves one query's SQL predicate from its authored `where`, narrowed by the generic surface's
 * `userFilter` when one is present. Compilation failure is raised here so every read path reports
 * the offending column rather than running a widened query.
 */
const compiledFilter = (
	input: QueryInput,
	definition: WorkspaceDefinition,
	qualifier?: string
): Effect.Effect<SQL, WhereCompileError> => {
	const authored =
		input.where === undefined
			? Result.succeed(sql`true`)
			: Result.map(
					compileCollectionPredicate({
						definition,
						collection: input.collection,
						where: input.where,
						...(qualifier === undefined ? {} : { qualifier }),
						node: 'query.where'
					}),
					({ sql: statement }) => statement
				);
	if (Result.isFailure(authored)) return Effect.fail(authored.failure);
	if (input.userFilter === undefined) return Effect.succeed(authored.success);
	const narrowed = Result.map(
		compileCollectionPredicate({
			definition,
			collection: input.collection,
			where: input.userFilter,
			...(qualifier === undefined ? {} : { qualifier }),
			node: 'query.userFilter'
		}),
		({ sql: statement }) => statement
	);
	return Result.isFailure(narrowed)
		? Effect.fail(narrowed.failure)
		: Effect.succeed(and(authored.success, narrowed.success) ?? authored.success);
};

/** Projects the canonical effective-plan relation/routing manifest into the write-capture shape. */
const effectivePlanCaptureManifest = (definition: WorkspaceDefinition): DeclaredCaptureFields => {
	const manifest = new Map<string, Set<string>>();
	for (const collection of definition.collections) manifest.set(collection.name, new Set());
	for (const requirement of policyIndexRequirements(definition)) {
		const fields = manifest.get(requirement.collection) ?? new Set<string>();
		fields.add(requirement.field);
		manifest.set(requirement.collection, fields);
	}
	return Object.fromEntries(
		[...manifest].map(([collection, fields]) => [collection, [...fields].toSorted()])
	);
};

type LayerServices = Context.Service.Identifier<
	| typeof Workspace.Service
	| typeof TenantScope.Service
	| typeof AccessControl.Service
	| typeof Database.Service
	| typeof Approvals.Service
	| typeof AI.Service
	| typeof Files.Service
	| typeof Connector.Service
	| typeof Secrets.Service
	| typeof TaskQueue.Service
	| typeof Automations.Service
	| typeof SyncCommit.Service
	| typeof HostTools.Service
	| typeof AuthoredRuntimeService
>;

export const layerWith = (
	randomId: () => string = () => globalThis.crypto.randomUUID()
): Layer.Layer<Interface, never, LayerServices> =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const workspace = yield* Workspace.Service;
			const captureFields = captureFieldsForWorkspace(
				workspace.definition,
				effectivePlanCaptureManifest(workspace.definition)
			);
			const tenant = yield* TenantScope.Service;
			const access = yield* AccessControl.Service;
			const database = yield* Database.Service;
			const approvals = yield* Approvals.Service;
			const ai = yield* AI.Service;
			const files = yield* Files.Service;
			const connector = yield* Connector.Service;
			const secrets = yield* Secrets.Service;
			const queue = yield* TaskQueue.Service;
			const automations = yield* Automations.Service;
			const syncCommit = yield* SyncCommit.Service;
			const hostTools = yield* HostTools.Service;
			const authored = yield* AuthoredRuntimeService;
			const authoringCollectionNames = new Set([
				...workspace.definition.collections
					.map(({ name }) => name)
					.filter((name) => !SYSTEM_COLLECTION_NAMES.has(name)),
				'approval_request',
				'automation_run'
			]);
			const observedRead = (
				effectId: EffectId,
				database: Database.Interface,
				query: Parameters<typeof executeBuilt>[2]
			) =>
				executeObservedRead(effectId, database, query, [
					...workspace.definition.collections.map(({ name }) => name),
					...SYSTEM_COLLECTION_NAMES
				]);
			/** The authenticated composite key, in the same order as the unique database index. */
			const browserMutationScopeParameters = (
				scope: BrowserMutationScope,
				idempotencyKey: BrowserMutationFence['idempotencyKey']
			): ReadonlyArray<Schema.Json> => [
				scope.tenantId,
				scope.environment,
				scope.principalId,
				scope.authorityId,
				'collections.write',
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
			const browserMutationScopeFor = (
				actor: Identity.Subject,
				subject: Identity.Subject,
				impersonatedTeam: string | null
			): BrowserMutationScope => ({
				tenantId: tenant.tenantId,
				environment: tenant.environment,
				principalId: actor.userId,
				authorityId: canonicalJson({
					effectiveSubjectId: subject.userId,
					impersonationBinding: impersonatedTeam === null ? 'operator' : `team:${impersonatedTeam}`
				})
			});
			const projectBrowserMutationOutcome = (
				mutationId: CollectionMutationIdempotencyKey,
				outcome: BrowserMutationOutcome
			): Readonly<{
				readonly sync: SyncWriteStatus;
				readonly settle: (records?: ReadonlyArray<QueryRow>) => CollectionMutationSettlement;
			}> => {
				switch (outcome._tag) {
					case 'Committed':
						return outcome.resolution === 'rebased'
							? {
									sync: {
										resolution: 'rebased',
										fromSchemaFingerprint: outcome.fromSchemaFingerprint,
										toSchemaFingerprint: outcome.toSchemaFingerprint
									},
									settle: (records = []) => ({
										resolution: 'rebased',
										mutationId,
										fromSchemaFingerprint: outcome.fromSchemaFingerprint,
										toSchemaFingerprint: outcome.toSchemaFingerprint,
										records
									})
								}
							: {
									sync: { resolution: 'accepted', schemaFingerprint: outcome.toSchemaFingerprint },
									settle: (records = []) => ({
										resolution: 'accepted',
										mutationId,
										schemaFingerprint: outcome.toSchemaFingerprint,
										records
									})
								};
					case 'PendingApproval':
						return {
							sync: {
								resolution: 'accepted',
								schemaFingerprint: outcome.schemaFingerprint,
								pendingApproval: {
									requestId: outcome.requestId,
									collection: outcome.collection,
									id: outcome.id,
									action: outcome.action
								}
							},
							settle: () => ({
								resolution: 'accepted',
								mutationId,
								schemaFingerprint: outcome.schemaFingerprint,
								records: [],
								pendingApproval: {
									requestId: outcome.requestId,
									collection: outcome.collection,
									id: outcome.id,
									action: outcome.action
								}
							})
						};
					case 'VersionConflict': {
						const message =
							outcome.currentVersion === null
								? `${outcome.collection} ${outcome.id} no longer exists at row version ${outcome.baseVersion}.`
								: `${outcome.collection} ${outcome.id} changed from row version ${outcome.baseVersion} to ${outcome.currentVersion}.`;
						return {
							sync: {
								resolution: 'rejected',
								code: 'conflict',
								message,
								schemaFingerprint: outcome.schemaFingerprint
							},
							settle: () => ({
								resolution: 'rejected',
								mutationId,
								code: 'conflict',
								message,
								schemaFingerprint: outcome.schemaFingerprint
							})
						};
					}
					case 'Rejected':
						return {
							sync: {
								resolution: 'rejected',
								code: outcome.code,
								message: outcome.message,
								schemaFingerprint: outcome.schemaFingerprint
							},
							settle: () => ({
								resolution: 'rejected',
								mutationId,
								code: outcome.code,
								message: outcome.message,
								schemaFingerprint: outcome.schemaFingerprint
							})
						};
					case 'Quarantined':
						return {
							sync: {
								resolution: 'quarantined',
								schemaFingerprint: outcome.schemaFingerprint,
								reason: outcome.reason
							},
							settle: () => ({
								resolution: 'quarantined',
								mutationId,
								schemaFingerprint: outcome.schemaFingerprint,
								reason: outcome.reason
							})
						};
				}
			};
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
					sql: `with cleaned as (delete from ${BROWSER_MUTATION_TABLE} where ctid in (select ctid from ${BROWSER_MUTATION_TABLE} where expires_at < now() order by expires_at limit $13)), claimed as (insert into ${BROWSER_MUTATION_TABLE} (tenant_id, environment, principal_id, authority_id, command, idempotency_key, partition_key, schema_fingerprint, request_digest, status, issued_at, lease_expires_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'running', to_timestamp($10 / 1000.0), now() + make_interval(secs => $12), to_timestamp(($10 + $11) / 1000.0)) on conflict (tenant_id, environment, principal_id, authority_id, command, idempotency_key) do nothing returning id) select id from claimed`,
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
					return { _tag: 'Replay' as const, outcome };
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
				return {
					_tag: 'InProgress' as const,
					retryAfterSeconds:
						isNumber(retryAfter) && Number.isInteger(retryAfter) && retryAfter > 0 ? retryAfter : 1
				};
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
			const lookupBrowserMutations = Effect.fn('Collections.lookupBrowserMutations')(function* (
				effectId: EffectId,
				actor: Identity.Subject,
				subject: Identity.Subject,
				impersonatedTeam: string | null,
				ids: ReadonlyArray<CollectionMutationIdempotencyKey>
			) {
				if (ids.length === 0) return [] as ReadonlyArray<SyncOutcome>;
				const scope = browserMutationScopeFor(actor, subject, impersonatedTeam);
				const result = yield* database.execute(effectId, {
					_tag: 'Query',
					// repository-health:allow SQL1 -- fixed private ledger; every scope coordinate stays bound.
					sql: `select idempotency_key, outcome from ${BROWSER_MUTATION_TABLE} where tenant_id = $1 and environment = $2 and principal_id = $3 and authority_id = $4 and command = $5 and status = 'terminal' and idempotency_key = any($6::text[])`,
					parameters: [
						scope.tenantId,
						scope.environment,
						scope.principalId,
						scope.authorityId,
						'collections.write',
						[...new Set(ids)]
					]
				});
				const rows = yield* Schema.decodeUnknownEffect(
					Schema.Array(
						Schema.Struct({
							idempotency_key: Schema.NonEmptyString,
							outcome: BrowserMutationOutcome
						})
					)
				)(result.rows).pipe(
					Effect.mapError(
						() =>
							new Database.FacilityError({
								operation: 'collections.lookupBrowserMutations',
								code: 'malformed_response',
								message: 'The browser mutation ledger returned a malformed terminal outcome.',
								retryable: false,
								outcome: 'known'
							})
					)
				);
				const found = new Map(rows.map((row) => [row.idempotency_key, row.outcome]));
				return ids.flatMap((id) => {
					const outcome = found.get(id);
					return outcome === undefined
						? []
						: [{ id, status: projectBrowserMutationOutcome(id, outcome).sync }];
				});
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
											outcome.message.trim() !== ''
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
					(!isNumber(currentVersion) || !Number.isInteger(currentVersion) || currentVersion < 1)
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
					`with completed as (update ${BROWSER_MUTATION_TABLE} set status = 'terminal', outcome = $8::jsonb, lease_expires_at = null where tenant_id = $1 and environment = $2 and principal_id = $3 and authority_id = $4 and command = $5 and idempotency_key = $6 and request_digest = $7 and status = 'running' returning id) select bolt_assert(exists(select 1 from completed), $${messageIndex})`,
					parameters
				);
			};
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
			/** Settles a held approval after its guard has locked the original durable answer. */
			const browserMutationApprovalTerminalStatement = (
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
				// repository-health:allow SQL1 -- fixed private ledger and function; every identity value is bound.
				return transactionSql(
					`with completed as (update ${BROWSER_MUTATION_TABLE} set status = 'terminal', outcome = $8::jsonb, lease_expires_at = null where tenant_id = $1 and environment = $2 and principal_id = $3 and authority_id = $4 and command = $5 and idempotency_key = $6 and request_digest = $7 and status = 'terminal' and outcome @> $9::jsonb returning id) select bolt_assert(exists(select 1 from completed), $${messageIndex})`,
					parameters
				);
			};
			const queryTables = new Map<string, ReturnType<typeof collectionQueryTable>>();
			/**
			 * Every query table a collection with a declared embedding gets, carrying that column.
			 *
			 * `definition.fields` holds authored columns, and `record_embedding` is not one — the
			 * platform renders it. Augmenting here rather than at each of the nine call sites means one
			 * decision rather than nine, and the cache stays keyed by collection name because the
			 * augmentation is a function of the declaration, not of the caller.
			 *
			 * Typed as JSON carrying its own `sqlType`, like authored vectors: the public value is a
			 * number array, while `vector(n)` is what the database is told. The query descriptor itself
			 * remains query-only text; `decodeReferenceRow` restores pgvector's text wire value.
			 */
			const queryFieldsFor = (
				name: string,
				fields: Readonly<Record<string, FieldDefinition>>
			): Readonly<Record<string, FieldDefinition>> => {
				const declared = workspace.definition.collections.find(
					(collection) => collection.name === name
				)?.embedding;
				if (declared === undefined) return fields;
				return {
					...fields,
					[RECORD_EMBEDDING_COLUMN]: {
						type: 'json',
						required: false,
						indexed: true,
						sqlType: `vector(${declared.dimensions ?? DEFAULT_RECORD_EMBEDDING_DIMENSIONS})`
					}
				};
			};
			const queryTableFor = (
				name: string,
				fields: Readonly<Record<string, FieldDefinition>>
			): ReturnType<typeof collectionQueryTable> => {
				const existing = queryTables.get(name);
				if (existing !== undefined) return existing;
				const table = collectionQueryTable(name, queryFieldsFor(name, fields));
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
			const relational = drizzle(refuseExecution, { relations: workspaceRelations });
			/**
			 * The relational query builder for one collection, once the workspace has declared it.
			 *
			 * Opaque because the workspace is: Drizzle types `db.query` from a relations map known at
			 * compile time, and this one is derived from the artifact at layer construction.
			 */
			const relationalBuilders = relational.query as unknown as Readonly<
				Record<string, RelationalBuilder | undefined>
			>;
			/**
			 * What a write owes the outside world, committed in the write's own transaction (§4.3):
			 * the channel messages its collection's outbound rules fire, and a push marker for each
			 * two-way sync over it. A post-commit enqueue has a window where the row exists and the
			 * intent to tell anybody does not; committing them together closes it.
			 */
			const OUTBOX_COLUMNS = [
				'id',
				'channel',
				'transport',
				'message',
				'source_collection',
				'source_record_id',
				'rule',
				'thread_key',
				'status',
				'last_error'
			] as const;
			/** The follow-up task a write's outbound work needs, keyed so a batch says it once. */
			type Follow = Readonly<{ readonly command: string; readonly input: Schema.Json; readonly key: string }>;
			const writesOutward = (collection: string): boolean =>
				workspace.definition.channels.some(({ outbound }) =>
					outbound.some(({ from }) => from === collection)
				) ||
				workspace.definition.integrations.some(({ syncs }) =>
					syncs.some((sync) => sync.collection === collection && sync.direction === 'two_way')
				);
			const outwardRows = (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				id: string,
				operation: 'create' | 'update' | 'delete',
				values: Readonly<Record<string, Schema.Json>>,
				previous: Readonly<Record<string, unknown>> | undefined
			): Readonly<{ readonly bookkeeping: ReadonlyArray<PlannedInsert>; readonly follows: ReadonlyArray<Follow> }> => {
				if (!writesOutward(collection)) return { bookkeeping: [], follows: [] };
				const record =
					operation === 'delete' ? { ...(previous ?? {}), id } : { ...(previous ?? {}), ...values, id };
				const messages = outboundRows(
					workspace.definition.channels,
					authored.channels,
					collection,
					operation,
					record,
					operation === 'create' ? undefined : previous
				);
				const syncs = workspace.definition.integrations.flatMap((integration) =>
					integration.syncs
						.filter(
							(sync) =>
								sync.collection === collection &&
								sync.direction === 'two_way' &&
								subject.userId !== `integration:${integration.name}`
						)
						.map((sync) => ({ integration: integration.name, sync: sync.name }))
				);
				return {
					bookkeeping: [
						...messages.map(
							(row): PlannedInsert => ({
								table: 'bolt_channel_outbox',
								columns: OUTBOX_COLUMNS,
								values: [
									deriveRecordId(`${effectId}:${row.channel}:${row.rule}:${id}`),
									row.channel,
									row.transport,
									(row.message ?? null) as Schema.Json,
									collection,
									id,
									row.rule,
									row.thread,
									row.error === null ? 'pending' : 'failed',
									row.error
								],
								onConflict: 'on conflict (id) do nothing'
							})
						),
						...syncs.map(
									({ integration, sync }): PlannedInsert => ({
										table: 'bolt_integration_pushes',
										columns: ['id', 'sync', 'record_id'],
										values: [deriveRecordId(`${integration}.${sync}:${id}`), `${integration}.${sync}`, id],
										onConflict:
											"on conflict (sync, record_id) do update set revision = bolt_integration_pushes.revision + 1, status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now()"
									})
								)
					],
					follows: [
						...messages
							.filter(({ error }) => error === null)
							.map(({ channel }) => ({ command: 'channels.drain', input: { channel }, key: `channels.drain:${channel}` })),
						...syncs.map(({ integration, sync }) => ({
							command: 'integrations.push',
							input: { integration, sync },
							key: `integrations.push:${integration}.${sync}`
						}))
					]
				};
			};
			const HISTORY_COLUMNS = [
				'collection_name',
				'record_id',
				'operation',
				'subject_id',
				'effect_id',
				'approval_id',
				'snapshot'
			] as const;
			/**
			 * The tasks that carry a write's outbound work, in this same transaction: one per channel
			 * and per sync per batch, keyed `<effectId>:<key>` so a batch of many rows says it once.
			 */
			const followRows = (effectId: EffectId, follows: ReadonlyArray<Follow>): ReadonlyArray<PlannedInsert> =>
				[...new Map(follows.map((follow) => [follow.key, follow])).values()]
					.toSorted((left, right) => left.key.localeCompare(right.key))
					.map((follow) => ({
						table: 'bolt_task',
						columns: ['command', 'input', 'effect_id', 'status'],
						values: [follow.command, follow.input, `${effectId}:${follow.key}`, 'pending'],
						onConflict: 'on conflict (effect_id) do nothing'
					}));

			/**
			 * Tells the host to come back now, because this write is about to queue outbound work. Sent
			 * *before* the commit: a crash between costs a false alarm, never a delivery nobody returns for.
			 */
			const announceOutward = Effect.fn('Collections.announceOutward')(function* (
				effectId: EffectId,
				collection: string
			) {
				if (!writesOutward(collection)) return;
				yield* queue.wake(EffectId.make(`${effectId}:wake`), yield* Clock.currentTimeMillis);
			});
			const embeddingPorts = {
				database,
				ai,
				collections: workspace.definition.collections
			};
			/** The collections layer's own ports, late-bound so the layer can build itself. */
			const authoringPorts: AuthoringPorts<Database.FacilityError> = {
				allowedCollections: authoringCollectionNames,
				get findMany() {
					return findMany;
				},
				get count() {
					return count;
				},
				get findNearest() {
					return findNearest;
				},
				get history() {
					return history;
				},
				get write() {
					return write;
				},
				get startAutomation() {
					return startAutomation;
				},
				infer: (input) =>
					Effect.die(
						new Error(`api.infer needs an invocation: ${JSON.stringify(input).slice(0, 40)}`)
					),
				readFileAsset: (file) => readFileAsset(EffectId.make('unbound'), files, file),
				embed: (effectId, input) =>
					embedRecordsSummary(
						{
							embedRecords: (id, options) => embedRecordsService(embeddingPorts, id, options)
						},
						effectId,
						input
					)
			};
			const portsFor = (
				effectId: EffectId,
				subject: Identity.Subject
			): AuthoringPorts<Database.FacilityError> => ({
				...authoringPorts,
				infer: inferOp(effectId, ai, { effectId, subject, hostTools }),
				readFileAsset: (file) => readFileAsset(effectId, files, file)
			});
			const authoringApi = (
				effectId: EffectId,
				subject: Identity.Subject,
				automation?: AutomationContinuation
			) =>
				makeAuthoringApi(
					makeAuthoringOps(portsFor(effectId, subject), effectId, subject, automation)
				);
			const authoringReadOps = (effectId: EffectId, subject: Identity.Subject) =>
				makeAuthoringReadOps(authoringPorts, effectId, subject);

			const AutomationExecutionInput = Schema.Struct({
				args: Schema.Json,
				scope: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
				bolt_run_as: Subject,
				bolt_depth: Schema.optionalKey(
					Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
				)
			});
			const runAutomationBody: (
				name: string,
				taskId: string,
				raw: Schema.Json,
				attemptEffectId: string
			) => Effect.Effect<
				Schema.Json,
				| QueryError
				| BatchMutationError
				| Schema.SchemaError
				| Database.FacilityError
				| Automations.AutomationStopped
				| Automations.AutomationDeferredUnsupported
				| Automations.AutomationContinuationUnchanged
			> = Effect.fn('Collections.runAutomationBody')(
				function* (name, taskId, raw, attemptEffectId) {
					const declaration = authored.automations[name];
					if (declaration === undefined) {
						return yield* new AuthoredRefusal({ message: `Automation ${name} is not declared.` });
					}
					const admitted = yield* Schema.decodeUnknownEffect(AutomationExecutionInput)(raw);
					const turnEffectId = EffectId.make(attemptEffectId);
					const guard = Automations.stoppageGuard(automations, turnEffectId, taskId);
					const readUrl = webReader(turnEffectId, connector);
					const get = connectionReader(turnEffectId, declaration.connection, connector);
					const channelOps = automationChannels(
						database,
						queue,
						workspace.definition.channels,
						workspace.definition.integrations,
						turnEffectId
					);
					const notify = (notification: NotifyInput) =>
						guard('notify').pipe(Effect.andThen(channelOps.notify(notification)));
					const channels = Object.fromEntries(
						Object.entries(channelOps.channels).map(([name, channel]) => [
							name,
							{
								send: (message: unknown) =>
									guard('channels.send').pipe(Effect.andThen(channel.send(message)))
							}
						])
					);
					const api = makeAutomationApi(
						makeAuthoringApi(
							guardAuthoringOps(
								makeAuthoringOps(
									portsFor(turnEffectId, admitted.bolt_run_as),
									turnEffectId,
									admitted.bolt_run_as,
									{ name, args: admitted.args, depth: admitted.bolt_depth ?? 0 }
								),
								guard
							)
						),
						(value) =>
							guard('progress').pipe(
								Effect.andThen(Schema.decodeUnknownEffect(AutomationProgression)(value)),
								Effect.flatMap((progression) =>
									automations.progress(turnEffectId, taskId, progression)
								)
							),
						(url) => guard('web.read').pipe(Effect.andThen(readUrl(url))),
						taskId,
						{
							get: (input) =>
								guard('connection.get').pipe(
									Effect.andThen(get(input)),
									Effect.provideService(Secrets.Service, secrets)
								)
						},
						notify,
						channels,
						Object.fromEntries(
							Object.entries(channelOps.integrations).map(([integration, operations]) => [
								integration,
								{
									reconcile: () =>
										guard('integrations.reconcile').pipe(Effect.andThen(operations.reconcile()))
								}
							])
						)
					);
					const args = yield* Schema.decodeUnknownEffect(declaration.input ?? Schema.Json)(
						admitted.args
					);
					const output = yield* runAuthoredHandler(() =>
						declaration.handler(api, { args, scope: admitted.scope ?? {} })
					);
					return yield* Schema.decodeUnknownEffect(declaration.output ?? Schema.Unknown)(
						output
					).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)));
				}
			);
			/**
			 * Admits and immediately executes one automation unless the caller explicitly supplied a delay.
			 * The durable row is lifecycle/input state; this Effect remains the sole owner of the body.
			 */
			const startAutomation: (
				effectId: EffectId,
				name: string,
				input: Schema.Json,
				scope: Readonly<Record<string, Schema.Json>>,
				options?: Readonly<{
					readonly after?: string | number;
					readonly taskId?: string;
					readonly parentDepth?: number;
					readonly continuationOf?: AutomationContinuation;
				}>
			) => Effect.Effect<
				{ readonly taskId: string },
				| QueryError
				| BatchMutationError
				| Schema.SchemaError
				| Automations.AutomationStopped
				| Automations.AutomationDeferredUnsupported
				| Automations.AutomationContinuationUnchanged
			> = Effect.fn('Collections.startAutomation')(
				function* (effectId, name, input, scope, options) {
					const afterMillis = afterMillisOf(options?.after);
					if (afterMillis === undefined) {
						return yield* new AuthoredRefusal({
							message: `"${String(options?.after)}" is not a delay ${name} can wait — pass milliseconds, '5 seconds', '1 hour', or another Effect duration.`
						});
					}
					const taskId = yield* automations.start(effectId, name, input, {
						afterMillis,
						scope,
						...(options?.taskId === undefined ? {} : { taskId: options.taskId }),
						...(options?.parentDepth === undefined ? {} : { parentDepth: options.parentDepth }),
						...(options?.continuationOf === undefined
							? {}
							: { continuationOf: options.continuationOf })
					});
					if (afterMillis > 0) return { taskId };
					yield* automations.execute(
						EffectId.make(`${effectId}:execute`),
						name,
						taskId,
						(raw, attemptEffectId) => runAutomationBody(name, taskId, raw, attemptEffectId)
					);
					return { taskId };
				}
			);
			const changeEventPorts = {
				automations,
				authored: authored.automations,
				runBody: runAutomationBody
			};
			/** The subject-bound facts a `with` clause is planned against. */
			const planContextFor = (
				subject: Identity.Subject,
				policy: AccessControl.Invocation
			): PlanContext => ({
				definition: workspace.definition,
				relations: workspaceRelations,
				authorize: (collection: string) => policy.authorize(subject, 'read', collection),
				predicate: (collection: string) => policy.predicate(subject, 'read', collection)
			});
			/** A field mask, bound to this subject and applied against each level's own collection. */
			const maskFor =
				(subject: Identity.Subject, policy: AccessControl.Invocation): MaskRow =>
				(collection, row) =>
					policy.mask(subject, 'read', collection, row);
			/**
			 * Runtime branch point for search — the one implementation, wired to the read path.
			 *
			 * `read/search.ts` owns the whole decision (lexical for any string, including one that
			 * begins with `>`; the embedder reached only by the structurally distinct semantic command),
			 * and this boundary owns only what the guest runtime must add: the context from the live
			 * definition, the Embed call as the callback `prepareSearchPlan` awaits, and the mapping of
			 * a search-compile failure onto the read path's `WhereCompileError` refusal. An inline copy
			 * of that decision used to live here and drift was only a matter of time.
			 */
			const searchPlan = Effect.fn('Collections.searchPlan')(function* (
				effectId: EffectId,
				definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
				input: SearchInput,
				qualifier: string
			) {
				const context: SearchContext = {
					collection: definition.name,
					fields: definition.fields,
					qualifier,
					...(definition.search?.documentColumn === SEARCH_DOCUMENT_COLUMN
						? { searchDocumentColumn: SEARCH_DOCUMENT_COLUMN }
						: {}),
					...(definition.embedding === undefined
						? {}
						: { embeddingColumn: definition.embedding.vectorColumn })
				};
				const refusal = (failure: { readonly field: string; readonly message: string }) =>
					new WhereCompileError({
						collection: definition.name,
						field: failure.field,
						message: failure.message
					});
				// The guest's one Embed capability, handed to the pure planner as the async callback it
				// asks for; exactly one model call per explicit semantic request, none for any string.
				const embed = (term: string): Promise<ReadonlyArray<number>> =>
					Effect.runPromise(
						Effect.gen(function* () {
							const embedding = definition.embedding;
							if (embedding?.model === undefined) {
								return yield* Effect.fail(
									refusal({
										field: 'search',
										message: `Collection '${definition.name}' requires an explicit embedding model for semantic search.`
									})
								);
							}
							const callScope = `${effectId}:semantic-query`;
							const response = yield* ai.embed(
								EffectId.make(callScope),
								AIRequest.cases.Embed.make({
									callId: ProviderCallId.make(callScope),
									modelId: ModelId.make(embedding.model),
									inputs: [{ text: term }],
									...(embedding.dimensions === undefined
										? {}
										: { dimensions: embedding.dimensions })
								})
							);
							const vector = response.embeddings[0];
							if (vector === undefined || vector.length === 0) {
								return yield* Effect.fail(
									refusal({
										field: 'search.probe',
										message: 'The embedder returned no vector probe.'
									})
								);
							}
							return vector;
						})
					);
				/**
				 * A declared similarity index: the descriptor lives in the definition (column, metric),
				 * the embedder in the live module. The probe is the module's own `target`, so the browser
				 * never states a vector — only the index's capture form.
				 */
				const nearest = (
					index: string,
					target: Readonly<Record<string, unknown>>
				): Promise<NearestProbe> =>
					Effect.runPromise(
						Effect.gen(function* () {
							const declared = definition.write?.similarity?.find(
								(candidate) => candidate.name === index
							);
							const live = declaredModuleOf(definition.name)?.similarity?.[index];
							if (declared === undefined || live === undefined) {
								return yield* Effect.fail(
									refusal({
										field: 'search.index',
										message: `Collection '${definition.name}' declares no similarity index '${index}'.`
									})
								);
							}
							const answer = yield* Effect.try({
								try: () => live.target(target),
								catch: (cause) =>
									refusal({
										field: 'search.target',
										message: cause instanceof Error ? cause.message : String(cause)
									})
							});
							const aimed = answer as {
								readonly column?: string;
								readonly probe: ReadonlyArray<number>;
								readonly where?: Readonly<Record<string, string | number | boolean | null>>;
							};
							const column = aimed.column ?? declared.column;
							if (!Object.hasOwn(definition.fields, column))
								return yield* Effect.fail(
									refusal({
										field: 'search.target',
										message: `Index '${index}' measures against '${column}', which is not a column of ${definition.name}.`
									})
								);
							for (const name of Object.keys(aimed.where ?? {}))
								if (!Object.hasOwn(definition.fields, name))
									return yield* Effect.fail(
										refusal({
											field: 'search.target',
											message: `Index '${index}' narrows by '${name}', which is not a column of ${definition.name}.`
										})
									);
							return {
								column,
								operator: NEAREST_OPERATORS[declared.metric],
								probe: aimed.probe,
								...(aimed.where === undefined ? {} : { where: aimed.where })
							};
						})
					);
				const planned = yield* Effect.tryPromise({
					try: () => prepareSearchPlan(input, context, embed, nearest),
					catch: toError
				}).pipe(
					Effect.mapError((cause) =>
						cause instanceof WhereCompileError
							? cause
							: refusal({ field: 'search', message: cause.message })
					)
				);
				return Result.isFailure(planned)
					? yield* Effect.fail(refusal(planned.failure))
					: planned.success;
			});
			/**
			 * The common authoritative read preparation. Query forms differ only after this point: a page
			 * adds seeking, a count aggregates, and grouping keeps the unmasked lane source. Keeping the
			 * definition, policy, narrowing, search, and visibility facts together makes each form execute
			 * the same read surface.
			 */
			const prepareRead = Effect.fn('Collections.prepareRead')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				input: QueryInput,
				qualifier: string,
				afterAuthorization?: () => WhereCompileError | undefined
			) {
				const definition = yield* workspace.collection(input.collection);
				const policy = access.invocation();
				const readAccess = yield* policy.read(subject, input.collection);
				const refusal = afterAuthorization?.();
				if (refusal !== undefined) return yield* refusal;
				return {
					definition,
					policy,
					compiled: yield* compiledFilter(input, workspace.definition, qualifier),
					searched: yield* searchPlan(
						EffectId.make(`${effectId}:search`),
						definition,
						input.search,
						qualifier
					),
					visibility: readAccess.predicate
				};
			});
			/**
			 * One relational read: the rows, and every relation the caller asked for, in one statement.
			 *
			 * Every level's row-visibility predicate is pushed into that level's own lateral subquery, so
			 * a related record is filtered by exactly the predicate a direct read of its collection would
			 * carry. `with` cannot become a way to read rows the subject could not otherwise see, and it
			 * no longer costs a query per relation per level to say so.
			 */
			const readRelational = (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				policy: AccessControl.Invocation,
				config: Readonly<{
					readonly where: SQL;
					readonly ordering: ReadonlyArray<OrderTerm>;
					readonly searchOrdering?: SQL | undefined;
					readonly limit: number;
					readonly with: unknown;
					readonly columns?: Readonly<Record<string, boolean>> | undefined;
				}>
			) =>
				readRelationalService(
					{
						builders: relationalBuilders,
						planContext: planContextFor(subject, policy),
						mask: maskFor(subject, policy),
						execute: (statement) =>
							observedRead(effectId, database, statement).pipe(Effect.map((result) => result.rows))
					},
					collection,
					config
				);
			const findMany: Interface['findMany'] = Effect.fn('Collections.findMany')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				input: QueryInput
			) {
				const { definition, policy, compiled, searched, visibility } = yield* prepareRead(
					effectId,
					subject,
					input,
					ROOT_ALIAS
				);
				if (input.after !== undefined && searched.mode !== 'none')
					return yield* new WhereCompileError({
						collection: input.collection,
						field: 'after',
						message:
							'Ranked search pagination requires a cursor carrying the lexical rank or semantic distance.'
					});
				const ordering = compileOrderTerms(workspace.definition, input.collection, input.orderBy);
				const seekResult = compileCollectionCursorSeek(
					input.after,
					ordering,
					input.collection,
					ROOT_ALIAS
				);
				const seek = Result.isFailure(seekResult)
					? yield* Effect.fail(seekResult.failure)
					: seekResult.success;
				const read = yield* readRelational(effectId, subject, input.collection, policy, {
					where:
						and(
							compiled,
							searched.predicate,
							AccessControl.predicateExpression(visibility, { qualifier: ROOT_ALIAS }),
							seek
						) ?? always(),
					ordering,
					searchOrdering:
						searched.mode === 'lexical'
							? desc(searched.rank)
							: searched.mode === 'semantic' || searched.mode === 'nearest'
								? asc(searched.distance)
								: undefined,
					limit: Math.max(1, input.limit ?? 100),
					with: input.with,
					// The ranked column must come back with the row: the distance beside it is measured from it.
					columns:
						searched.mode === 'nearest' && input.columns !== undefined
							? { ...input.columns, [searched.column]: true }
							: input.columns
				});
				if (searched.mode !== 'nearest') return read.rows;
				return withSearchDistance(definition.name, searched, read.rows) as typeof read.rows;
			});
			/**
			 * The distance a nearest search ranked each row by, attached beside the row.
			 *
			 * The index answered the order; the number is measured here from the row's own vector, or
			 * by the index's `rerank` when it declares one — the exact measure over the page the index
			 * returned as candidates, which then re-sorts the page. Either way the row reports one
			 * number under `search_distance`, and the browser shows that.
			 */
			const withSearchDistance = (
				collection: string,
				searched: Readonly<{
					readonly index: string;
					readonly column: string;
					readonly probe: ReadonlyArray<number>;
					readonly target: Readonly<Record<string, unknown>>;
				}>,
				rows: ReadonlyArray<Readonly<Record<string, unknown>>>
			): ReadonlyArray<Readonly<Record<string, unknown>>> => {
				const live = declaredModuleOf(collection)?.similarity?.[searched.index];
				const declared = workspace.definition.collections
					.find((candidate) => candidate.name === collection)
					?.write?.similarity?.find((candidate) => candidate.name === searched.index);
				const metric = declared?.metric ?? 'l2';
				const measure = (row: Readonly<Record<string, unknown>>): number => {
					if (live?.rerank !== undefined) return live.rerank(searched.target, row as never);
					const vector = row[searched.column];
					if (!Array.isArray(vector) || vector.length !== searched.probe.length) return Number.NaN;
					const stored = vector.map(Number);
					if (metric === 'l2')
						return Math.sqrt(
							stored.reduce((sum, value, i) => sum + (value - searched.probe[i]!) ** 2, 0)
						);
					const dot = stored.reduce((sum, value, i) => sum + value * searched.probe[i]!, 0);
					if (metric === 'ip') return -dot;
					const norm = (values: ReadonlyArray<number>) =>
						Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
					const denominator = norm(stored) * norm(searched.probe);
					return denominator === 0 ? Number.NaN : 1 - dot / denominator;
				};
				const measured: ReadonlyArray<Readonly<Record<string, unknown>>> = rows.map((row) => ({
					...row,
					[SEARCH_DISTANCE_COLUMN]: measure(row)
				}));
				return live?.rerank === undefined
					? measured
					: measured.toSorted(
							(left, right) =>
								Number(left[SEARCH_DISTANCE_COLUMN]) - Number(right[SEARCH_DISTANCE_COLUMN])
						);
			};
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
			const findNearest: Interface['findNearest'] = Effect.fn('Collections.findNearest')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				input: NearestQueryInput
			) {
				const definition = yield* workspace.collection(input.collection);
				const policy = access.invocation();
				const readAccess = yield* policy.read(subject, input.collection);
				const refuse = (field: string, message: string) =>
					new WhereCompileError({ collection: input.collection, field, message });
				const column = input.column;
				/**
				 * The platform's own record embedding is addressable, when the collection declares one.
				 *
				 * It is not an authored field — nothing declares it in `defineModel`'s columns — so the
				 * ordinary check would refuse the one column the feature exists to search. Gated on the
				 * declaration rather than on the name alone, so a collection without an embedding still
				 * refuses it, and with the message it would have given for any other unknown column.
				 */
				const searchesRecordEmbedding =
					column === RECORD_EMBEDDING_COLUMN && definition.embedding !== undefined;
				if (!Object.hasOwn(definition.fields, column) && !searchesRecordEmbedding) {
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
				if (input.probe.length === 0 || !input.probe.every((entry) => isFiniteNumber(entry))) {
					return yield* refuse(
						'probe',
						"probe must be a non-empty array of finite numbers with the column's dimension."
					);
				}
				if (input.maxDistance !== undefined && !Number.isFinite(input.maxDistance)) {
					return yield* refuse('maxDistance', 'maxDistance must be a finite number.');
				}
				const compiled = yield* compiledFilter(input, workspace.definition);
				const visibility = readAccess.predicate;
				const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
				const table = queryTableFor(input.collection, definition.fields);
				const columns = columnsOf(table);
				const vectorColumn = columns[column]!;
				const distance = vectorDistance(vectorColumn, operator, input.probe);
				const result = yield* observedRead(
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
						...policy.mask(
							subject,
							'read',
							input.collection,
							decodeReferenceRow(record, definition.fields)
						),
						distance: isNumber(measured) ? measured : decodeNumber(measured ?? Number.NaN)
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
			const isVectorColumn = (
				definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
				column: string
			): boolean =>
				definition.fields[column]?.sqlType?.toLowerCase().startsWith('vector(') === true;
			const boundParameter = (
				definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
				column: string,
				value: Schema.Json
			): Schema.Json => {
				if (Array.isArray(value)) {
					if (isVectorColumn(definition, column) || isJsonColumn(definition, column)) {
						return JSON.stringify(value);
					}
				}
				if (isJsonColumn(definition, column) && isJsonObject(value)) {
					return JSON.stringify(value);
				}
				return value;
			};
			const boundPlaceholder = (
				definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
				column: string,
				value: Schema.Json,
				position: number
			): string => {
				if (Array.isArray(value)) {
					if (isVectorColumn(definition, column)) return `$${position}::vector`;
					if (isJsonColumn(definition, column)) return `$${position}::jsonb`;
				}
				if (isJsonColumn(definition, column) && isJsonObject(value)) {
					return `$${position}::jsonb`;
				}
				return `$${position}`;
			};

			/** One node of a batch create: the mutation, its authoring definition, the predicate that gates it, and the layer its flatten-graph position put it above. */
			type CreateStatementNode = Readonly<{
				readonly input: MutationInput;
				readonly effectId: EffectId;
				readonly definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>;
				readonly visibility: AccessControl.RowPredicate;
			}>;

			/**
			 * Every row a batch of creates writes, without a statement among them.
			 *
			 * The records, their history rows and their integration deliveries land together in the one
			 * statement the write becomes; this only states the rows. A record's bookkeeping names the
			 * record's own key as what it comes `after`, so a predicated record the predicate declines
			 * leaves no history row and no delivery behind — the piece that writes the record wrote
			 * nothing, and the bookkeeping is gated on that piece having written a row.
			 */
			const plannedCreates = (
				subject: Identity.Subject,
				nodes: ReadonlyArray<CreateStatementNode>,
				governingApprovalRequest?: string
			): Readonly<{
				readonly records: ReadonlyArray<PlannedInsert>;
				readonly bookkeeping: ReadonlyArray<PlannedInsert>;
				readonly follows: ReadonlyArray<Follow>;
			}> => {
				const records: Array<PlannedInsert> = [];
				const bookkeeping: Array<PlannedInsert> = [];
				const follows: Array<Follow> = [];
				for (const { input, effectId: nodeEffectId, definition, visibility } of nodes) {
					const values = encodeMutationValues(input.values, definition.fields);
					const writable = writableValues(values, definition);
					const entries = Object.entries(writable).sort(([left], [right]) =>
						left.localeCompare(right)
					);
					const columnValues: ReadonlyArray<readonly [string, Schema.Json]> = [
						['id', input.id],
						...entries.map(([name, value]) => [name, value] as const)
					];
					// A predicate that is literally `true` — the workspace's write, an administrator, a grant
					// with no `where` — filters nothing, so the row is written unconditionally and can share
					// a statement. Anything else keeps the `select … where` it has today, alone.
					const unconditional = AccessControl.predicateIsUnrestricted(visibility);
					const predicate = AccessControl.predicateStatement(visibility, {
						parameterOffset: columnValues.length
					});
					const key = `rec${records.length}`;
					records.push({
						table: input.collection,
						columns: columnValues.map(([name]) => name),
						values: columnValues.map(([, value]) => value),
						...(unconditional
							? {}
							: {
									key,
									where: {
										sql: predicate.sql,
										parameters: predicate.parameters,
										casts: columnValues.map(([name, value]) =>
											boundPlaceholder(definition, name, value, 0).replace('$0', '')
										),
										parameterValues: columnValues.map(([name, value]) =>
											boundParameter(definition, name, value)
										)
									}
								})
					});
					const after = unconditional ? {} : { after: key };
					if (definition.history)
						bookkeeping.push({
							table: 'bolt_collection_history',
							columns: HISTORY_COLUMNS,
							values: [
								input.collection,
								input.id,
								'create',
								subject.userId,
								nodeEffectId,
								governingApprovalRequest ?? null,
								values
							],
							...after
						});
					const outward = outwardRows(nodeEffectId, subject, input.collection, input.id, 'create', values, undefined);
					for (const row of outward.bookkeeping) bookkeeping.push({ ...row, ...after });
					follows.push(...outward.follows);
				}
				return { records, bookkeeping, follows };
			};
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
				return isNonEmptyString(held) ? held : null;
			};

			/** The version a prepared existing row was read at, from its graph-read snapshot. */
			const preparedVersion = (snapshot: string | undefined): number | undefined => {
				if (snapshot === undefined) return undefined;
				const version = (JSON.parse(snapshot) as Record<string, unknown>)['row_version'];
				return typeof version === 'number' ? version : undefined;
			};

			/** One update as the row a grouped statement is built from, beside its history and deliveries. */
			const plannedUpdate = (
				effectId: EffectId,
				subject: Identity.Subject,
				input: MutationInput,
				definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
				previous: Readonly<Record<string, unknown>> | undefined,
				rowVersion: number | undefined,
				holdRequest?: string
			): Readonly<{
				readonly row: PlannedUpdate | null;
				readonly bookkeeping: ReadonlyArray<PlannedInsert>;
				readonly follows: ReadonlyArray<Follow>;
			}> => {
				const values = encodeMutationValues(input.values, definition.fields);
				const writable = writableValues(values, definition);
				// A value the row already holds is not a change: it is not assigned, not versioned, not
				// revisioned and not published. A write that restates every value it names writes nothing.
				const entries = Object.entries(writable)
					.filter(
						([name, value]) =>
							previous === undefined ||
							!(name in previous) ||
							JSON.stringify(previous[name] ?? null) !== JSON.stringify(value ?? null)
					)
					.sort(([left], [right]) => left.localeCompare(right));
				if (entries.length === 0) return { row: null, bookkeeping: [], follows: [] };
				const row: PlannedUpdate = {
					table: input.collection,
					id: input.id,
					rowVersion,
					columns: entries.map(([name]) => name),
					values: entries.map(([, value]) => value)
				};
				const outward = outwardRows(effectId, subject, input.collection, input.id, 'update', values, previous);
				return {
					row,
					bookkeeping: [
						...(definition.history
							? [
									{
										table: 'bolt_collection_history',
										columns: HISTORY_COLUMNS,
										values: [
											input.collection,
											input.id,
											'update',
											subject.userId,
											effectId,
											holdRequest ?? governingRequest(previous),
											values
										]
									}
								]
							: []),
						...outward.bookkeeping
					],
					follows: outward.follows
				};
			};

			/** One delete as the row a grouped statement is built from, beside its history and deliveries. */
			const plannedDelete = (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				id: string,
				definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
				previous: Readonly<Record<string, unknown>> | undefined,
				rowVersion: number | undefined,
				holdRequest?: string
			): Readonly<{
				readonly row: PlannedDelete;
				readonly bookkeeping: ReadonlyArray<PlannedInsert>;
				readonly follows: ReadonlyArray<Follow>;
			}> => {
				const outward = outwardRows(effectId, subject, collection, id, 'delete', {}, previous);
				return {
					row: { table: collection, id, rowVersion },
					bookkeeping: [
						...(definition.history
							? [
									{
										table: 'bolt_collection_history',
										columns: HISTORY_COLUMNS,
										values: [
											collection,
											id,
											'delete',
											subject.userId,
											effectId,
											holdRequest ?? governingRequest(previous),
											// The row as it was, so a rejected delete has something to restore.
											deleteHistoryIdentity(previous) as Schema.Json
										]
									}
								]
							: []),
						...outward.bookkeeping
					],
					follows: outward.follows
				};
			};
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
				if (visibility.authorization !== undefined)
					yield* authorizeOne(effectId, subject, visibility.authorization, action, collection, context);
			});
			const authorizeOne = Effect.fn('Collections.authorizeOne')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				marker: Schema.Json,
				action: 'create' | 'update' | 'delete',
				collection: string,
				context: Readonly<Record<string, unknown>>
			) {
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
				const api = makePolicyDecisionApi(authoringReadOps(effectId, subject), subject);
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
				context: Readonly<Record<string, unknown>>
			) {
				const marker = visibility.approval;
				if (marker === undefined) return undefined;
				if (!isPolicyApprovalMarker(marker))
					return yield* policyDecisionFailure(action, collection, 'approval metadata is malformed');
				const route = authored.approvalFlows[marker.id];
				if (route === undefined)
					return yield* policyDecisionFailure(
						action,
						collection,
						`approval flow ${marker.id} has no live implementation`
					);
				const api = makePolicyDecisionApi(authoringReadOps(effectId, subject), subject);
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
			 * How deep one nested write may go.
			 *
			 * The write path's limit, stated once in `write/plan.ts`: hook-issued and relationship writes
			 * share one depth budget and one refusal. `relations` is a graph with cycles in it —
			 * `payroll_runs → payslips → payroll_runs` — so without a bound a returned graph that closed a
			 * loop would be walked until the isolate died. Refused during preparation, with nothing
			 * written, which is the whole advantage of doing this before the transaction rather than
			 * inside it.
			 */
			const graphRefusal = (
				collection: string,
				action: 'create' | 'update' | 'delete',
				message: string
			) => Effect.fail(new AuthoredRefusal({ collection, action, message }));

			type GraphWaveReadError = Database.FacilityError | Workspace.WorkspaceLookupError;
			const graphReadPorts = {
				execute: (readEffectId: EffectId, sql: string, parameters: ReadonlyArray<Schema.Json>) =>
					database
						.execute(readEffectId, { _tag: 'Query', sql, parameters })
						.pipe(Effect.map((result) => result.rows)),
				collectionFields: (collection: string) =>
					workspace.collection(collection).pipe(Effect.map((definition) => definition.fields)),
				decodeReferenceRow,
				isJsonObject,
				quoteIdentifier
			};
			const graphReads = makeGraphReader<GraphWaveReadError, never>(graphReadPorts);

			/**
			 * The one transaction that applies a plan: guards, deletes, updates, creates, history, the
			 * hold when policy routed the write to approval, the ledger claim, and the capture whose
			 * `returning` feeds sync routing (RFC §5.2).
			 *
			 * `hold` stamps every created and updated row with the request, writes one `hold` revision
			 * per row with its pre-image (absence for a create), and appends the request row when this
			 * write opens it; a participant's write under an open request carries only the request id.
			 */
			const applyDeclarativeGraph = Effect.fn('Collections.applyDeclarativeGraph')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				statementPlan: WriteStatementPlan,
				readSnapshots: ReadonlyArray<ReadSnapshot>,
				browserMutation: BrowserMutationFence | undefined,
				hold:
					| Readonly<{
							readonly requestId: string;
							readonly statement?: Readonly<{
								readonly sql: string;
								readonly parameters: ReadonlyArray<Schema.Json>;
							}>;
					  }>
					| undefined,
				bookkeeping: ReadonlyArray<{
					readonly sql: string;
					readonly parameters: ReadonlyArray<Schema.Json>;
				}>
			) {
				const operations = statementPlan.operations;
				const creates = operations.filter((operation) => operation.action === 'create');
				const createNodeFor = (operation: GraphPreparedOperation): CreateStatementNode => ({
					input: {
						collection: operation.collection,
						id: operation.id,
						values:
							hold === undefined
								? operation.values
								: { ...operation.values, approval_id: hold.requestId }
					},
					effectId: operation.taskScope,
					definition: operation.definition,
					visibility: AccessControl.unrestricted
				});
				for (const operation of operations) yield* announceOutward(effectId, operation.collection);
				/**
				 * Every sentence a policy guard in this statement may raise, and whose refusal it is.
				 *
				 * `bolt_assert` raises `serialization_failure` so that a *concurrency* guard can be safely
				 * rerun, and the policy predicate borrows the same function because a row can only be
				 * proven against the subject's predicate where the row is. Left as a database fault, a
				 * refusal this engine decided arrives at the browser-write classifier as none of the
				 * refusals it knows and settles as `quarantined` — "an unclassified failure" — for a
				 * sentence composed here on purpose, and advertises a deterministic policy answer as a
				 * transient conflict worth retrying. Only these sentences are translated back; the
				 * snapshot, relationship and ledger assertions keep the retryable code they exist for.
				 */
				const predicateGuards = new Map<
					string,
					Readonly<{ readonly collection: string; readonly action: 'create' | 'update' | 'delete' }>
				>();
				/**
				 * The pieces of the one statement, in the order they are written. Order is only
				 * legibility: every piece sees the snapshot the statement began with, and a piece that
				 * must observe what another wrote reads that piece's `returning` set by name.
				 */
				const pieces: Array<OneStatement.Piece> = [];
				const guardKeys = new Map<string, number>();
				const guard = (prefix: string, fragment: OneStatement.Fragment): void => {
					const ordinal = guardKeys.get(prefix) ?? 0;
					guardKeys.set(prefix, ordinal + 1);
					pieces.push({ key: `${prefix}${ordinal}`, fragment });
				};
				const beforeGuard = (expectation: PredicateAssertionExpectation) => {
					const operation = expectation.operation;
					const predicate = AccessControl.predicateStatement(operation.visibility, {
						parameterOffset: 1
					});
					const messageIndex = predicate.parameters.length + 2;
					const message = `${operation.collection} ${operation.id} is absent or outside the mutation predicate`;
					predicateGuards.set(message, {
						collection: operation.collection,
						action: operation.action
					});
					guard('policy', {
						sql: `select bolt_assert((select count(*) = 1 from (select id from ${quoteIdentifier(operation.collection)} where id = $1 and (${predicate.sql}) for update) as bolt_authorized_row), $${messageIndex})`,
						parameters: [operation.id, ...predicate.parameters, message]
					});
				};
				// The read-consistency lock cannot live in a `WITH`; it is the one statement before the write.
				const consistency = readConsistencyStatements(readSnapshots, statementPlan.collections);
				if (consistency.check !== undefined) guard('read', consistency.check);
				for (const expectation of statementPlan.before) {
					// An unrestricted predicate proves only that the row exists, and the version guard
					// inside the update or delete proves that already.
					if (AccessControl.predicateIsUnrestricted(expectation.operation.visibility)) continue;
					beforeGuard(expectation);
				}
				const plannedUpdates: Array<PlannedUpdate> = [];
				const plannedDeletes: Array<PlannedDelete> = [];
				const rowKey = (collection: string, id: string) => `${collection}\u0000${id}`;
				const untouched = new Map<string, Array<string>>();
				const untouchedIds = new Set<string>();
				const inserts: Array<PlannedInsert> = [];
				const follows: Array<Follow> = [];
				const holdRevision = (operation: GraphPreparedOperation): PlannedInsert | undefined =>
					hold === undefined || !operation.definition.history
						? undefined
						: {
								table: 'bolt_collection_history',
								columns: HISTORY_COLUMNS,
								values: [
									operation.collection,
									operation.id,
									'hold',
									subject.userId,
									operation.taskScope,
									hold.requestId,
									operation.previous === undefined
										? null
										: (JSON.parse(JSON.stringify(operation.previous)) as Schema.Json)
								]
							};
				const createIds = new Set(
					creates.map((operation) => rowKey(operation.collection, operation.id))
				);
				for (const operation of operations) {
					const revision = holdRevision(operation);
					if (revision !== undefined) inserts.push(revision);
					if (operation.action === 'delete') {
						// One snapshot for the whole statement: a delete and a create of the same row
						// would collide on the row the insert cannot see gone.
						if (createIds.has(rowKey(operation.collection, operation.id)))
							return yield* Effect.fail(
								new AuthoredRefusal({
									collection: operation.collection,
									action: 'delete',
									message: `${operation.collection} ${operation.id} is deleted and created in one write; submit them separately.`
								})
							);
						const planned = plannedDelete(
							operation.taskScope,
							subject,
							operation.collection,
							operation.id,
							operation.definition,
							operation.previous,
							preparedVersion(operation.snapshot),
							hold?.requestId
						);
						plannedDeletes.push(planned.row);
						inserts.push(...planned.bookkeeping);
						follows.push(...planned.follows);
					}
					if (operation.action === 'update') {
						const planned = plannedUpdate(
							operation.taskScope,
							subject,
							{
								collection: operation.collection,
								id: operation.id,
								values:
									hold === undefined
										? operation.values
										: { ...operation.values, approval_id: hold.requestId }
							},
							operation.definition,
							operation.previous,
							preparedVersion(operation.snapshot),
							hold?.requestId
						);
						if (planned.row !== null) plannedUpdates.push(planned.row);
						else {
							untouched.set(operation.collection, [
								...(untouched.get(operation.collection) ?? []),
								operation.id
							]);
							untouchedIds.add(rowKey(operation.collection, operation.id));
						}
						inserts.push(...planned.bookkeeping);
						follows.push(...planned.follows);
					}
				}
				const created = plannedCreates(subject, creates.map(createNodeFor), hold?.requestId);
				inserts.push(...created.records, ...created.bookkeeping);
				inserts.push(...followRows(effectId, [...follows, ...created.follows]));
				if (bookkeeping.length > 0) {
					// Notification rows carry their own drain tasks; the host is woken for them.
					yield* queue.wake(
						EffectId.make(`${effectId}:wake:deliver`),
						yield* Clock.currentTimeMillis
					);
				}
				const sources: Array<CaptureSource> = [
					...[...untouched.entries()].map(([collection, ids]) => ({ collection, ids }))
				];
				const changedWhilePrepared = (table: string, count: number) =>
					`${table}: ${count === 1 ? 'a row' : `${count} rows`} changed while its mutation graph was prepared`;
				// Deletes, updates and their guards: a row another writer moved fails its version match
				// inside the statement, and the count says so.
				for (const group of groupedDeletes(plannedDeletes)) {
					pieces.push({ key: group.key, fragment: group.fragment });
					guard('count', {
						sql: `select bolt_assert((select count(*) from ${OneStatement.cteName(group.key)}) = $1, $2)`,
						parameters: [group.rows.length, changedWhilePrepared(group.table, group.rows.length)]
					});
				}
				for (const group of groupedUpdates(plannedUpdates)) {
					pieces.push({ key: group.key, fragment: group.fragment });
					sources.push({ key: group.key, collection: group.table });
					guard('count', {
						sql: `select bolt_assert((select count(*) from ${OneStatement.cteName(group.key)}) = $1, $2)`,
						parameters: [group.rows.length, changedWhilePrepared(group.table, group.rows.length)]
					});
				}
				const recordKeys = new Map<string, string>();
				const createdCollections = new Set(creates.map((operation) => operation.collection));
				for (const group of groupedInserts(inserts)) {
					pieces.push({ key: group.key, fragment: group.fragment });
					if (createdCollections.has(group.table)) {
						sources.push({ key: group.key, collection: group.table });
						for (const row of group.rows)
							recordKeys.set(rowKey(group.table, String(row.values[0])), group.key);
					}
				}
				for (const expectation of statementPlan.after) {
					// An unrestricted after-insert only proves the row exists, and the capture guard
					// asserts that already. A restricted predicate is the write-authorization seam: it is
					// proven against the row the insert returned, since the table cannot show it yet.
					const operation = expectation.operation;
					if (AccessControl.predicateIsUnrestricted(operation.visibility)) continue;
					const key = recordKeys.get(rowKey(operation.collection, operation.id));
					if (key === undefined) continue;
					const predicate = AccessControl.predicateStatement(operation.visibility, {
						parameterOffset: 1,
						qualifier: 'written'
					});
					const messageIndex = predicate.parameters.length + 2;
					const message = `${operation.collection} ${operation.id} is outside the create predicate`;
					predicateGuards.set(message, { collection: operation.collection, action: 'create' });
					guard('policy', {
						sql: `select bolt_assert(exists(select 1 from ${OneStatement.cteName(key)} as written where written.id::text = $1 and (${predicate.sql})), $${messageIndex})`,
						parameters: [operation.id, ...predicate.parameters, message]
					});
				}
				// Updates, deletes and holds prune, which is where a history log can actually outgrow its
				// horizon; a create has one entry. The prune reads the log as it stood when the statement
				// began and is told how many revisions this statement appends, so the log is exactly at
				// its horizon when the statement commits.
				historyPruneStatements([
					...operations.filter(
						(operation) =>
							operation.action === 'delete' ||
							(operation.action === 'update' &&
								!untouchedIds.has(rowKey(operation.collection, operation.id)))
					),
					...(hold === undefined ? [] : operations)
				]).forEach((statement, index) =>
					pieces.push({ key: `prune${index}`, fragment: statement })
				);
				if (hold?.statement !== undefined) pieces.push({ key: 'hold', fragment: hold.statement });
				bookkeeping.forEach((statement, index) =>
					pieces.push({ key: `book${index}`, fragment: statement })
				);
				if (statementPlan.claimLedger && browserMutation !== undefined)
					pieces.push({ key: 'ledger', fragment: browserMutationClaimStatement(browserMutation) });
				const capturedOperations = operations.filter(
					(operation) => operation.action === 'create' || operation.action === 'update'
				);
				const statements = [
					...(consistency.lock === undefined ? [] : [consistency.lock]),
					OneStatement.oneStatement(pieces, captureFinal(capturedOperations, sources))
				];
				// One line per committed write: the write is one statement, and what the database took.
				// A plan that grows with the batch is the regression this runtime has had twice.
				const executionStartedAt = Date.now();
				const result = yield* database.execute(effectId, { _tag: 'Transaction', statements }).pipe(
					Effect.tap(() =>
						operations.length > 1
							? record('write', {
									collection: operations[0]?.collection ?? 'graph',
									rows: operations.length,
									statements: statements.length,
									pieces: pieces.length,
									ms: Date.now() - executionStartedAt,
									shapes: statementShapes(statements)
								})
							: Effect.void
					),
					Effect.catch((error): Effect.Effect<never, Database.FacilityError | AuthoredRefusal> => {
						if (error.message.includes(READ_CONFLICT_MESSAGE))
							return Effect.fail(new AuthoredRefusal({ message: READ_CONFLICT_MESSAGE }));
						for (const [message, site] of predicateGuards) {
							// `includes` rather than equality: the sentence is what a host binding reports,
							// and a binding is free to prefix it with its own context.
							if (error.message.includes(message))
								return Effect.fail(new AuthoredRefusal({ ...site, message }));
						}
						return Effect.fail(error);
					})
				);
				const records = new Map<string, Readonly<Record<string, unknown>>>();
				const capturedRows = new Map<string, Readonly<Record<string, Schema.Json>>>();
				for (const row of result.rows) {
					if (!isJsonObject(row)) continue;
					const ordinal = row['__bolt_graph_ordinal'];
					const record = row['__bolt_graph_record'];
					if (!isNumber(ordinal) || !isJsonObject(record)) continue;
					const operation = capturedOperations[ordinal];
					if (operation === undefined) continue;
					const key = `${operation.collection}\u0000${operation.id}`;
					capturedRows.set(key, record);
					records.set(
						key,
						decodeReferenceRow(record, operation.definition.fields) as Readonly<
							Record<string, unknown>
						>
					);
				}
				const snapshotRow = (
					operation: GraphPreparedOperation
				): Readonly<Record<string, unknown>> | undefined => {
					if (operation.snapshot === undefined) return operation.previous;
					try {
						const decoded: unknown = JSON.parse(operation.snapshot);
						return isJsonObject(decoded) ? decoded : operation.previous;
					} catch {
						/* best effort */
						return operation.previous;
					}
				};
				const changes = compactSyncChanges([
					...operations.flatMap((operation): ReadonlyArray<SyncChange> => {
						if (!writeOperationChangesRow(operation)) return [];
						const fields = captureFields.get(operation.collection) ?? new Set<string>();
						const key = `${operation.collection}\u0000${operation.id}`;
						const afterRow = capturedRows.get(key);
						const beforeRow = snapshotRow(operation);
						const mutationId = browserMutation?.idempotencyKey;
						const common = {
							collection: operation.collection,
							id: operation.id,
							...(mutationId === undefined ? {} : { mutationId })
						};
						if (operation.action === 'create')
							return afterRow === undefined
								? []
								: [
										{
											...common,
											operation: 'insert',
											after: projectLinkAndRouteValues(afterRow, fields)
										}
									];
						if (operation.action === 'delete')
							return [
								{
									...common,
									operation: 'delete',
									before: projectLinkAndRouteValues(beforeRow ?? {}, fields)
								}
							];
						return afterRow === undefined
							? []
							: [
									{
										...common,
										operation: 'update',
										before: projectLinkAndRouteValues(beforeRow ?? {}, fields),
										after: projectLinkAndRouteValues(afterRow, fields)
									}
								];
					})
				]);
				return { operations, records, batch: { changes } } satisfies AppliedDeclarativeGraph;
			});

			/**
			 * The write path (RFC §4.2–4.8).
			 *
			 * One declared input per operation, at most one transform, explicit relation actions. The
			 * lowering produces the `GraphPreparedOperation`s the graph engine commits, so history,
			 * audit, sync capture and the one-transaction guarantee are shared rather than reimplemented.
			 * A batch of groups is one commit: the runtime's own bookkeeping writes a conversation, its
			 * turn and its message together the same way a caller writes one collection.
			 */
			const declaredModuleOf = (collection: string): AuthoredCollectionModule | undefined =>
				authored.collections[collection] ?? systemCollectionModules[collection];

			const declaredRefusal = (
				collection: string,
				action: string,
				message: string
			): AuthoredRefusal => new AuthoredRefusal({ collection, action, message });

			const declaredRelationOf = (collection: string, name: string) =>
				resolveWritableManyRelation(workspace.definition, collection, name);

			type Selection = CollectionInputSelection;

			/** The caller's row predicate per collection and action, as `policy.write` decided it. */
			type SubmittedVisibility = Map<string, AccessControl.RowPredicate>;
			const visibilityKey = (collection: string, action: 'create' | 'update' | 'delete') =>
				`${collection}\u0000${action}`;

			/**
			 * Refuses anything the declared selection does not name, at every nesting level, and judges
			 * the caller on every row it submitted.
			 *
			 * Structural typing cannot prove the absence of extra properties, so this walk is the
			 * mandatory runtime half of the allowlist: an unselected field or an undeclared relation
			 * action fails the whole operation before the transform runs. Policy is checked here too,
			 * per nested action at its input path, so the caller is judged once, on the shape it
			 * submitted, before any authored code sees it.
			 */
			const admitSubmission = (
				effectId: EffectId,
				subject: Identity.Subject,
				definition: WorkspaceDefinition['collections'][number],
				action: 'create' | 'update',
				selection: Selection,
				submission: Readonly<Record<string, unknown>>,
				path: string,
				visibility: SubmittedVisibility,
				/** Seed origin may name a record's id; an ordinary caller never does. */
				allowId: boolean
			): Effect.Effect<
				void,
				AuthoredRefusal | Workspace.WorkspaceLookupError | AccessControl.AccessDenied
			> =>
				Effect.gen(function* () {
					const owned = syncOwnershipRefusal(
						workspace.definition.integrations,
						definition.name,
						subject.userId,
						action,
						Object.keys(submission).filter((key) => key !== 'id')
					);
					if (owned !== undefined)
						return yield* Effect.fail(declaredRefusal(definition.name, action, owned));
					const columns = selection.columns ?? {};
					const relations = selection.with ?? {};
					const own: Record<string, unknown> = {};
					for (const key of Object.keys(submission)) {
						if (key === 'id' && (action === 'update' || allowId)) continue;
						const value = submission[key];
						if (value === undefined) continue;
						if (key in columns) {
							own[key] = value;
							continue;
						}
						const relationSelection = relations[key];
						if (relationSelection === undefined)
							return yield* Effect.fail(
								declaredRefusal(
									definition.name,
									action,
									`${path}.${key} is not part of the declared ${action} input.`
								)
							);
						if (typeof value !== 'object' || value === null || Array.isArray(value))
							return yield* Effect.fail(
								declaredRefusal(
									definition.name,
									action,
									`${path}.${key} must be an object of relation actions.`
								)
							);
						const edge = declaredRelationOf(definition.name, key);
						if (edge === undefined)
							return yield* Effect.fail(
								declaredRefusal(
									definition.name,
									action,
									`${path}.${key} is not a writable relation of ${definition.name}.`
								)
							);
						const childDefinition = yield* workspace.collection(edge.childCollection);
						for (const [childAction, entries] of Object.entries(
							value as Readonly<Record<string, unknown>>
						)) {
							if (entries === undefined) continue;
							if (!(childAction in relationSelection))
								return yield* Effect.fail(
									declaredRefusal(
										edge.childCollection,
										action,
										`${path}.${key} does not accept ${childAction} actions.`
									)
								);
							const list = Array.isArray(entries) ? entries : [entries];
							if (childAction === 'delete') {
								const owned = syncOwnershipRefusal(
									workspace.definition.integrations,
									edge.childCollection,
									subject.userId,
									'delete',
									[]
								);
								if (owned !== undefined)
									return yield* Effect.fail(declaredRefusal(edge.childCollection, 'delete', owned));
								for (const entry of list)
									yield* judge(
										subject,
										'delete',
										edge.childCollection,
										isPlainRecord(entry) ? entry : {},
										visibility
									);
								continue;
							}
							if (childAction === 'link' || childAction === 'unlink') {
								// A link writes the child's foreign key and, when selected, its settlement
								// metadata: the caller is judged on exactly those columns.
								const settlement = relationSelection[childAction]?.columns ?? {};
								for (const entry of list) {
									const record = isPlainRecord(entry) ? entry : {};
									const set = isPlainRecord(record['set']) ? record['set'] : {};
									for (const field of Object.keys(set))
										if (!(field in settlement))
											return yield* Effect.fail(
												declaredRefusal(
													edge.childCollection,
													action,
													`${path}.${key}.${childAction}.set.${field} is not part of the declared ${childAction} selection.`
												)
											);
									yield* judge(
										subject,
										'update',
										edge.childCollection,
										{ [edge.childColumn]: null, ...set },
										visibility
									);
								}
								continue;
							}
							const childSelection =
								childAction === 'create'
									? relationSelection.create
									: childAction === 'update'
										? relationSelection.update
										: relationSelection.upsert;
							if (childSelection === undefined)
								return yield* Effect.fail(
									declaredRefusal(
										edge.childCollection,
										action,
										`${path}.${key} does not accept ${childAction} actions.`
									)
								);
							for (const entry of list) {
								if (!isPlainRecord(entry)) continue;
								const record = entry as Readonly<Record<string, unknown>>;
								const patch =
									childAction === 'upsert' && isPlainRecord(record['values'])
										? (record['values'] as Readonly<Record<string, unknown>>)
										: childAction === 'update' && isPlainRecord(record['set'])
											? (record['set'] as Readonly<Record<string, unknown>>)
											: record;
								yield* admitSubmission(
									effectId,
									subject,
									childDefinition,
									childAction === 'update' ? 'update' : 'create',
									childSelection,
									patch,
									`${path}.${key}.${childAction}`,
									visibility,
									allowId || childAction === 'upsert'
								);
								// An upsert's patch half is judged like any other patch.
								if (childAction === 'upsert' && isPlainRecord(record['onConflictDoUpdate']))
									yield* admitSubmission(
										effectId,
										subject,
										childDefinition,
										'update',
										childSelection,
										record['onConflictDoUpdate'] as Readonly<Record<string, unknown>>,
										`${path}.${key}.upsert.onConflictDoUpdate`,
										visibility,
										true
									);
							}
						}
					}
					if (action === 'create') {
						for (const field of Object.keys(columns)) {
							if (own[field] !== undefined) continue;
							const descriptor = definition.fields[field];
							if (descriptor === undefined) continue;
							if (
								descriptor.required === true &&
								descriptor.sqlDefault === undefined &&
								descriptor.generated === undefined
							)
								return yield* Effect.fail(
									declaredRefusal(
										definition.name,
										action,
										`${path}.${field} is required by the declared create input.`
									)
								);
						}
					}
					yield* judge(subject, action, definition.name, own, visibility);
				});

			/** One policy decision for one submitted row: allow, predicate, field grant. */
			const judge = (
				subject: Identity.Subject,
				action: 'create' | 'update' | 'delete',
				collection: string,
				row: Readonly<Record<string, unknown>>,
				visibility: SubmittedVisibility
			) =>
				Effect.gen(function* () {
					const plan = yield* access.invocation().write(subject, action, collection, row);
					if (!plan.predicate.allowed)
						return yield* policyDecisionFailure(action, collection, plan.predicate.reason);
					visibility.set(visibilityKey(collection, action), plan.predicate);
				});

			/** One read wave's stored rows for every id the payload names, keyed `collection\\0id`. */
			const namedRows = (
				effectId: EffectId,
				requests: ReadonlyArray<Readonly<{ readonly collection: string; readonly id: string }>>
			): Effect.Effect<
				Map<string, Readonly<{ readonly row: Readonly<Record<string, unknown>> }> | undefined>,
				GraphWaveReadError
			> =>
				requests.length === 0
					? Effect.succeed(new Map())
					: graphReads
							.read(EffectId.make(`${effectId}:named-rows`), requests, [])
							.pipe(Effect.map((read) => read.stored));

			/** Every `(collection, id)` a declared submission names, root and nested, upserts included. */
			const collectNamed = (
				target: string,
				value: unknown,
				into: Array<Readonly<{ readonly collection: string; readonly id: string }>>
			): void => {
				for (const entry of Array.isArray(value) ? value : [value]) {
					if (!isPlainRecord(entry)) continue;
					const record = entry as Readonly<Record<string, unknown>>;
					if (isNonEmptyString(record['id'])) into.push({ collection: target, id: record['id'] });
					for (const [key, nested] of Object.entries(record)) {
						const edge = declaredRelationOf(target, key);
						if (edge === undefined || !isPlainRecord(nested)) continue;
						for (const [childAction, actionValue] of Object.entries(
							nested as Readonly<Record<string, unknown>>
						)) {
							if (actionValue === undefined) continue;
							if (childAction === 'upsert') {
								for (const upsert of Array.isArray(actionValue) ? actionValue : [actionValue])
									if (isPlainRecord(upsert))
										collectNamed(edge.childCollection, upsert['values'], into);
								continue;
							}
							collectNamed(edge.childCollection, actionValue, into);
						}
					}
				}
			};

			/**
			 * The transform's read handle: the workspace's reads, two waves per operation.
			 *
			 * A wave opens on the first read issued after the previous one settled; a third fails the
			 * operation with a typed refusal instead of reaching the facility. Every read is recorded
			 * as a snapshot, so the commit asserts nothing it validated against has moved.
			 */
			const transformDb = (
				effectId: EffectId,
				subject: Identity.Subject,
				budget: { waves: number; inFlight: number },
				collection: string
			) => {
				const guard = <A, E, R>(
					read: Effect.Effect<A, E, R>
				): Effect.Effect<A, E | ReadBudgetExceeded, R> =>
					Effect.suspend((): Effect.Effect<A, E | ReadBudgetExceeded, R> => {
						if (budget.inFlight === 0) budget.waves += 1;
						if (budget.waves > TRANSFORM_READ_WAVES)
							return Effect.fail(
								new ReadBudgetExceeded({ collection, limit: TRANSFORM_READ_WAVES })
							);
						budget.inFlight += 1;
						return read.pipe(
							Effect.ensuring(
								Effect.sync(() => {
									budget.inFlight -= 1;
								})
							)
						);
					});
				// ponytail: the wave is counted, not composed; reads issued together inside one wave are
				// still one facility call each. Compose them into one JSON-aggregated statement when the
				// count in `[bolt-write]` says a transform's waves are what a network database pays for.
				const ops = authoringReadOps(effectId, workspaceSubject(subject));
				return makeTransformDb({
					allowedCollections: ops.allowedCollections,
					findMany: (target, input) => guard(ops.findMany(target, input)),
					findFirst: (target, input) => guard(ops.findFirst(target, input)),
					count: (target, input) => guard(ops.count(target, input)),
					findNearest: (target, input) => guard(ops.findNearest(target, input))
				});
			};

			/**
			 * The owned descendants a delete takes with it, read before the transaction (RFC §4.3), and
			 * the children it releases: a `setNull` edge's rows are updated explicitly, key cleared,
			 * rather than left to the database's `ON DELETE SET NULL` — an update the transaction did
			 * not name is one history, sync capture and change events never see, so a browser replica
			 * kept a released source pinned until it was reset.
			 */
			const cascadeDeletes = (
				effectId: EffectId,
				collection: string,
				row: Readonly<Record<string, unknown>>,
				depth: number,
				into: Array<GraphPreparedOperation>,
				taskScope: EffectId
			): Effect.Effect<void, AuthoredRefusal | GraphWaveReadError> =>
				Effect.gen(function* () {
					if (depth > WRITE_DEPTH_LIMIT)
						return yield* graphRefusal(
							collection,
							'delete',
							`A cascade on ${collection} is more than ${WRITE_DEPTH_LIMIT} levels deep.`
						);
					const id = String(row['id'] ?? '');
					const edges = workspace.definition.relations
						.filter((relation) => relation.source === collection && relation.cardinality === 'many')
						.flatMap((relation) => {
							const edge = declaredRelationOf(collection, relation.name);
							return edge !== undefined && (ownsManyRelation(edge) || releasesManyRelation(edge))
								? [edge]
								: [];
						});
					if (edges.length === 0) return;
					const read = yield* graphReads.read(
						EffectId.make(`${effectId}:cascade:${collection}:${id}:${depth}`),
						[],
						edges.map((edge) => ({ edge, parentId: id }))
					);
					for (const edge of edges) {
						const related = read.related.get(relatedRowsKey(edge, id));
						const definition = yield* workspace.collection(edge.childCollection);
						if (!ownsManyRelation(edge)) {
							for (const child of related?.rows ?? [])
								into.push({
									action: 'update',
									collection: edge.childCollection,
									id: String(child['id'] ?? ''),
									values: { [edge.childColumn]: null },
									definition,
									visibility: AccessControl.unrestricted,
									previous: child,
									snapshot: JSON.stringify(child),
									depth: depth + 1,
									taskScope
								});
							continue;
						}
						for (const child of related?.rows ?? []) {
							into.push({
								action: 'delete',
								collection: edge.childCollection,
								id: String(child['id'] ?? ''),
								values: {},
								definition,
								visibility: AccessControl.unrestricted,
								previous: child,
								snapshot: JSON.stringify(child),
								depth: depth + 1,
								taskScope
							});
							yield* cascadeDeletes(
								effectId,
								edge.childCollection,
								child,
								depth + 1,
								into,
								taskScope
							);
						}
					}
				});

			/**
			 * The lifecycle notifications a collection declares for one event, as channel outbox rows:
			 * one per recipient on the rule's person channel, resolved inside the write's own statement.
			 */
			const notificationStatements = (
				collection: string,
				event: CollectionLifecycleEvent
			): ReadonlyArray<{
				readonly sql: string;
				readonly parameters: ReadonlyArray<Schema.Json>;
			}> => {
				const rules = declaredModuleOf(collection)?.notifications?.[event.event] ?? [];
				const occurrence = `${collection}:${event.event}:${event.ids.join(',')}:${event.approval?.requestId ?? ''}:${event.approval?.step.index ?? ''}`;
				return rules.flatMap((rule, index) => {
					const message = rule.message(event);
					return notifyStatements(
						workspace.definition.channels,
						{
							key: occurrence,
							recipients: rule.recipients(event),
							via: [rule.channel],
							message: {
								...message,
								collection,
								ids: [...event.ids],
								...(event.approval === undefined ? {} : { approvalRequestId: event.approval.requestId })
							}
						},
						`${occurrence}:${index}`
					);
				});
			};

			/**
			 * Who may name a created record's id (RFC seeding.md §4): the administrator seeding a
			 * workspace, the host, and the static identities whose re-runs must land on the same rows
			 * (an integration's pull, an automation's walk). A person never does; the engine allocates.
			 */
			const mayNameCreatedIds = (subject: Identity.Subject): boolean =>
				subject.admin === true ||
				subject.system === true ||
				subject.policies.length > 0 ||
				isWorkspaceSubject(subject);
			const commitWrite = Effect.fn('Collections.write')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				groups: ReadonlyArray<WriteGroup>,
				options?: WriteOptions
			) {
				const admitted = groups.filter((group) => group.inputs.length > 0);
				const first = admitted[0];
				if (first === undefined)
					return { records: [], batch: { changes: [] } } satisfies WriteCommit;
				const browserMutation = options?.browserMutation;
				const readSnapshots: Array<ReadSnapshot> = [];
				const visibility: SubmittedVisibility = new Map();
				type Admitted = Readonly<{
					readonly group: WriteGroup;
					readonly definition: WorkspaceDefinition['collections'][number];
					readonly module: AuthoredCollectionModule;
					readonly declaration: Selection | undefined;
				}>;
				const prepared: Array<Admitted> = [];
				for (const group of admitted) {
					const definition = yield* workspace.collection(group.collection);
					const module = declaredModuleOf(group.collection);
					if (module === undefined)
						return yield* Effect.fail(
							declaredRefusal(
								group.collection,
								group.action,
								`${group.collection} declares no +collection.ts, so it accepts no ${group.action}.`
							)
						);
					const declaration =
						group.action === 'create'
							? module.create?.input
							: group.action === 'update'
								? module.update?.input
								: module.delete === undefined
									? undefined
									: {};
					if (declaration === undefined)
						return yield* Effect.fail(
							declaredRefusal(
								group.collection,
								group.action,
								`${group.collection} exposes no ${group.action} endpoint.`
							)
						);
					for (const input of group.inputs) {
						if (group.action === 'delete') {
							const owned = syncOwnershipRefusal(
								workspace.definition.integrations,
								group.collection,
								subject.userId,
								'delete',
								[]
							);
							if (owned !== undefined)
								return yield* Effect.fail(declaredRefusal(group.collection, 'delete', owned));
							if (!isNonEmptyString(input['id']))
								return yield* Effect.fail(
									declaredRefusal(
										group.collection,
										'delete',
										`A ${group.collection} delete needs an id.`
									)
								);
							continue;
						}
						if (group.action === 'update' && !isNonEmptyString(input['id']))
							return yield* Effect.fail(
								declaredRefusal(
									group.collection,
									'update',
									`A ${group.collection} update names its record by id.`
								)
							);
						yield* admitSubmission(
							effectId,
							subject,
							definition,
							group.action,
							declaration,
							input,
							group.collection,
							visibility,
							mayNameCreatedIds(subject)
						);
					}
					prepared.push({ group, definition, module, declaration });
				}
				// One wave: every row the batch names, root and nested. Deletes are judged on it.
				const requests: Array<Readonly<{ readonly collection: string; readonly id: string }>> = [];
				for (const group of admitted) collectNamed(group.collection, group.inputs, requests);
				const stored = yield* namedRows(effectId, requests);
				const previousOf = (target: string, id: string) =>
					stored.get(storedGraphRowKey(target, id))?.row;
				for (const { group } of prepared) {
					if (group.action !== 'delete') continue;
					for (const input of group.inputs) {
						const row = previousOf(group.collection, String(input['id']));
						if (row === undefined)
							return yield* Effect.fail(
								declaredRefusal(
									group.collection,
									'delete',
									`${group.collection} ${String(input['id'])} does not exist.`
								)
							);
						yield* judge(subject, 'delete', group.collection, row, visibility);
					}
				}
				/**
				 * The hold (RFC §4.8): a named row carrying a foreign `approval_id` is held. A participant
				 * of that request writes under it — every row it touches joins the request's lock set —
				 * and everyone else fails before anything is written.
				 */
				let heldRequest: string | undefined;
				for (const request of requests) {
					const held = previousOf(request.collection, request.id)?.['approval_id'];
					if (!isNonEmptyString(held)) continue;
					if (heldRequest !== undefined && heldRequest !== held)
						return yield* Effect.fail(
							new ApprovalHeld({ collection: request.collection, id: request.id, requestId: held })
						);
					if (heldRequest === undefined) {
						if (
							!(yield* approvals.participant(
								EffectId.make(`${effectId}:participant`),
								subject,
								held
							))
						)
							return yield* Effect.fail(
								new ApprovalHeld({
									collection: request.collection,
									id: request.id,
									requestId: held
								})
							);
						heldRequest = held;
					}
				}
				/**
				 * The caller's observed versions, asserted before any authored code runs (RFC §4.2).
				 *
				 * A row the caller read at version N that has moved is a typed conflict, named like the
				 * browser's own, rather than a database assertion the caller cannot classify.
				 */
				const named = new Set(
					requests.map((request) => storedGraphRowKey(request.collection, request.id))
				);
				for (const observed of options?.baseVersions ?? []) {
					if (observed.rowVersion === null) continue;
					const { collection: target, recordId } = observed.row;
					if (!named.has(storedGraphRowKey(target, recordId))) continue;
					const current = previousOf(target, recordId);
					if (current?.['row_version'] === observed.rowVersion) continue;
					return yield* Effect.fail(
						new MutationVersionConflict({
							collection: target,
							id: recordId,
							baseVersion: observed.rowVersion,
							currentVersion: isNumber(current?.['row_version'])
								? (current['row_version'] as number)
								: null
						})
					);
				}
				// The transform, once per admitted group, reading as the workspace and recording every read.
				const payloadsOf: Array<ReadonlyArray<Readonly<Record<string, unknown>>>> = [];
				/**
				 * The declared similarity indexes' vectors, embedded from the row the payload will make.
				 * Runs after the transform so the vector is the workspace's own work: a caller's input
				 * never names the column, and a row that changes gets re-embedded in the same statement.
				 * An embedder that throws is that collection's refusal, not a runtime fault.
				 */
				const embedSimilarity = (
					collection: string,
					module: AuthoredCollectionModule,
					inputs: ReadonlyArray<Readonly<Record<string, unknown>>>,
					payloads: ReadonlyArray<Readonly<Record<string, unknown>>>
				): Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, AuthoredRefusal> =>
					Effect.gen(function* () {
						const indexes = Object.entries(module.similarity ?? {});
						if (indexes.length === 0) return payloads;
						const embedded: Array<Readonly<Record<string, unknown>>> = [];
						for (const [position, payload] of payloads.entries()) {
							const stored = previousOf(collection, String(inputs[position]?.['id'] ?? ''));
							const row = { ...stored, ...payload };
							let next: Record<string, unknown> = { ...payload };
							for (const [name, index] of indexes) {
								const answer = yield* Effect.try({
									try: () => index.embed(row as never),
									catch: (cause) =>
										declaredRefusal(collection, `similarity.${name}`, describeCause(cause))
								});
								// One vector per column the index spans; `null` leaves a row out of that column's ranking.
								for (const [column, vector] of Object.entries(answer)) {
									if (vector !== null && !vector.every((value) => Number.isFinite(value)))
										return yield* Effect.fail(
											declaredRefusal(
												collection,
												`similarity.${name}`,
												`The ${name} embedder returned a vector with a non-finite value for ${column}.`
											)
										);
									next = { ...next, [column]: vector === null ? null : [...vector] };
								}
							}
							embedded.push(next);
						}
						return embedded;
					});
				for (const { group, module } of prepared) {
					if (group.action === 'delete') {
						payloadsOf.push(group.inputs);
						continue;
					}
					if (module.transform === undefined) {
						payloadsOf.push(
							yield* embedSimilarity(group.collection, module, group.inputs, group.inputs)
						);
						continue;
					}
					const existing = group.inputs.map((input) =>
						previousOf(group.collection, String(input['id'] ?? ''))
					);
					const budget = { waves: 0, inFlight: 0 };
					const transform = module.transform as (
						inputs: ReadonlyArray<Readonly<Record<string, unknown>>>,
						context: Readonly<{
							readonly existing: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>;
							readonly db: unknown;
						}>
					) => unknown;
					const transformed = yield* runAuthoredHandler<unknown>(() =>
						transform(group.inputs, {
							existing,
							db: transformDb(effectId, subject, budget, group.collection)
						})
					).pipe(
						Effect.provideService(PreparingReads, readSnapshots),
						Effect.catchDefect((cause) =>
							Effect.fail(
								cause instanceof ReadBudgetExceeded
									? cause
									: declaredRefusal(group.collection, 'transform', describeCause(cause))
							)
						),
						Effect.catch((cause) =>
							Effect.fail(
								cause instanceof AuthoredRefusal
									? refusalAt(cause, { collection: group.collection, action: 'transform' })
									: cause
							)
						)
					);
					if (!Array.isArray(transformed) || transformed.length !== group.inputs.length)
						return yield* Effect.fail(
							declaredRefusal(
								group.collection,
								'transform',
								`The ${group.collection} transform must return one payload per input, in order.`
							)
						);
					for (const payload of transformed)
						if (!isPlainRecord(payload))
							return yield* Effect.fail(
								declaredRefusal(
									group.collection,
									'transform',
									`The ${group.collection} transform returned a payload that is not a record.`
								)
							);
					payloadsOf.push(
						yield* embedSimilarity(
							group.collection,
							module,
							group.inputs,
							transformed as ReadonlyArray<Readonly<Record<string, unknown>>>
						)
					);
				}
				// A transform may name rows the submission did not (a link target, a child to update):
				// one more wave reads the ones the first did not cover, so lowering sees every pre-image.
				const added: Array<Readonly<{ readonly collection: string; readonly id: string }>> = [];
				for (const [index, { group }] of prepared.entries())
					collectNamed(group.collection, payloadsOf[index] ?? [], added);
				const missing = added.filter(
					(request) => !stored.has(storedGraphRowKey(request.collection, request.id))
				);
				if (missing.length > 0)
					for (const [key, row] of yield* namedRows(
						EffectId.make(`${effectId}:transform`),
						missing
					))
						if (row !== undefined) stored.set(key, row);
				// The payload graph, lowered to operations. Every row the transform added beyond the
				// caller's submission is the workspace's own work, checked against nobody.
				const operations: Array<GraphPreparedOperation> = [];
				const roots: Array<Readonly<{ readonly collection: string; readonly id: string }>> = [];
				const lowering: DeclaredLowering = {
					definitionOf: (name) =>
						workspace.definition.collections.find((entry) => entry.name === name),
					relationOf: declaredRelationOf,
					previousOf,
					visibilityOf: (collection, action) =>
						visibility.get(visibilityKey(collection, action)) ?? AccessControl.unrestricted,
					encode: (definition, values) => writableValues(values, definition),
					referenceProblem: (definition, values) =>
						referenceValueProblem(values, definition.fields),
					customValueProblem: (definition, values) =>
						describeInvalidCustomValue(definition.fields, values, workspace.definition.customTypes),
					allocateId: () => randomId(),
					taskScope: effectId
				};
				for (const [index, { group, module }] of prepared.entries()) {
					const payloads = payloadsOf[index] ?? [];
					for (const [position, payload] of payloads.entries()) {
						// A created root's id: named by the transform or a privileged caller (a person's
						// input never carries one — admission refused it), else the browser ledger's
						// allocation, else fresh. A transform that needs its own id names it.
						const rootId =
							group.action === 'create'
								? ((isNonEmptyString(payload['id']) &&
									(module.transform !== undefined || mayNameCreatedIds(subject))
										? payload['id']
										: undefined) ?? (index === 0 ? options?.createIds?.[position] : undefined))
								: String(group.inputs[position]?.['id'] ?? '');
						if (group.action === 'delete') {
							const row = previousOf(group.collection, rootId ?? '');
							const definition = yield* workspace.collection(group.collection);
							const before = operations.length;
							operations.push({
								action: 'delete',
								collection: group.collection,
								id: rootId ?? '',
								values: {},
								definition,
								visibility: lowering.visibilityOf(group.collection, 'delete'),
								...(row === undefined ? {} : { previous: row, snapshot: JSON.stringify(row) }),
								depth: 0,
								taskScope: effectId
							});
							yield* cascadeDeletes(effectId, group.collection, row ?? {}, 0, operations, effectId);
							roots.push({ collection: group.collection, id: operations[before]!.id });
							continue;
						}
						const lowered = yield* lowerDeclaredPayload(
							lowering,
							group.collection,
							group.action,
							group.action === 'update'
								? Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'id'))
								: payload,
							0,
							undefined,
							rootId
						);
						const root = lowered[0];
						if (root !== undefined) roots.push({ collection: root.collection, id: root.id });
						operations.push(...lowered);
					}
				}
				const coordinates = new Set<string>();
				for (const operation of operations) {
					const coordinate = writeRecordKey({
						collection: operation.collection,
						recordId: operation.id
					});
					if (coordinates.has(coordinate))
						return yield* graphRefusal(
							operation.collection,
							operation.action,
							`The write names ${operation.collection} ${operation.id} more than once.`
						);
					coordinates.add(coordinate);
				}
				const changedRows = ordinaryMutationChangedRowCount(operations);
				if (changedRows > MAX_ORDINARY_MUTATION_CHANGED_ROWS)
					return yield* graphRefusal(
						first.collection,
						first.action,
						`An ordinary mutation may change at most ${MAX_ORDINARY_MUTATION_CHANGED_ROWS} rows; this write changes ${changedRows}.`
					);
				/**
				 * GATE (RFC §4.8). Policy's `authorize` and approval route are asked of the root rows as
				 * the engine will write them; the whole batch shares one route or the batch is refused.
				 */
				let approval: Schema.Json | undefined;
				let approvalRoot:
					| Readonly<{ collection: string; id: string; action: 'create' | 'update' | 'delete' }>
					| undefined;
				for (const root of roots) {
					const operation = operations.find(
						(candidate) => candidate.collection === root.collection && candidate.id === root.id
					);
					if (operation === undefined) continue;
					const rootVisibility = lowering.visibilityOf(operation.collection, operation.action);
					const previous = operation.previous;
					const context =
						operation.action === 'update'
							? {
									previous: previous ?? { id: operation.id },
									changes: operation.values,
									record: { ...(previous ?? {}), id: operation.id, ...operation.values }
								}
							: operation.action === 'create'
								? { record: { id: operation.id, ...operation.values } }
								: { record: previous ?? { id: operation.id } };
					yield* authorizePolicyWrite(
						EffectId.make(
							`${effectId}:policy-authorization:${operation.collection}:${operation.id}`
						),
						subject,
						rootVisibility,
						operation.action,
						operation.collection,
						context
					);
					const route = yield* resolveApproval(
						EffectId.make(`${effectId}:approval-flow:${operation.collection}:${operation.id}`),
						subject,
						rootVisibility,
						operation.action,
						operation.collection,
						context
					);
					if (route === undefined) continue;
					if (
						approval !== undefined &&
						Approvals.approvalRouteFingerprint(approval) !==
							Approvals.approvalRouteFingerprint(route)
					)
						return yield* graphRefusal(
							operation.collection,
							operation.action,
							'The rows of one write route to different approval flows; submit them separately.'
						);
					if (approval === undefined) {
						approval = route;
						approvalRoot = {
							collection: operation.collection,
							id: operation.id,
							action: operation.action
						};
					}
				}
				/**
				 * A participant's write under a hold rides the open request (RFC §4.8): the requestor
				 * revising what they asked for, or an approver amending it, is reviewed by the request
				 * already open, never by a second one. Non-participants were refused above.
				 */
				if (heldRequest !== undefined) approval = undefined;
				/**
				 * A browser create names no id, so its fence was minted before the root's id existed:
				 * the committed outcome the ledger keeps (and a seal later writes) carries the id the
				 * engine allocated, never the empty string the wire form arrived with.
				 */
				const rootId = roots[0]?.id ?? '';
				const fence =
					browserMutation === undefined || browserMutation.outcome._tag !== 'Committed'
						? browserMutation
						: { ...browserMutation, outcome: { ...browserMutation.outcome, id: rootId } };
				const hold =
					approvalRoot === undefined || approval === undefined
						? undefined
						: yield* approvals.hold({
								effectId,
								subject,
								root: approvalRoot,
								approval,
								lockSet: operations
									.filter((operation) => operation.action !== 'delete')
									.map((operation) => ({ collection: operation.collection, id: operation.id })),
								...(fence === undefined ? {} : { browserMutation: fence as unknown as Schema.Json })
							});
				const holdRequest = hold?.requestId ?? heldRequest;
				const requestor = subject.userId;
				const eventIds = roots.map((root) => root.id);
				const lifecycle = (
					collection: string,
					action: 'create' | 'update' | 'delete',
					event: CollectionLifecycleEvent['event'],
					approvalEvent?: CollectionLifecycleEvent['approval']
				): CollectionLifecycleEvent => ({
					event,
					collection,
					action,
					ids: eventIds,
					requestor,
					...(approvalEvent === undefined ? {} : { approval: approvalEvent })
				});
				const notifications =
					hold === undefined
						? holdRequest === undefined
							? prepared.flatMap(({ group }) =>
									notificationStatements(
										group.collection,
										lifecycle(group.collection, group.action, 'committed')
									)
								)
							: []
						: (() => {
								const step =
									isJsonObject(approval) &&
									Array.isArray(approval['steps']) &&
									isJsonObject(approval['steps'][0])
										? {
												index: 0,
												approvers:
													(approval['steps'][0]['approvers'] as ReadonlyArray<string>) ?? []
											}
										: { index: 0, approvers: [] };
								const started = lifecycle(first.collection, first.action, 'approvalStarted', {
									requestId: hold.requestId,
									step
								});
								const requested = lifecycle(
									first.collection,
									first.action,
									'approvalStepRequested',
									{ requestId: hold.requestId, step }
								);
								return [
									...notificationStatements(first.collection, started),
									...notificationStatements(first.collection, requested)
								];
							})();
				const compiled = statementPlanFor(operations, {
					...(fence === undefined ? {} : { ledgerClaim: fence })
				});
				// The ledger row a hold claims is the pending identity the seal and restore later assert on.
				const claimed: BrowserMutationFence | undefined =
					fence === undefined || hold === undefined
						? fence
						: {
								...fence,
								outcome: {
									_tag: 'PendingApproval',
									requestId: hold.requestId,
									collection: first.collection,
									id: rootId,
									action: first.action,
									schemaFingerprint: fence.currentSchemaFingerprint
								}
							};
				const applied = yield* applyDeclarativeGraph(
					effectId,
					subject,
					compiled,
					readSnapshots,
					claimed,
					holdRequest === undefined
						? undefined
						: {
								requestId: holdRequest,
								...(hold === undefined ? {} : { statement: hold.statement })
							},
					notifications
				).pipe(
					Effect.catchCause((cause) =>
						Effect.gen(function* () {
							const failure = Cause.squash(cause);
							if (failure instanceof BrowserMutationReplay) return yield* Effect.fail(failure);
							if (browserMutation !== undefined && !Cause.hasInterruptsOnly(cause)) {
								// A concurrent retry of the same browser write may have won the ledger claim.
								const replay = yield* browserMutationOutcome(
									EffectId.make(`${effectId}:concurrent-replay`),
									browserMutation.scope,
									browserMutation.idempotencyKey,
									browserMutation.requestDigest
								).pipe(
									Effect.catchTag('Bolt.Collections.MutationIdempotencyConflict', (conflict) =>
										Effect.fail(mutationPhaseFailure('commit', first.collection, [], conflict))
									)
								);
								if (replay !== undefined) return yield* replayBrowserMutationOutcome(replay);
							}
							return yield* Effect.fail(
								mutationPhaseFailure('commit', first.collection, [], failure)
							);
						})
					)
				);
				if (applied.batch.changes.length > 0)
					yield* syncCommit
						.publish(EffectId.make(`${effectId}:publish`), applied.batch)
						.pipe(
							Effect.mapError((error) =>
								mutationPhaseFailure('settle', first.collection, eventIds, error, 'sync-commit')
							)
						);
				if (hold !== undefined)
					yield* approvals
						.announce(EffectId.make(`${effectId}:announce`), hold.requestId)
						.pipe(
							Effect.mapError((error) =>
								mutationPhaseFailure('settle', first.collection, eventIds, error)
							)
						);
				const settled = yield* settleWrite(effectId, applied, first.collection, eventIds);
				return {
					records: roots.map(
						(root) =>
							settled.get(`${root.collection}\u0000${root.id}`) ??
							applied.records.get(`${root.collection}\u0000${root.id}`) ?? { id: root.id }
					),
					batch: applied.batch,
					...(hold === undefined ? {} : { pendingApproval: { requestId: hold.requestId } })
				} satisfies WriteCommit;
			});

			/** The write path for every caller but the browser ledger, which handles a replay itself. */
			const write: Interface['write'] = (effectId, subject, groups, options) =>
				commitWrite(effectId, subject, groups, options).pipe(
					Effect.catchIf(isBrowserMutationReplay, (cause) =>
						cause.outcome._tag === 'Committed'
							? Effect.succeed({
									records: [{ id: cause.outcome.id }],
									batch: { changes: [] }
								} satisfies WriteCommit)
							: Effect.fail(mutationPhaseFailure('commit', groups[0]?.collection ?? '', [], cause))
					)
				);

			/** SETTLE: change-triggered automations and embeddings for one committed graph. */
			const settleWrite = (
				effectId: EffectId,
				applied: AppliedDeclarativeGraph,
				collection: string,
				committed: ReadonlyArray<string>
			) =>
				settleDeclarativeGraphService(
					{
						emitChangeEventsMany: (eventEffectId, eventCollection, records, event) =>
							emitChangeEventsManyService(
								changeEventPorts,
								eventEffectId,
								eventCollection,
								records,
								event
							),
						embedRecords: (embeddingEffectId, options) =>
							embedRecordsService(embeddingPorts, embeddingEffectId, options)
					},
					effectId,
					applied
				).pipe(
					Effect.catchCause((cause) =>
						Effect.fail(mutationPhaseFailure('settle', collection, committed, Cause.squash(cause)))
					)
				);

			/**
			 * Applies one seed plan (RFC seeding.md §4): fixtures in model order, each collection one
			 * declared `createMany` batch as the administering subject.
			 *
			 * A row whose id already exists is skipped, so re-running a seed writes nothing new. The
			 * plan order is derived from the relation graph — a collection that names another is
			 * written after it — never a hand-written stage list.
			 */
			const seedApply = Effect.fn('Collections.seedApply')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				fixtures: ReadonlyArray<
					Readonly<{
						readonly collection: string;
						readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
					}>
				>
			) {
				const byName = new Map(fixtures.map((fixture) => [fixture.collection, fixture.rows]));
				for (const [name, rows] of byName) {
					if (declaredModuleOf(name)?.create === undefined)
						return yield* Effect.fail(
							declaredRefusal(
								name,
								'create',
								`${name} is not a declared collection with a create input, so it cannot be seeded.`
							)
						);
					if (!Array.isArray(rows))
						return yield* Effect.fail(
							declaredRefusal(name, 'create', `The ${name} fixture is not an array of rows.`)
						);
				}
				const names = [...byName.keys()];
				const dependencies = new Map<string, Set<string>>();
				for (const relation of workspace.definition.relations) {
					if (!byName.has(relation.source) || !byName.has(relation.target)) continue;
					const dependent = relation.cardinality === 'many' ? relation.target : relation.source;
					const dependency = relation.cardinality === 'many' ? relation.source : relation.target;
					const set = dependencies.get(dependent) ?? new Set<string>();
					set.add(dependency);
					dependencies.set(dependent, set);
				}
				const ordered: Array<string> = [];
				const remaining = new Set(names);
				while (remaining.size > 0) {
					const ready = [...remaining].filter((name) =>
						[...(dependencies.get(name) ?? [])].every((dependency) => !remaining.has(dependency))
					);
					if (ready.length === 0) {
						// A cycle is a model error the compiler reports; seeding keeps declaration order.
						ordered.push(...remaining);
						break;
					}
					for (const name of ready) {
						ordered.push(name);
						remaining.delete(name);
					}
				}
				const applied: Record<string, number> = {};
				for (const name of ordered) {
					const rows = byName.get(name) ?? [];
					const ids = rows.flatMap((row) => (isNonEmptyString(row['id']) ? [row['id']] : []));
					let pending = rows;
					if (ids.length > 0) {
						const existing = yield* database.execute(
							EffectId.make(`${effectId}:seed-existing:${name}`),
							{
								_tag: 'Query',
								sql: `select id from ${quoteIdentifier(name)} where id = any($1)`,
								parameters: [ids]
							}
						);
						const present = new Set(
							existing.rows.flatMap((row) =>
								isJsonObject(row) && isNonEmptyString(row['id']) ? [row['id']] : []
							)
						);
						pending = rows.filter((row) => !isNonEmptyString(row['id']) || !present.has(row['id']));
					}
					if (pending.length > 0)
						yield* write(EffectId.make(`${effectId}:seed:${name}`), subject, [
							{ collection: name, action: 'create', inputs: pending }
						]);
					applied[name] = pending.length;
				}
				return applied;
			});
			const count = Effect.fn('Collections.count')(function* (effectId, subject, input) {
				const { definition, compiled, searched, visibility } = yield* prepareRead(
					effectId,
					subject,
					input,
					input.collection
				);
				// The same search the rows are read through. A count that ignored it reported the whole
				// collection under a filtered page — "1 of 335" beside three rows.
				// `after` is deliberately absent here. A count answers how large the filtered set is, which
				// is what a "1 of 335" reads from; counting only the rows past the cursor would shrink that
				// total on every page turn.
				const table = queryTableFor(input.collection, definition.fields);
				const result = yield* observedRead(
					effectId,
					database,
					composer
						.select({ count: countRows() })
						.from(table)
						.where(and(compiled, searched.predicate, AccessControl.predicateExpression(visibility)))
				);
				const row = result.rows[0];
				const value = isPlainRecord(row) ? Reflect.get(row, 'count') : undefined;
				return isNumber(value) ? value : decodeNumber(value ?? 0);
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
					const { definition, policy, compiled, searched, visibility } = yield* prepareRead(
						effectId,
						subject,
						input,
						ROOT_ALIAS,
						() =>
							input.lanes.length > GROUPED_RESULT_LIMIT
								? new WhereCompileError({
										collection: input.collection,
										field: input.groupBy,
										message: `Grouped query exceeds the ${GROUPED_RESULT_LIMIT}-lane request limit.`
									})
								: undefined
					);
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
					const read = yield* readRelational(effectId, subject, input.collection, policy, {
						where:
							and(
								compiled,
								searched.predicate,
								AccessControl.predicateExpression(visibility, { qualifier: ROOT_ALIAS })
							) ?? always(),
						ordering: compileOrderTerms(workspace.definition, input.collection, input.orderBy),
						searchOrdering:
							searched.mode === 'lexical'
								? desc(searched.rank)
								: searched.mode === 'semantic' || searched.mode === 'nearest'
									? asc(searched.distance)
									: undefined,
						limit: GROUPED_RESULT_LIMIT + 1,
						with: input.with,
						columns: input.columns
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
								reason:
									'stored browser mutation approval provenance has a conflicting request digest'
							})
						)
					)
				);
			});
			const storedFence = (requestId: string, value: Schema.Json | undefined) =>
				value === undefined
					? Effect.succeed(undefined)
					: Schema.decodeUnknownEffect(StoredBrowserMutationFence)(value).pipe(
							Effect.mapError(
								() =>
									new ApprovalConflict({
										requestId,
										reason: 'the request carries malformed browser mutation provenance'
									})
							)
						);
			/** The physical columns of one table, `id` first, as a restore rewrites them. */
			const physicalColumns = (
				collection: string,
				definition: WorkspaceDefinition['collections'][number]
			): ReadonlyArray<string> =>
				Object.keys(columnsOf(queryTableFor(collection, definition.fields)));
			/** Sync changes read off a restore or seal statement's `(collection, id, before, after)` rows. */
			const capturedChanges = (rows: ReadonlyArray<unknown>): ReadonlyArray<SyncChange> =>
				compactSyncChanges(
					rows.flatMap((row): ReadonlyArray<SyncChange> => {
						if (
							!isJsonObject(row) ||
							typeof row['collection'] !== 'string' ||
							typeof row['id'] !== 'string'
						)
							return [];
						const fields = captureFields.get(row['collection']) ?? new Set<string>();
						const before = isJsonObject(row['before']) ? row['before'] : undefined;
						const after = isJsonObject(row['after']) ? row['after'] : undefined;
						const common = { collection: row['collection'], id: row['id'] };
						if (before !== undefined && after !== undefined)
							return [
								{
									...common,
									operation: 'update',
									before: projectLinkAndRouteValues(before, fields),
									after: projectLinkAndRouteValues(after, fields)
								}
							];
						if (after !== undefined)
							return [
								{ ...common, operation: 'insert', after: projectLinkAndRouteValues(after, fields) }
							];
						if (before !== undefined)
							return [
								{
									...common,
									operation: 'delete',
									before: projectLinkAndRouteValues(before, fields)
								}
							];
						return [];
					})
				);
			/**
			 * The seal (RFC §4.8): the last step approved, so the stamps come off and `committed` fires.
			 *
			 * The values on the records are whatever the requestor and participants left there; nothing
			 * is re-applied. One statement clears every locked collection, stamps `applied_at` on the
			 * request, and returns each row before and after so the browsers see the stamp lift.
			 */
			const resume = Effect.fn('Collections.resume')(function* (
				effectId: EffectId,
				requestId: string
			) {
				const engineResume = yield* approvals.resume(effectId, requestId);
				const fence = yield* storedFence(requestId, engineResume.browserMutation);
				if (
					fence !== undefined &&
					(yield* approvalBrowserMutationOutcome(
						EffectId.make(`${effectId}:approved-replay`),
						requestId,
						fence
					))?._tag === 'Committed'
				)
					return;
				const collections = [
					...new Set(engineResume.lockSet.map((row) => row.collection))
				].toSorted();
				const ctes: Array<string> = [];
				const selects: Array<string> = [];
				for (const [index, collection] of collections.entries()) {
					const table = quoteIdentifier(collection);
					ctes.push(
						`before_${index} as (select id, to_jsonb(t) as row from ${table} as t where approval_id = $1)`,
						`after_${index} as (update ${table} as t set approval_id = null, row_version = t.row_version + 1, updated_at = now() where t.approval_id = $1 returning t.id, to_jsonb(t) as row)`
					);
					selects.push(
						`select ${quoteStringLiteral(collection)} as collection, b.id::text as id, b.row as before, a.row as after from before_${index} as b join after_${index} as a on a.id = b.id`
					);
				}
				ctes.push(
					`settled as (update approval_request set applied_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, row_version = row_version + 1 where id = $1 and applied_at is null returning id, to_jsonb(approval_request) as row)`
				);
				selects.push(
					`select 'approval_request' as collection, settled.id::text as id, to_jsonb(previous) as before, settled.row as after from settled join approval_request as previous on previous.id = settled.id`
				);
				const rootAction = engineResume.root.action;
				const event: CollectionLifecycleEvent = {
					event: 'committed',
					collection: engineResume.root.collection,
					action: rootAction,
					ids: engineResume.lockSet
						.filter((row) => row.collection === engineResume.root.collection)
						.map((row) => row.id),
					requestor: engineResume.subject.userId,
					approval: { requestId, step: { index: 0, approvers: [] } }
				};
				const statements = [
					OneStatement.oneStatement(
						[
							...[
								...notificationStatements(engineResume.root.collection, event),
								...notificationStatements(engineResume.root.collection, {
									...event,
									event: 'approvalCompleted'
								})
							].map((fragment, index) => ({ key: `book${index}`, fragment })),
							...(fence === undefined
								? []
								: [
										{
											key: 'ledger',
											fragment: browserMutationApprovalTerminalStatement(
												fence,
												requestId,
												engineResume.root.collection,
												engineResume.root.id,
												rootAction,
												fence.outcome
											)
										}
									])
						],
						{
							sql: `with ${ctes.join(', ')} select sealed.* from anchor cross join lateral (${selects.join(' union all ')}) as sealed`,
							parameters: [requestId]
						}
					)
				];
				const result = yield* database
					.execute(effectId, { _tag: 'Transaction', statements })
					.pipe(
						Effect.mapError((error) =>
							mutationPhaseFailure('commit', engineResume.root.collection, [], error)
						)
					);
				const changes = capturedChanges(result.rows);
				if (changes.length > 0)
					yield* syncCommit
						.publish(EffectId.make(`${effectId}:seal-publish`), { changes })
						.pipe(
							Effect.mapError((error) =>
								mutationPhaseFailure(
									'settle',
									engineResume.root.collection,
									[],
									error,
									'sync-commit'
								)
							)
						);
			});
			/**
			 * The restore (RFC §4.8): request-changes, withdraw or reject returns every row the request
			 * touched to its `hold` snapshot — rows born under the hold are deleted, rows deleted under
			 * it are re-inserted, everything else is rewritten — clears the stamps and appends one
			 * `restore` revision per row. Every change made while the request was in flight, by anyone,
			 * is undone; the history keeps all of them. A restore that cannot apply leaves the hold in
			 * place and marks the request conflicted for an administrator.
			 */
			const discard = Effect.fn('Collections.discard')(function* (
				effectId: EffectId,
				requestId: string
			) {
				const engineDiscard = yield* approvals.discard(effectId, requestId);
				const fence = yield* storedFence(requestId, engineDiscard.browserMutation);
				const holds = yield* database.execute(EffectId.make(`${effectId}:hold-snapshots`), {
					_tag: 'Query',
					sql: `select distinct on (collection_name, record_id) collection_name, record_id, snapshot from bolt_collection_history where approval_id = $1 and operation = 'hold' order by collection_name, record_id, sequence asc`,
					parameters: [requestId]
				});
				type Hold = Readonly<{
					collection: string;
					id: string;
					snapshot: Readonly<Record<string, Schema.Json>> | null;
				}>;
				const snapshots: Array<Hold> = holds.rows.flatMap((row) =>
					isJsonObject(row) &&
					typeof row['collection_name'] === 'string' &&
					typeof row['record_id'] === 'string'
						? [
								{
									collection: row['collection_name'],
									id: row['record_id'],
									snapshot: isJsonObject(row['snapshot']) ? row['snapshot'] : null
								}
							]
						: []
				);
				const byCollection = Map.groupBy(snapshots, (hold) => hold.collection);
				const ctes: Array<string> = [];
				const selects: Array<string> = [];
				const parameters: Array<Schema.Json> = [];
				const history: Array<PlannedInsert> = [];
				for (const [collection, rows] of byCollection) {
					const definition = yield* workspace.collection(collection);
					const table = quoteIdentifier(collection);
					const index = ctes.length;
					const columns = physicalColumns(collection, definition).filter(
						(column) => column !== 'id'
					);
					const born = rows.filter((hold) => hold.snapshot === null).map((hold) => hold.id);
					const kept = rows.flatMap((hold) => (hold.snapshot === null ? [] : [hold.snapshot]));
					if (born.length > 0) {
						const parameter = parameters.push(born);
						ctes.push(
							`deleted_${index} as (delete from ${table} as t where t.id = any($${parameter}::uuid[]) returning t.id, to_jsonb(t) as row)`
						);
						selects.push(
							`select ${quoteStringLiteral(collection)} as collection, d.id::text as id, d.row as before, null::jsonb as after from deleted_${index} as d`
						);
						for (const id of born)
							history.push({
								table: 'bolt_collection_history',
								columns: HISTORY_COLUMNS,
								values: [
									collection,
									id,
									'restore',
									engineDiscard.subject.userId,
									effectId,
									requestId,
									{ id }
								]
							});
					}
					if (kept.length > 0) {
						const parameter = parameters.push(JSON.stringify(kept));
						const assignments = columns
							.map((column) =>
								column === 'approval_id'
									? `${quoteIdentifier(column)} = null`
									: column === 'row_version'
										? `row_version = t.row_version + 1`
										: column === 'updated_at'
											? `updated_at = now()`
											: `${quoteIdentifier(column)} = v.${quoteIdentifier(column)}`
							)
							.join(', ');
						ctes.push(
							`restored_before_${index} as (select t.id, to_jsonb(t) as row from ${table} as t where t.id in (select v.id from jsonb_populate_recordset(null::${table}, $${parameter}::jsonb) as v))`,
							`restored_${index} as (update ${table} as t set ${assignments} from jsonb_populate_recordset(null::${table}, $${parameter}::jsonb) as v where t.id = v.id returning t.id, to_jsonb(t) as row)`,
							`reinserted_${index} as (insert into ${table} select * from jsonb_populate_recordset(null::${table}, $${parameter}::jsonb) as v where not exists (select 1 from ${table} as t where t.id = v.id) returning id, to_jsonb(${table}) as row)`,
							`unstamped_${index} as (update ${table} as t set approval_id = null where t.id in (select id from reinserted_${index}) returning t.id, to_jsonb(t) as row)`
						);
						selects.push(
							`select ${quoteStringLiteral(collection)} as collection, b.id::text as id, b.row as before, r.row as after from restored_before_${index} as b join restored_${index} as r on r.id = b.id`,
							`select ${quoteStringLiteral(collection)} as collection, u.id::text as id, null::jsonb as before, u.row as after from unstamped_${index} as u`
						);
						for (const snapshot of kept)
							history.push({
								table: 'bolt_collection_history',
								columns: HISTORY_COLUMNS,
								values: [
									collection,
									String(snapshot['id'] ?? ''),
									'restore',
									engineDiscard.subject.userId,
									effectId,
									requestId,
									{ ...snapshot, approval_id: null }
								]
							});
					}
				}
				const resolution: CollectionLifecycleEvent['event'] =
					engineDiscard.resolution === 'rejected'
						? 'rejected'
						: engineDiscard.resolution === 'changes_requested'
							? 'approvalChangesRequested'
							: 'approvalWithdrawn';
				const event: CollectionLifecycleEvent = {
					event: resolution,
					collection: engineDiscard.root.collection,
					action: engineDiscard.root.action,
					ids: engineDiscard.lockSet
						.filter((row) => row.collection === engineDiscard.root.collection)
						.map((row) => row.id),
					requestor: engineDiscard.subject.userId,
					approval: { requestId, step: { index: 0, approvers: [] } }
				};
				const rejected: BrowserMutationOutcome | undefined =
					fence === undefined
						? undefined
						: {
								_tag: 'Rejected',
								code: 'refused',
								message:
									engineDiscard.resolution === 'rejected'
										? 'The approval request was rejected.'
										: engineDiscard.resolution === 'changes_requested'
											? 'Changes were requested for the approval request.'
											: 'The approval request was withdrawn.',
								schemaFingerprint: fence.currentSchemaFingerprint,
								collection: engineDiscard.root.collection,
								action: engineDiscard.root.action
							};
				const statements = [
					OneStatement.oneStatement(
						[
							...notificationStatements(engineDiscard.root.collection, event).map(
								(fragment, index) => ({ key: `book${index}`, fragment })
							),
							...groupedInserts(history).map((group) => ({
								key: group.key,
								fragment: group.fragment
							})),
							...(fence === undefined || rejected === undefined
								? []
								: [
										{
											key: 'ledger',
											fragment: browserMutationApprovalTerminalStatement(
												fence,
												requestId,
												engineDiscard.root.collection,
												engineDiscard.root.id,
												engineDiscard.root.action,
												rejected
											)
										}
									])
						],
						selects.length === 0
							? { sql: 'select null::text as collection from anchor where false', parameters: [] }
							: {
									sql: `with ${ctes.join(', ')} select restored.* from anchor cross join lateral (${selects.join(' union all ')}) as restored`,
									parameters
								}
					)
				];
				const restored = yield* Effect.result(
					database.execute(effectId, { _tag: 'Transaction', statements })
				);
				if (Result.isFailure(restored)) {
					yield* approvals
						.conflict(
							EffectId.make(`${effectId}:restore-conflict`),
							requestId,
							`the restore could not apply: ${restored.failure.message}`
						)
						.pipe(Effect.ignore);
					return yield* Effect.fail(
						mutationPhaseFailure('commit', engineDiscard.root.collection, [], restored.failure)
					);
				}
				const changes = capturedChanges(restored.success.rows);
				if (changes.length > 0)
					yield* syncCommit
						.publish(EffectId.make(`${effectId}:restore-publish`), { changes })
						.pipe(
							Effect.mapError((error) =>
								mutationPhaseFailure(
									'settle',
									engineDiscard.root.collection,
									[],
									error,
									'sync-commit'
								)
							)
						);
			});
			/**
			 * One browser write under its idempotent envelope (RFC §4.2): the same claim, replay and
			 * terminal-outcome ledger as before, around the one write path.
			 */
			const mutateBrowser = Effect.fn('Collections.mutateBrowser')(function* (
				effectId: EffectId,
				actor: Identity.Subject,
				subject: Identity.Subject,
				impersonatedTeam: string | null,
				input: CollectionMutationPush
			) {
				const scope = browserMutationScopeFor(actor, subject, impersonatedTeam);
				const requestDigest = yield* sha256Hex(canonicalJson(input));
				const scopeDigest = yield* sha256Hex(
					canonicalJson({ ...scope, idempotencyKey: input.idempotencyKey })
				);
				const mutationEffectId = EffectId.make(`browser-mutation:${scopeDigest}`);
				const nowEpochMs = yield* Clock.currentTimeMillis;
				const currentSchemaFingerprint = workspace.definition.schemaFingerprint;
				if (currentSchemaFingerprint === undefined)
					return yield* Effect.fail(
						new TypeError('Compiled workspace is missing its schema fingerprint.')
					);
				const graph = input.graph;
				const baseVersions = input.baseVersions;
				// A create's id is allocated here, before the ledger claim, so the durable outcome names
				// the row the engine will write; the same push replayed lands on the same id.
				const createIds =
					graph.action === 'create'
						? graph.inputs.map((_, index) => deriveRecordId(`${scopeDigest}:create:${index}`))
						: undefined;
				const rootId = createIds?.[0] ?? String(graph.inputs[0]['id'] ?? '');
				const fenceFor = (
					outcome: BrowserMutationOutcome,
					issuedAtEpochMs: number
				): BrowserMutationFence => ({
					scope,
					idempotencyKey: input.idempotencyKey,
					requestDigest,
					issuedAtEpochMs,
					partitionKey: input.partitionKey,
					schemaFingerprint: input.schemaFingerprint,
					currentSchemaFingerprint,
					baseVersions,
					outcome
				});
				const settleOutcome = (outcome: BrowserMutationOutcome) =>
					(outcome._tag !== 'Committed' || outcome.action === 'delete'
						? Effect.succeed([])
						: findMany(EffectId.make(`${mutationEffectId}:readback`), subject, {
								collection: outcome.collection,
								where: { id: { in: [outcome.id] } },
								limit: 1
							}).pipe(
								// repository-health:allow SWALLOW2 -- the mutation is already durable when this post-commit readback runs; a readback failure settles the accepted outcome with the empty records `settle` legitimately supports, rather than failing an idempotent committed response the client would then replay.
								Effect.catch(() => Effect.succeed([]))
							)
					).pipe(
						Effect.map((records) =>
							projectBrowserMutationOutcome(input.idempotencyKey, outcome).settle(records)
						)
					);
				const claim = (fence: BrowserMutationFence) =>
					Effect.gen(function* () {
						const beginning = yield* beginBrowserMutation(
							EffectId.make(`${effectId}:browser-mutation:begin`),
							fence
						);
						if (beginning._tag === 'Replay') return yield* settleOutcome(beginning.outcome);
						if (beginning._tag === 'InProgress')
							return yield* new MutationInProgress({
								retryAfterSeconds: beginning.retryAfterSeconds
							});
						return undefined;
					});
				const settleTerminal = (fence: BrowserMutationFence, outcome: BrowserMutationOutcome) =>
					rememberBrowserMutationOutcome(
						EffectId.make(`${effectId}:browser-mutation:terminal`),
						fence,
						outcome
					).pipe(Effect.flatMap((durable) => settleOutcome(durable ?? outcome)));
				const immediateRejection = (message: string) =>
					Effect.gen(function* () {
						const outcome: BrowserMutationOutcome = {
							_tag: 'Rejected',
							code: 'refused',
							message,
							schemaFingerprint: currentSchemaFingerprint,
							collection: graph.collection,
							action: graph.action
						};
						const fence = fenceFor(outcome, nowEpochMs);
						const replay = yield* claim(fence);
						return replay ?? (yield* settleTerminal(fence, outcome));
					});
				if (input.schemaFingerprint !== currentSchemaFingerprint)
					return yield* immediateRejection(
						'The mutation was stated against a different schema. Reload the workspace and restate the write against the current release.'
					);
				if (input.issuedAtEpochMs > nowEpochMs + 5 * 60 * 1000)
					return yield* immediateRejection(
						new MutationRetryExpired({ issuedAtEpochMs: input.issuedAtEpochMs }).message
					);
				let quarantineReason: string | undefined;
				const coordinates = new Set<string>();
				for (const entry of baseVersions) {
					const coordinate = canonicalJson(entry.row);
					if (coordinates.has(coordinate)) {
						quarantineReason = `The mutation graph carries more than one base version for ${entry.row.collection} ${entry.row.recordId}.`;
						break;
					}
					coordinates.add(coordinate);
				}
				if (
					graph.action === 'create' &&
					graph.inputs.some((row) =>
						baseVersions.some(
							(entry) =>
								entry.row.collection === graph.collection &&
								entry.row.recordId === String(row['id'] ?? '')
						)
					)
				)
					quarantineReason = `The create graph carries a base version for a new root on ${graph.collection}.`;
				const committed: BrowserMutationOutcome = {
					_tag: 'Committed',
					collection: graph.collection,
					id: rootId,
					action: graph.action,
					resolution: 'accepted',
					fromSchemaFingerprint: input.schemaFingerprint,
					toSchemaFingerprint: currentSchemaFingerprint
				};
				const outcome: BrowserMutationOutcome =
					quarantineReason === undefined
						? committed
						: {
								_tag: 'Quarantined',
								idempotencyKey: input.idempotencyKey,
								schemaFingerprint: input.schemaFingerprint,
								reason: quarantineReason
							};
				const fence = fenceFor(outcome, input.issuedAtEpochMs);
				const replay = yield* claim(fence);
				if (replay !== undefined) return replay;
				if (outcome._tag === 'Quarantined') return yield* settleTerminal(fence, outcome);

				const unwrapPhase = (cause: unknown): unknown => {
					let current = cause;
					while (current instanceof MutationPhaseFailure) current = current.underlying;
					return current;
				};
				const persistFailure = (cause: unknown) => {
					const error = unwrapPhase(cause);
					const refusal = refusalOf(error);
					const terminal: BrowserMutationOutcome =
						refusal !== undefined
							? {
									_tag: 'Rejected',
									code: 'refused',
									message: refusal.message,
									schemaFingerprint: currentSchemaFingerprint,
									...(refusal.collection === undefined ? {} : { collection: refusal.collection }),
									...(refusal.action === undefined ? {} : { action: refusal.action })
								}
							: error instanceof AccessControl.AccessDenied
								? {
										_tag: 'Rejected',
										code: 'forbidden',
										message: error.reason,
										schemaFingerprint: currentSchemaFingerprint,
										collection: error.resource,
										...(error.action === 'create' ||
										error.action === 'update' ||
										error.action === 'delete'
											? { action: error.action }
											: {})
									}
								: error instanceof ApprovalHeld
									? {
											_tag: 'Rejected',
											code: 'refused',
											message: error.message,
											schemaFingerprint: currentSchemaFingerprint,
											collection: error.collection
										}
									: error instanceof Workspace.WorkspaceLookupError
										? {
												_tag: 'Rejected',
												code: 'refused',
												message: `The workspace has no ${error.kind} named ${error.name}.`,
												schemaFingerprint: currentSchemaFingerprint
											}
										: error instanceof MutationVersionConflict
											? {
													_tag: 'VersionConflict',
													collection: error.collection,
													id: error.id,
													baseVersion: error.baseVersion,
													currentVersion: error.currentVersion,
													schemaFingerprint: currentSchemaFingerprint
												}
											: {
													_tag: 'Quarantined',
													idempotencyKey: input.idempotencyKey,
													schemaFingerprint: currentSchemaFingerprint,
													reason: `The mutation stopped with an unclassified failure: ${describeCause(error)}`
												};
					return settleTerminal(fence, terminal);
				};
				const written = yield* Effect.result(
					commitWrite(
						mutationEffectId,
						subject,
						[{ collection: graph.collection, action: graph.action, inputs: graph.inputs }],
						{
							baseVersions,
							browserMutation: fence,
							...(createIds === undefined ? {} : { createIds })
						}
					)
				);
				if (Result.isFailure(written)) {
					const error = unwrapPhase(written.failure);
					if (error instanceof BrowserMutationReplay) return yield* settleOutcome(error.outcome);
					if (error instanceof MutationQuarantined)
						return yield* settleOutcome({
							_tag: 'Quarantined',
							idempotencyKey: error.idempotencyKey,
							schemaFingerprint: error.schemaFingerprint,
							reason: error.reason
						});
					return yield* persistFailure(written.failure);
				}
				// The engine allocates a created root's id; the wire form carried none.
				const writtenId =
					typeof written.success.records[0]?.['id'] === 'string'
						? written.success.records[0]['id']
						: rootId;
				if (written.success.pendingApproval !== undefined) {
					// The rows are committed under the hold; the browser learns the request it waits on.
					const pending: BrowserMutationOutcome = {
						_tag: 'PendingApproval',
						requestId: written.success.pendingApproval.requestId,
						collection: graph.collection,
						id: writtenId,
						action: graph.action,
						schemaFingerprint: currentSchemaFingerprint
					};
					const durable = yield* rememberBrowserMutationOutcome(
						EffectId.make(`${effectId}:pending-approval`),
						fence,
						pending
					);
					return {
						...(yield* settleOutcome(durable ?? pending)),
						changes: written.success.batch.changes
					};
				}
				const settlement = yield* settleOutcome({ ...committed, id: writtenId });
				return {
					...settlement,
					changes: written.success.batch.changes
				};
			});
			/** The history/audit gate: the current row must remain visible under the history-capable subject. */
			const currentRowEntitlement = Effect.fn('Collections.currentRowEntitlement')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				id: string
			) {
				const definition = yield* workspace.collection(collection);
				const policy = access.invocation();
				yield* policy.authorize(subject, 'history', collection);
				const readAccess = yield* policy.read(subject, collection);
				const currentTable = queryTableFor(collection, definition.fields);
				const currentColumns = columnsOf(currentTable);
				const visible = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({ id: currentColumns['id']! })
						.from(currentTable)
						.where(
							and(
								eq(currentColumns['id']!, id),
								AccessControl.predicateExpression(readAccess.predicate)
							)
						)
						.limit(1)
				);
				return visible.rows.length === 0 ? undefined : readAccess;
			});
			const history: Interface['history'] = Effect.fn('Collections.history')(
				function* (effectId, subject, collection, id, at) {
					const readAccess = yield* currentRowEntitlement(
						EffectId.make(`${effectId}:current-visibility`),
						subject,
						collection,
						id
					);
					// Absence and a policy-hidden current row deliberately have the same answer.
					if (readAccess === undefined) return [];
					const historyRead = collectionHistoryReadStatement(collection, id);
					const result = yield* database.execute(effectId, {
						_tag: 'Query',
						// repository-health:allow SQL1 -- fixed system table; collection and id are bound.
						sql: historyRead.sql,
						parameters: historyRead.parameters
					});
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
					// One projection implementation: the patch log folds through `projectHistory`, which
					// reconstructs before masking so a field grant can never change patch semantics, and
					// bounds the answer to the same horizon the retention prune keeps the table within.
					const allPatches = historyPatchesFromRows(rows);
					// RFC §4.7: the anchor narrows the log before reconstruction, so the read is the
					// record's state at that revision or instant, reconstructed and masked like any other.
					const ordered = allPatches.toSorted((left, right) => left.sequence - right.sequence);
					const restorePoint =
						at !== undefined && 'before' in at
							? ordered.find(
									(patch) => patch.operation === 'hold' && patch.approvalId === at.before
								)?.sequence
							: undefined;
					const patches =
						at === undefined
							? ordered
							: 'revision' in at
								? ordered.slice(0, Math.max(0, Math.trunc(at.revision)))
								: 'instant' in at
									? ordered.filter(
											(patch) =>
												new Date(patch.createdAt).getTime() <= new Date(at.instant).getTime()
										)
									: restorePoint === undefined
										? []
										: ordered.filter((patch) => patch.sequence < restorePoint);
					const projection = projectHistory({
						current: { id },
						patches,
						policy: {
							// The visibility query above is the gate; `projectHistory` re-asking it in JS
							// would be a second predicate evaluator, which the runtime does not keep.
							visible: () => true,
							mask: (values) => readAccess.mask(values)
						},
						horizon: DEFAULT_HISTORY_HORIZON
					});
					const revisions = projection._tag === 'Visible' ? projection.revisions : [];
					// A create stores the initial values and each update only the fields that changed, so
					// every entry the browser contract sees is a complete snapshot with an effective
					// interval: the slice keeps the newest revisions and the last one runs to open time.
					// An anchored read answers with the one revision that anchor names.
					const presented = presentHistoryRevisions(revisions);
					return at === undefined ? presented : presented.slice(-1);
				}
			);
			return Service.of({
				authoringCollectionNames,
				runAutomation: (effectId, name, input, scope = {}, options) =>
					startAutomation(effectId, name, input, scope, options),
				write,
				seedApply,
				findMany,
				findFirst: Effect.fn('Collections.findFirst')(function* (effectId, subject, input) {
					return (yield* findMany(effectId, subject, { ...input, limit: 1 }))[0];
				}),
				count,
				findNearest,
				embedRecords: (effectId, options) => embedRecordsService(embeddingPorts, effectId, options),
				findGrouped,
				// SyncCommit owns the unavailable-host fallback queue and the app drains it after dispatch.
				drainChanges: Effect.succeed([]),
				mutateBrowser,
				lookupBrowserMutations,
				resume,
				discard,
				/**
				 * An import is one document through the collection's `import` pipeline, whose rows are
				 * declared create inputs written like any caller's, a hundred at a time. A collection
				 * with no pipeline imports its rows directly.
				 */
				import: Effect.fn('Collections.import')(function* (effectId, subject, inputs) {
					const collection = inputs[0]?.collection ?? '';
					const declared = authored.pipelines[collection]?.import;
					const rows: ReadonlyArray<Readonly<Record<string, unknown>>> =
						declared === undefined
							? inputs.map((input) => ({ ...input.values, id: input.id }))
							: yield* Effect.gen(function* () {
									const api = authoringApi(effectId, subject);
									// The handler is given the document that was posted, not an array of them: an
									// import is one workbook whose header fields have no row to ride on.
									const produced = yield* runAuthoredHandler(() =>
										declared.handler({ input: inputs[0]?.values }, api)
									);
									if (!Array.isArray(produced))
										return yield* new AccessControl.AccessDenied({
											action: 'import',
											resource: collection,
											reason: 'import pipeline returned no rows'
										});
									for (const [index, row] of produced.entries())
										if (!isPlainRecord(row))
											return yield* new AccessControl.AccessDenied({
												action: 'import',
												resource: collection,
												reason: `import pipeline row ${index + 1} is not a record`
											});
									return produced as ReadonlyArray<Readonly<Record<string, unknown>>>;
								});
					for (let offset = 0; offset < rows.length; offset += 100)
						yield* write(EffectId.make(`${effectId}:chunk:${offset / 100}`), subject, [
							{ collection, action: 'create', inputs: rows.slice(offset, offset + 100) }
						]);
					return rows.length;
				}),
				export: Effect.fn('Collections.export')(function* (effectId, subject, input) {
					// Bound before the guard, for the reason `import` above is: the thunk defers the call past
					// the point where the narrowing holds.
					const declared = authored.pipelines[input.collection]?.export;
					if (declared !== undefined) {
						const api = authoringApi(effectId, subject);
						const records = yield* findMany(effectId, subject, input);
						return yield* runAuthoredHandler(() => declared.handler({ records }, api));
					}
					return yield* findMany(effectId, subject, input);
				}) as Interface['export'],
				history,
				audit: Effect.fn('Collections.audit')(function* (
					effectId,
					subject,
					collection,
					id,
					limit = DEFAULT_HISTORY_HORIZON
				) {
					const readAccess = yield* currentRowEntitlement(
						EffectId.make(`${effectId}:current-visibility`),
						subject,
						collection,
						id
					);
					if (readAccess === undefined) return [];
					const bounded = Math.min(DEFAULT_HISTORY_HORIZON, Math.max(1, Math.trunc(limit)));
					const auditRead = collectionAuditJoinStatement(collection, id, bounded);
					const result = yield* database.execute(effectId, {
						_tag: 'Query',
						// repository-health:allow SQL1 -- fixed system tables; collection/id/limit are bound.
						sql: auditRead.sql,
						parameters: auditRead.parameters
					});
					const rows = yield* Schema.decodeUnknownEffect(Schema.Array(PersistedCollectionAuditRow))(
						result.rows
					).pipe(
						Effect.mapError(
							() =>
								new Database.FacilityError({
									operation: 'collections.audit',
									code: 'malformed_persistence',
									message: 'Stored audit rows do not satisfy the audit projection schema',
									retryable: false,
									outcome: 'known'
								})
						)
					);
					return rows.map((row): CollectionAuditEntry => ({
						kind: row.kind,
						createdAt: row.created_at,
						actor: row.actor,
						effectId: row.effect_id,
						governingRequest: row.governing_request,
						payload: isJsonObject(row.payload) ? readAccess.mask(row.payload) : row.payload
					}));
				})
			});
		})
	);

export const layer: Layer.Layer<Interface, never, LayerServices> = layerWith();
import { inferOp } from '#lib/runtime/inference.js';
