import { deriveRecordId } from '#lib/runtime/derive-record-id.js';
import {
	DEFAULT_RECORD_EMBEDDING_DIMENSIONS,
	RECORD_EMBEDDING_COLUMN
} from '#lib/authoring/model-introspection.js';
import { emitChangeEventsMany as emitChangeEventsManyService } from '#lib/runtime/collections/services/change-events.js';
import {
	RECORD_EMBEDDING_BACKFILL_LIMIT,
	embedRecords as embedRecordsService
} from '#lib/runtime/collections/services/embeddings.js';
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
import { Cause, Clock, Deferred, Effect, Layer, Result, Schema, SchemaAST } from 'effect';
import {
	CollectionMutationBaseVersion,
	CollectionMutationIdempotencyKey,
	COLLECTION_MUTATION_RETRY_HORIZON_MILLIS,
	COLLECTION_MUTATION_QUARANTINE_RETENTION_MILLIS,
	EffectId,
	type CollectionMutateRequest,
	type CollectionMutationSettlement,
	type SyncOutcome,
	type SyncWriteStatus
} from '@norbital-ai/bolt-protocol';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as Approvals from '#lib/runtime/approvals/approvals.js';
import { ApprovalConflict } from '#lib/runtime/approvals/approvals.js';
import { refusalOf } from '#lib/authoring/refusal.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { AI, Files } from '#lib/runtime/facilities/services.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import * as Automations from '#lib/runtime/automations/automations.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import { Subject } from '#lib/runtime/identity/identity.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { describeCause } from '#lib/runtime/workspace.js';
import { AutomationProgression } from '#lib/authoring/automations-schema.js';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import { SYSTEM_COLLECTION_NAMES } from '#lib/runtime/schema/system-collections.js';
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
	WhereCompileError,
	type OrderTerm,
	type WhereContext
} from '#lib/runtime/collections/read/where.js';
import {
	SEARCH_DOCUMENT_COLUMN,
	prepareSearchPlan,
	type SearchContext,
	type SearchInput
} from '#lib/runtime/collections/read/search.js';
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
	buildOps as buildOpsService,
	buildReadOps as buildReadOpsService,
	refuseRunawayHooks as refuseRunawayHooksService,
	type HookWriteOps
} from '#lib/runtime/collections/hooks/boundary.js';
import {
	type AppliedDeclarativeGraph,
	type GraphIncludedRelationship,
	type GraphPreparedOperation
} from '#lib/runtime/collections/write/engine.js';
import { canonicalJson } from '#lib/canonical-json.js';
import { settleDeclarativeGraph as settleDeclarativeGraphService } from '#lib/runtime/collections/write/settle.js';
import { makeGraphReader, storedGraphRowKey } from '#lib/runtime/collections/write/graph-read.js';
import {
	DeclarativeReview,
	DeclarativeReviewRow,
	prepareDeclarativeGraph as prepareDeclarativeGraphService,
	reviewedRelationshipOf,
	type DeclarativeReview as DeclarativeReviewType,
	type PrepareDeclarativeGraphPorts,
	type RelationshipSnapshot
} from '#lib/runtime/collections/write/declarative-prepare.js';
import { writeRecordKey, type WritableManyRelation } from '#lib/runtime/collections/write/plan.js';
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
	MutationIdempotencyConflict,
	MutationInProgress,
	type MutationError,
	type MutationInput,
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
	CollectionAuditEntry,
	CollectionHistorySnapshot,
	MutationError,
	MutationInput,
	MutationPhase,
	QueryError,
	NearestQueryInput,
	QueryInput,
	QueryRow,
	ResumeError
} from './collections.contract.js';
import { collectionQueryTable, relationalSchema } from '#lib/compiler/relational-schema.js';
import {
	decodeReferenceRow,
	encodeReferenceValues,
	referenceValueProblem
} from '#lib/runtime/collections/references.js';
import {
	afterMillisOf,
	AuthoredRuntimeService,
	guardAuthoringOps,
	inferOp,
	makeAutomationApi,
	makeAuthoringApi,
	makePolicyDecisionApi,
	runAuthoredHandler,
	type AuthoringOps,
	type AuthoredCollectionHookModule
} from '#lib/runtime/collections/authored.js';
import { readFileAsset } from '#lib/runtime/collections/file-assets.js';
import { AuthoredRefusal, refusalAt, type RefusalSite } from '#lib/authoring/refusal.js';
import * as InvocationBudget from '#lib/runtime/budget.js';
import { approvalFlowDescriptor } from '#lib/authoring/approval-flow.js';
import { approvalStepId } from '#lib/authoring/policy-introspection.js';
import {
	aliased,
	always,
	composer,
	dbNow,
	executeBuilt,
	lessThanOrEqual,
	relationalComposer,
	toStatement,
	transactionSql,
	vectorDistance,
	type RelationalBuilder
} from '#lib/runtime/persistence.js';

const {
	bolt_collection_history: collectionHistoryTable,
	bolt_integration_outbox: integrationOutboxTable,
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
	Effect.promise(async () => {
		const digest = await globalThis.crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(value)
		);
		return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
/**
 * Drizzle's connectionless `toSQL()` does not run a JSONB column's driver encoder.
 *
 * The facility receives plain parameters rather than a Drizzle session, so JSON values must cross
 * this boundary as JSON text. PostgreSQL then parses the bound text using the target JSONB column's
 * type. SQL null stays null; a JSON null is not used by these bookkeeping rows.
 */
const encodedJsonb = (value: Exclude<Schema.Json, null>): string => JSON.stringify(value);

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
const StoredEngineApprovalGraph = Schema.Struct({
	version: Schema.Literal(1),
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	action: CollectionAction,
	payload: JsonObject,
	browserMutation: Schema.optionalKey(StoredBrowserMutationFence)
});

/** Internal preparation signal: the whole root graph must be stored as one approval operation. */
class GraphApprovalRequired extends Schema.TaggedError<GraphApprovalRequired>()(
	'Bolt.Collections.GraphApprovalRequired',
	{
		collection: Schema.NonEmptyString,
		action: CollectionAction,
		approval: Schema.optionalKey(Schema.Json),
		review: DeclarativeReview,
		coordinates: Schema.Array(
			Schema.Struct({ collection: Schema.NonEmptyString, id: Schema.NonEmptyString })
		)
	}
) {}

/** Owns identifier safety for collection-generated SQL. */
const CollectionSql = {
	quoteIdentifier: (name: string): string => `"${name.replaceAll('"', '""')}"`
};
const quoteIdentifier = CollectionSql.quoteIdentifier;

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
					`insert into ${quoteIdentifier(first.table)} (${columns}) select ${tuple(first, 0)} where ${first.where.sql}`,
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

/**
 * `AuthoredRefusal` is a member of all three channels because authored code runs on all three
 * paths: hooks on every mutation, the import pipeline under `import`, the export pipeline under
 * `export`, and `mutate.after` again when an approval resumes. It is stated rather than left to
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
 * Resolves one query's SQL predicate from its authored `where`, narrowed by the generic surface's
 * `userFilter` when one is present. Compilation failure is raised here so every read path reports
 * the offending column rather than running a widened query.
 */
const compiledFilter = (
	input: QueryInput,
	context: WhereContext
): Effect.Effect<SQL, WhereCompileError> => {
	const authored =
		input.where === undefined ? Result.succeed(sql`true`) : compileWhere(input.where, context);
	if (Result.isFailure(authored)) return Effect.fail(authored.failure);
	if (input.userFilter === undefined) return Effect.succeed(authored.success);
	const narrowed = compileWhere(input.userFilter, context);
	return Result.isFailure(narrowed)
		? Effect.fail(narrowed.failure)
		: Effect.succeed(and(authored.success, narrowed.success) ?? authored.success);
};

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
			const authoringCollectionNames = new Set([
				...workspace.definition.collections
					.map(({ name }) => name)
					.filter((name) => !SYSTEM_COLLECTION_NAMES.has(name)),
				'approval_request'
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
				'collections.mutate',
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
						typeof retryAfter === 'number' && Number.isInteger(retryAfter) && retryAfter > 0
							? retryAfter
							: 1
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
						'collections.mutate',
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
			 * Typed as a `string` scalar carrying its own `sqlType`, which is how every other vector
			 * column in this codebase is described: the scalar kind is what queries and access masking
			 * reason about, and `vector(n)` is what the database is told.
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
						type: 'string',
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
				[...new Set(integrations)].toSorted().map((integration) =>
					toStatement(
						composer
							.insert(boltTaskTable)
							.values({
								command: 'integrations.flush',
								input: JSON.stringify({ name: integration }),
								effect_id: `${effectId}:flush:${integration}`,
								run_at: dbNow(),
								status: 'running'
							})
							.onConflictDoNothing({ target: boltTaskTable.effect_id })
							.toSQL()
					)
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
			const embeddingPorts = {
				database,
				ai,
				collections: workspace.definition.collections,
				readAsset: (effectId: EffectId, file: Record<string, unknown>) =>
					readFileAsset(effectId, files, file)
			};
			/**
			 * Runs one authored hook handler with its context object, resolving Effect, promise, and plain
			 * results alike, and stamping a refusal it raised with where it was raised.
			 *
			 * The handler is passed as a thunk rather than called here, so a plain synchronous handler —
			 * the common case — that throws in `refuse` throws *inside* `runAuthoredHandler`, where the
			 * throw is caught and lands in the refusal channel instead of escaping as an
			 * `ExecutionFailure` nothing downstream can classify.
			 *
			 * `site` names the collection and the phase, because a refusal cannot: `refuse` takes a
			 * sentence and nothing else, and the author writing it is inside one hook and has no reason to
			 * repeat which one. `action` carries the qualified phase — `mutate.before`, `delete.after` —
			 * rather than the bare action, because the two halves mean different things to whoever reads
			 * the failure. A `before` refusal means nothing was written; an `after` refusal means the write
			 * already happened and is being reported, not undone.
			 */
			const runHook = (
				hook: { readonly handler: (context: unknown) => unknown } | undefined,
				context: unknown,
				site: RefusalSite
			): Effect.Effect<unknown, AuthoredRefusal> => {
				if (hook === undefined) return Effect.succeed(undefined);
				return runAuthoredHandler<unknown>(() => hook.handler(context)).pipe(
					Effect.catch((refusal) => Effect.fail(refusalAt(refusal, site)))
				);
			};
			const authoringReadPorts = {
				allowedCollections: authoringCollectionNames,
				get findMany() {
					return findMany;
				},
				get count() {
					return count;
				},
				get findNearest() {
					return findNearest;
				}
			};
			const authoringWritePorts = (effectId: EffectId) => ({
				...authoringReadPorts,
				mutate,
				startAutomation,
				infer: inferOp(effectId, ai, (file) => readFileAsset(effectId, files, file)),
				readFileAsset: (file: Parameters<AuthoringOps['readFileAsset']>[0]) =>
					readFileAsset(effectId, files, file)
			});
			const authoringApi = (
				effectId: EffectId,
				subject: Identity.Subject,
				elevated = false,
				depth = 0,
				staged?: HookWriteOps
			) =>
				makeAuthoringApi(
					buildOpsService(authoringWritePorts(effectId), effectId, subject, elevated, depth, staged)
				);
			const authoringReadOps = (effectId: EffectId, subject: Identity.Subject) =>
				buildReadOpsService(authoringReadPorts, effectId, subject);

			const AutomationExecutionInput = Schema.Struct({
				args: Schema.Json,
				scope: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
				bolt_run_as: Subject,
				bolt_depth: Schema.optionalKey(
					Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
				)
			});
			const runAutomationBody = Effect.fn('Collections.runAutomationBody')(function* (
				name: string,
				taskId: string,
				raw: Schema.Json,
				attemptEffectId: string
			) {
				const declaration = authored.automations[name];
				if (declaration === undefined) {
					return yield* new AuthoredRefusal({ message: `Automation ${name} is not declared.` });
				}
				const admitted = yield* Schema.decodeUnknownEffect(AutomationExecutionInput)(raw);
				const turnEffectId = EffectId.make(attemptEffectId);
				const guard = Automations.stoppageGuard(automations, turnEffectId, taskId);
				const api = makeAutomationApi(
					makeAuthoringApi(
						guardAuthoringOps(
							buildOpsService(
								authoringWritePorts(turnEffectId),
								turnEffectId,
								admitted.bolt_run_as,
								false,
								0,
								undefined,
								admitted.bolt_depth
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
						)
				);
				const args = yield* Schema.decodeUnknownEffect(declaration.input ?? Schema.Json)(
					admitted.args
				);
				const output = yield* runAuthoredHandler(() =>
					declaration.handler(api, { args, scope: admitted.scope ?? {} })
				);
				const declaredOutput = yield* Schema.decodeUnknownEffect(
					declaration.output ?? Schema.Unknown
				)(output);
				return yield* Schema.decodeUnknownEffect(Schema.Json)(declaredOutput);
			});
			/**
			 * Admits and immediately executes one automation unless the caller explicitly supplied a delay.
			 * The durable row is lifecycle/input state; this Effect remains the sole owner of the body.
			 */
			const startAutomation = Effect.fn('Collections.startAutomation')(function* (
				effectId: EffectId,
				name: string,
				input: Schema.Json,
				scope: Readonly<Record<string, Schema.Json>>,
				options?: Readonly<{
					readonly after?: string | number;
					readonly taskId?: string;
					readonly parentDepth?: number;
				}>
			) {
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
					...(options?.parentDepth === undefined ? {} : { parentDepth: options.parentDepth })
				});
				if (afterMillis > 0) return { taskId };
				yield* automations.execute(
					EffectId.make(`${effectId}:execute`),
					name,
					taskId,
					(raw, attemptEffectId) => runAutomationBody(name, taskId, raw, attemptEffectId)
				);
				return { taskId };
			});
			const changeEventPorts = {
				automations,
				authored: authored.automations,
				runBody: runAutomationBody
			};
			/**
			 * Decodes one payload through the collection's declared input, if it has one.
			 *
			 * **One decode, because there is one input.** `input` binds the collection's own shape,
			 * which is what lets it type `api.db.x.mutate` and `client.db.x.mutate` from the same
			 * declaration the runtime enforces.
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
			 * It is not a second place to write the rule. A duplicate batch rule was once declared,
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
				const api = authoringApi(effectId, subject, false, depth + 1, staged);
				return yield* runAuthoredHandler(() => prepare({ inputs, api })).pipe(
					Effect.mapError((cause) => refusalAt(cause, { collection, action: 'mutate.prepare' }))
				);
			});
			/**
			 * The one per-record rule, for the one write.
			 *
			 * `existing` is what tells a create from an update, and it is the same fact the runtime
			 * decided the operation from a moment earlier — the stored row this write lands on, or
			 * `undefined` because there is not one yet. Every hook answers the same question from the
			 * same fact, which is why their return types cannot drift apart while the runtime splits a
			 * graph out of both.
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
				const api = authoringApi(effectId, subject, false, depth + 1, staged);
				// Already decoded by the caller. `prepare` sees the batch's inputs and the handler sees one
				// of them, and they must be the same shape — a collection declaring two fields where the
				// table has twenty would otherwise hand its batch read the raw payload and its handler the
				// decoded one.
				const values = input.values;
				const before = yield* runHook(
					module?.mutate?.perRecord?.before,
					{ input: values, existing, prepared, api },
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
						Effect.map(
							ai.execute(EffectId.make(`${effectId}:semantic-query`), {
								_tag: 'Embed',
								model: definition.embedding?.model ?? 'default',
								inputs: [{ content: [{ type: 'text', text: term }] }],
								...(definition.embedding?.dimensions === undefined
									? {}
									: { dimensions: definition.embedding.dimensions })
							}),
							(response) => {
								const output = response.output;
								return Array.isArray(output) && Array.isArray(output[0])
									? (output[0] as ReadonlyArray<number>)
									: [];
							}
						)
					);
				const planned = yield* Effect.promise(() => prepareSearchPlan(input, context, embed));
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
				const context = makeWhereContext(
					input.collection,
					definition.fields,
					workspace.definition,
					qualifier
				);
				return {
					definition,
					policy,
					context,
					compiled: yield* compiledFilter(input, context),
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
							executeBuilt(effectId, database, statement).pipe(Effect.map((result) => result.rows))
					},
					collection,
					config
				);
			const findMany: Interface['findMany'] = Effect.fn('Collections.findMany')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				input: QueryInput
			) {
				const { context, policy, compiled, searched, visibility } = yield* prepareRead(
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
				const ordering = compileOrderTerms(input.orderBy, context);
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
							AccessControl.predicateExpression(visibility),
							seek
						) ?? always(),
					ordering,
					searchOrdering:
						searched.mode === 'lexical'
							? desc(searched.rank)
							: searched.mode === 'semantic'
								? asc(searched.distance)
								: undefined,
					limit: Math.max(1, input.limit ?? 100),
					with: input.with,
					columns: input.columns
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
				const context = makeWhereContext(input.collection, definition.fields, workspace.definition);
				const compiled = yield* compiledFilter(input, context);
				const visibility = readAccess.predicate;
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
						...policy.mask(
							subject,
							'read',
							input.collection,
							decodeReferenceRow(record, definition.fields)
						),
						distance: typeof measured === 'number' ? measured : Number(measured ?? Number.NaN)
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
				readonly effectId: EffectId;
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
				nodes: ReadonlyArray<CreateStatementNode>,
				governingApprovalRequest?: string
			): ReadonlyArray<{
				readonly sql: string;
				readonly parameters: ReadonlyArray<Schema.Json>;
			}> => {
				const records: Array<PlannedInsert> = [];
				const bookkeeping: Array<PlannedInsert> = [];
				const integrations: Array<string> = [];
				const bookkeepingLayer =
					nodes.reduce((highest, node) => Math.max(highest, node.layer), 0) + 1;
				for (const { input, effectId: nodeEffectId, definition, visibility, layer } of nodes) {
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
					const unconditional = AccessControl.predicateIsUnrestricted(visibility);
					const predicate = AccessControl.predicateStatement(visibility, {
						parameterOffset: columnValues.length
					});
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
						...(unconditional ? {} : { where: predicate })
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
					// A guarded row is a group of one, like the record it follows, so a predicated batch
					// writes its bookkeeping per row instead of merged. That is the price of the guard and
					// it is paid only where a predicate exists: an elevated or unrestricted write carries
					// no `where` at all and its bookkeeping merges exactly as it did.
					//
					// The placeholder is numbered per row, because a `where` is appended after the row's
					// own column parameters and shares one list with them. A fixed `$1` addressed the
					// bookkeeping row's first column instead of the record id, so the guard asked whether
					// a record named `bolt_collection_history` existed.
					const follows = (row: PlannedInsert): PlannedInsert =>
						unconditional
							? row
							: {
									...row,
									where: transactionSql(
										`exists (select 1 from ${quoteIdentifier(input.collection)} where id = $${row.columns.length + 1})`,
										[input.id]
									)
								};
					if (definition.history)
						bookkeeping.push(
							follows({
								table: 'bolt_collection_history',
								layer: bookkeepingLayer,
								columns: [
									'collection_name',
									'record_id',
									'operation',
									'subject_id',
									'effect_id',
									'approval_id',
									'snapshot'
								],
								parameters: [
									input.collection,
									input.id,
									'create',
									subject.userId,
									nodeEffectId,
									governingApprovalRequest ?? null,
									values
								]
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
				_visibility: AccessControl.RowPredicate,
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
										effect_id: effectId,
										approval_id: governingRequest(previous),
										snapshot: encodedJsonb(values)
									})
									.toSQL()
							)
						]
					: [];
				return [
					transactionSql(
						`update ${quoteIdentifier(input.collection)} set ${assignments.join(', ')} where id = $${entries.length + 1}`,
						[...entries.map(([name, value]) => boundParameter(definition, name, value)), input.id]
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
			/** The delete twin of `updateStatements`, shared by single-row and graph execution. */
			const deleteStatements = (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				id: string,
				definition: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>,
				_visibility: AccessControl.RowPredicate,
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
										effect_id: effectId,
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
					transactionSql(`delete from ${quoteIdentifier(collection)} where id = $1`, [id]),
					...history,
					...outboxStatements(effectId, subject, collection, id, 'delete', {}, previous)
				];
			};
			/**
			 * Releases only the exact lock owned by a refused canonical approval request.
			 */
			const releaseLock = Effect.fn('Collections.releaseLock')(function* (
				effectId: EffectId,
				collection: string,
				id: string,
				requestId: string
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
						.where(and(eq(columns['approval_id']!, requestId), eq(columns['id']!, id)))
						.returning({ record_id: columns['id']! })
				);
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
				const included: Array<GraphIncludedRelationship> = [];
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

			type GraphWaveReadError = Database.FacilityError | Workspace.WorkspaceLookupError;
			type GraphPrepareError =
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
				| InvocationBudget.NestingLimitExceeded;
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

			/** Translates the compiled statement plan into the one transaction that applies it. */
			const applyDeclarativeGraph = Effect.fn('Collections.applyDeclarativeGraph')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				statementPlan: WriteStatementPlan,
				relationshipSnapshots: ReadonlyArray<RelationshipSnapshot>,
				elevated: boolean,
				browserMutation?: BrowserMutationFence,
				approvalRequestId?: string,
				approvalRoot?: Readonly<{
					readonly collection: string;
					readonly id: string;
					readonly action: typeof CollectionAction.Type;
				}>
			) {
				const operations = statementPlan.operations;
				const effectiveVisibility = (operation: GraphPreparedOperation) =>
					elevated ? AccessControl.unrestricted : operation.visibility;

				const creates = operations.filter((operation) => operation.action === 'create');
				const existingOperations = operations.filter(
					(operation) => operation.action === 'update' || operation.action === 'delete'
				);
				const createLayers = insertionLayers(creates, workspace.definition);
				const layerByKey = new Map(
					creates.map((operation, index) => [
						writeRecordKey({ collection: operation.collection, recordId: operation.id }),
						createLayers[index] ?? 0
					])
				);
				const createNodeFor = (operation: GraphPreparedOperation): CreateStatementNode => ({
					input: {
						collection: operation.collection,
						id: operation.id,
						values: operation.values
					},
					effectId: operation.taskScope,
					definition: operation.definition,
					visibility: AccessControl.unrestricted,
					layer:
						layerByKey.get(
							writeRecordKey({ collection: operation.collection, recordId: operation.id })
						) ?? 0
				});
				for (const operation of operations)
					yield* announceFlush(effectId, operation.collection, operation.action);
				/**
				 * Every sentence a policy guard in this transaction may raise, and whose refusal it is.
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
				const assertionStatement = (expectation: PredicateAssertionExpectation) => {
					const operation = expectation.operation;
					const predicate = AccessControl.predicateStatement(effectiveVisibility(operation), {
						parameterOffset: 1
					});
					const messageIndex = predicate.parameters.length + 2;
					const message =
						expectation.timing === 'after-insert'
							? `${operation.collection} ${operation.id} is outside the create predicate`
							: `${operation.collection} ${operation.id} is absent or outside the mutation predicate`;
					predicateGuards.set(message, {
						collection: operation.collection,
						action: operation.action
					});
					return transactionSql(
						expectation.timing === 'after-insert'
							? `select bolt_assert(exists(select 1 from ${quoteIdentifier(operation.collection)} where id = $1 and (${predicate.sql})), $${messageIndex})`
							: `select bolt_assert((select count(*) = 1 from (select id from ${quoteIdentifier(operation.collection)} where id = $1 and (${predicate.sql}) for update) as bolt_authorized_row), $${messageIndex})`,
						[operation.id, ...predicate.parameters, message]
					);
				};
				// Approval review rows are masked for storage/display. Concurrency assertions must use the
				// freshly prepared elevated snapshots, never those deliberately narrowed review values.
				const reviewedRows = existingOperations.flatMap((operation) =>
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
				const relationshipAssertions = relationshipSnapshots
					.map(reviewedRelationshipOf)
					.map((snapshot) =>
						transactionSql(
							`select bolt_assert((select coalesce(jsonb_agg(to_jsonb(child) order by child.id), '[]'::jsonb) from ${quoteIdentifier(snapshot.childCollection)} as child where ${quoteIdentifier(snapshot.childColumn)} = $1) = $2::jsonb, $3)`,
							[
								snapshot.parentId,
								snapshot.snapshot,
								`${snapshot.childCollection} membership changed while ${snapshot.parentCollection} ${snapshot.parentId} was prepared`
							]
						)
					);
				const capturedOperations = operations.filter(
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
				const historyPrunes = historyPruneStatements(operations).map((statement) =>
					transactionSql(statement.sql, statement.parameters)
				);
				const statements: Array<{
					readonly sql: string;
					readonly parameters: ReadonlyArray<Schema.Json>;
				}> = [];
				if (browserMutation !== undefined) {
					if (approvalRequestId !== undefined && approvalRoot !== undefined)
						statements.push(
							browserMutationApprovalGuardStatement(
								browserMutation,
								approvalRequestId,
								approvalRoot.collection,
								approvalRoot.id,
								approvalRoot.action
							)
						);
				}
				for (const table of statementPlan.collections)
					statements.push(
						transactionSql(`lock table ${quoteIdentifier(table)} in share row exclusive mode`)
					);
				for (const expectation of statementPlan.before)
					statements.push(assertionStatement(expectation));
				statements.push(...recordAssertions, ...relationshipAssertions);
				for (const operation of operations) {
					if (operation.action === 'delete')
						statements.push(
							...deleteStatements(
								operation.taskScope,
								subject,
								operation.collection,
								operation.id,
								operation.definition,
								effectiveVisibility(operation),
								operation.previous
							)
						);
					if (
						operation.action === 'update' &&
						(Object.keys(operation.values).length > 0 || operation.clearLock === true)
					)
						statements.push(
							...updateStatements(
								operation.taskScope,
								subject,
								{
									collection: operation.collection,
									id: operation.id,
									values: operation.values
								},
								operation.definition,
								effectiveVisibility(operation),
								operation.clearLock === true,
								operation.previous
							)
						);
				}
				if (creates.length > 0)
					statements.push(
						...createStatements(effectId, subject, creates.map(createNodeFor), approvalRequestId)
					);
				for (const expectation of statementPlan.after)
					statements.push(assertionStatement(expectation));
				statements.push(...historyPrunes);
				if (statementPlan.claimLedger && browserMutation !== undefined)
					statements.push(
						approvalRequestId === undefined || approvalRoot === undefined
							? browserMutationClaimStatement(browserMutation)
							: browserMutationApprovalTerminalStatement(
									browserMutation,
									approvalRequestId,
									approvalRoot.collection,
									approvalRoot.id,
									approvalRoot.action,
									browserMutation.outcome
								)
					);
				statements.push(captureStatement);
				const result = yield* database.execute(effectId, { _tag: 'Transaction', statements }).pipe(
					Effect.catch((error): Effect.Effect<never, Database.FacilityError | AuthoredRefusal> => {
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
				return { operations, records } satisfies AppliedDeclarativeGraph;
			});

			type GraphApprovalContext = Readonly<{
				readonly approved: boolean;
				readonly clearRootLock?: boolean;
				readonly approvalRequestId?: string;
				readonly expectedReview?: string;
				readonly browserMutation?: BrowserMutationFence;
			}>;

			const gateGraphApproval = Effect.fn('Collections.gateGraphApproval')(function* (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				rootId: string,
				rootAction: typeof CollectionAction.Type,
				rootValues: Readonly<Record<string, unknown>>,
				cause: GraphApprovalRequired,
				browserMutation?: BrowserMutationFence
			) {
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
				const requestId = Approvals.approvalRequestId(
					{ collection, id: rootId, action: rootAction },
					effectId
				);
				const reviewRows: ReadonlyArray<typeof DeclarativeReviewRow.Type> =
					rootAction === 'create'
						? cause.review.rows
						: yield* Effect.forEach(
								cause.review.rows,
								(row): Effect.Effect<typeof DeclarativeReviewRow.Type, ApprovalConflict> => {
									if (row.collection !== collection || row.id !== rootId)
										return Effect.succeed(row);
									return Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(
										row.snapshot
									).pipe(
										Effect.map((snapshot) => ({
											...row,
											snapshot: JSON.stringify({ ...snapshot, approval_id: requestId })
										})),
										Effect.mapError(
											() =>
												new ApprovalConflict({
													requestId,
													reason: 'prepared approval review contains an invalid row snapshot'
												})
										)
									);
								}
							);
				const review: DeclarativeReviewType =
					rootAction === 'create' ? cause.review : { ...cause.review, rows: [...reviewRows] };
				const decision = yield* approvals.gate({
					effectId,
					subject,
					root: { collection, id: rootId, action: rootAction },
					storedGraph: {
						version: 1,
						collection,
						id: rootId,
						action: rootAction,
						payload: values,
						...(browserMutation === undefined ? {} : { browserMutation })
					},
					proposedValues: values,
					approval: cause.approval,
					review
				});
				if (decision._tag !== 'Hold')
					return yield* new ApprovalConflict({
						requestId: rootId,
						reason: 'approval gate unexpectedly proceeded without an approved re-entry'
					});
				return decision.requestId;
			});

			type MutationOptions = Readonly<{
				readonly root?: Readonly<{
					readonly id: string;
					readonly action: typeof CollectionAction.Type;
				}>;
				readonly roots?: ReadonlyArray<
					Readonly<{
						readonly collection?: string;
						readonly id: string;
						readonly action: typeof CollectionAction.Type;
					}>
				>;
				readonly browserMutation?: BrowserMutationFence;
				readonly approval?: GraphApprovalContext;
				readonly expectedRootVersion?: number;
			}>;

			const mutate: (
				effectId: EffectId,
				subject: Identity.Subject,
				collection: string,
				payloads: ReadonlyArray<Readonly<Record<string, unknown>>>,
				elevated: boolean,
				depth: number,
				options?: MutationOptions
			) => Effect.Effect<CollectionMutationCommit, BatchMutationError | BrowserMutationReplay> =
				Effect.fn('Collections.mutate')(function* (
					effectId: EffectId,
					subject: Identity.Subject,
					collection: string,
					payloads: ReadonlyArray<Readonly<Record<string, unknown>>>,
					elevated: boolean,
					depth: number,
					options?: MutationOptions
				) {
					yield* refuseRunawayHooksService('mutate', collection, depth);
					yield* workspace.collection(collection);
					const explicitRoot = payloads.length === 1 ? options?.root : undefined;
					const explicitRoots =
						options?.roots?.length === payloads.length ? options.roots : undefined;
					if (options?.approval?.approved === true && payloads.length !== 1)
						return yield* graphRefusal(
							collection,
							explicitRoot?.action ?? 'update',
							'An approved mutation re-entry must contain exactly one stored root.'
						);
					// Field grants are enforced once, per node, inside `prepareGraphNode` — `policy.write`
					// refuses any submitted field the matching grant does not name, for creates and updates
					// alike, on the caller-owned shape and before authored code sees it. There is no second,
					// pre-engine validation walk beside it.
					if (options?.browserMutation !== undefined && payloads.length !== 1)
						return yield* graphRefusal(
							collection,
							'create',
							'A browser mutation must contain exactly one declarative root.'
						);
					const roots = payloads.map((payload, index) => {
						const submittedId = payload['id'];
						const rootCollection = explicitRoots?.[index]?.collection ?? collection;
						const rootAction =
							explicitRoot?.action ??
							explicitRoots?.[index]?.action ??
							(typeof submittedId === 'string' ? 'update' : 'create');
						const rootId =
							explicitRoot?.id ??
							explicitRoots?.[index]?.id ??
							(typeof submittedId === 'string'
								? submittedId
								: deriveRecordId(`${rootCollection}:${effectId}:root:${index}`));
						const rootEffectId =
							payloads.length === 1 ? effectId : EffectId.make(`${effectId}:root:${index}`);
						return {
							collection: rootCollection,
							payload: { ...payload, id: rootId },
							rootId,
							rootAction,
							rootEffectId
						};
					});
					const firstRoot = roots[0];
					if (firstRoot === undefined) return { records: [], changes: [] };
					const browserMutation = options?.approval?.browserMutation ?? options?.browserMutation;

					const preparedGraphs: Array<{
						readonly collection: string;
						readonly rootId: string;
						readonly operations: ReadonlyArray<GraphPreparedOperation>;
						readonly relationshipSnapshots: ReadonlyArray<RelationshipSnapshot>;
						readonly approval?: Schema.Json;
						readonly review?: DeclarativeReviewType;
					}> = [];
					const heldApprovals = new Map<
						string,
						Readonly<{
							readonly root: (typeof roots)[number];
							readonly cause: GraphApprovalRequired;
						}>
					>();
					const heldRequestIds = new Map<string, string>();
					const readSession = graphReads.session(
						effectId,
						roots.map((root) => root.rootId)
					);
					let applied: AppliedDeclarativeGraph | undefined;
					let settled: ReadonlyMap<string, Readonly<Record<string, unknown>>> = new Map();
					type LifecycleError = BatchMutationError | BrowserMutationReplay;
					const lifecycleError = <A, E extends LifecycleError, R>(
						effect: Effect.Effect<A, E, R>
					): Effect.Effect<A, LifecycleError, R> => effect as Effect.Effect<A, LifecycleError, R>;
					const groupsByCollection = new Map<string, Array<(typeof roots)[number]>>();
					for (const root of roots) {
						const group = groupsByCollection.get(root.collection) ?? [];
						group.push(root);
						groupsByCollection.set(root.collection, group);
					}
					const lifecycle = Effect.gen(function* () {
						// One deduplicated facility query returns every root's stored pre-image (or absence).
						// Preparation reuses the shared-session cache rather than reading those roots again.
						const readRootGroup = (
							groupCollection: string,
							groupRoots: ReadonlyArray<(typeof roots)[number]>
						) =>
							lifecycleError(
								Effect.gen(function* () {
									const stored = yield* graphReads.read(
										EffectId.make(`${effectId}:write-wave:${depth}:${groupCollection}`),
										groupRoots.map((root) => ({
											collection: root.collection,
											id: root.rootId
										})),
										[]
									);
									for (const [key, row] of stored.stored) readSession.storedRows.set(key, row);
								})
							);
						const prepareRootGroup = (groupRoots: ReadonlyArray<(typeof roots)[number]>) =>
							lifecycleError(
								Effect.gen(function* () {
									const rootPreparation = yield* Deferred.make<unknown, AuthoredRefusal>();
									readSession.batch.participants.clear();
									for (const root of groupRoots) readSession.batch.participants.set(root.rootId, 0);
									readSession.batch.completed.clear();
									const outcomes = yield* Effect.forEach(
										groupRoots,
										(root) =>
											Effect.gen(function* () {
												const key = writeRecordKey({
													collection: root.collection,
													recordId: root.rootId
												});
												const policy = access.invocation();
												const outcome = yield* prepareDeclarativeGraphService<
													GraphPrepareError,
													GraphWaveReadError,
													never
												>(
													{
														workspace,
														authoredHooks: authored.hooks,
														policyWrite: (writeSubject, action, writeCollection, row, elevation) =>
															policy.write(writeSubject, action, writeCollection, row, elevation),
														resolveWritableManyRelation,
														graphRefusal,
														assertBrowserBaseVersion,
														buildApi: authoringApi,
														runHook,
														authorizePolicyWrite,
														resolveApproval,
														queuedGraphWaveRead: graphReads.queued,
														splitGraphPayload,
														decodeMutateInput,
														encodeMutationValues,
														referenceValueProblem,
														runMutateBefore,
														runMutatePrepare,
														randomId,
														refuseRunawayHooks: refuseRunawayHooksService,
														deriveRecordId,
														predicateStatement: AccessControl.predicateStatement,
														approvalFingerprint: Approvals.approvalFingerprint,
														approvalRouteFingerprint: Approvals.approvalRouteFingerprint,
														approvalConflict: (requestId, reason) =>
															new ApprovalConflict({ requestId, reason }),
														versionConflict: (versionCollection, id, baseVersion, currentVersion) =>
															new MutationVersionConflict({
																collection: versionCollection,
																id,
																baseVersion,
																currentVersion
															}),
														approvalRequired: (required) =>
															Effect.fail(
																new GraphApprovalRequired({
																	...required,
																	review: {
																		...required.review,
																		rows: [...required.review.rows],
																		relationships: [...required.review.relationships]
																	},
																	coordinates: [...required.coordinates]
																})
															)
													} as PrepareDeclarativeGraphPorts<
														GraphPrepareError,
														GraphWaveReadError,
														never
													>,
													root.rootEffectId,
													subject,
													root.collection,
													root.payload,
													depth,
													{
														approved: options?.approval?.approved === true,
														elevated,
														rootId: root.rootId,
														rootAction: root.rootAction,
														clearRootLock: options?.approval?.clearRootLock === true,
														...(options?.approval?.approvalRequestId === undefined
															? {}
															: { approvalRequestId: options.approval.approvalRequestId }),
														...(browserMutation === undefined ? {} : { browserMutation }),
														...(options?.expectedRootVersion === undefined
															? {}
															: { expectedRootVersion: options.expectedRootVersion }),
														readSession,
														primeRoots: groupRoots.map((candidate) => ({
															collection: candidate.collection,
															payload: candidate.payload,
															id: candidate.rootId,
															action: candidate.rootAction
														})),
														rootPreparation
													}
												).pipe(
													Effect.map((prepared) => ({ _tag: 'Prepared' as const, prepared })),
													Effect.catchTag('Bolt.Collections.GraphApprovalRequired', (cause) =>
														options?.approval?.approved === true
															? graphRefusal(
																	root.collection,
																	root.rootAction,
																	'An approved mutation graph unexpectedly requested another approval.'
																)
															: Effect.succeed({ _tag: 'Held' as const, cause })
													),
													Effect.catchCause((cause) => {
														const failure = Cause.squash(cause);
														return Effect.fail(
															failure instanceof BrowserMutationReplay
																? failure
																: mutationPhaseFailure('prepare', root.collection, [], failure)
														);
													})
												);
												return { key, root, outcome };
											}).pipe(
												Effect.ensuring(graphReads.complete(readSession, root.rootId)),
												// Root preparation now runs in child fibers. Keep the facility service in
												// each child's Effect context as well as the layer closure so any authored,
												// policy, approval, or wave-read Effect that resolves it dynamically sees
												// the same invocation-bound database binding as the caller.
												Effect.provideService(Database.Service, database)
											),
										{ concurrency: 'unbounded' }
									);
									for (const { key, root, outcome } of outcomes) {
										if (outcome._tag === 'Held')
											heldApprovals.set(key, { root, cause: outcome.cause });
										else if (outcome.prepared !== undefined)
											// The preparation deferred-join can type its shared result as `void | graph`;
											// only the graph form is ever stored, and only graphs reach COMMIT.
											preparedGraphs.push(outcome.prepared);
									}
								})
							);
						const gatePreparedGraphs = () =>
							Effect.gen(function* () {
								const coordinates = new Set<string>();
								const allCoordinates = [
									...preparedGraphs.flatMap((graph) =>
										graph.operations.map((operation) => ({
											collection: operation.collection,
											id: operation.id,
											action: operation.action
										}))
									),
									...[...heldApprovals.values()].flatMap(({ root, cause }) =>
										cause.coordinates.map((coordinate) => ({
											...coordinate,
											action: root.rootAction
										}))
									)
								];
								for (const operation of allCoordinates) {
									const coordinate = writeRecordKey({
										collection: operation.collection,
										recordId: operation.id
									});
									if (coordinates.has(coordinate))
										return yield* graphRefusal(
											operation.collection,
											operation.action,
											`The mutation graph names ${operation.collection} ${operation.id} more than once.`
										);
									coordinates.add(coordinate);
								}
								if (options?.approval?.approved === true) {
									const graph = preparedGraphs[0];
									const root = roots[0];
									if (
										graph === undefined ||
										root === undefined ||
										graph.review === undefined ||
										options.approval.approvalRequestId === undefined ||
										options.approval.expectedReview === undefined
									)
										return yield* new ApprovalConflict({
											requestId: options.approval.approvalRequestId ?? root?.rootId ?? collection,
											reason: 'approved mutation re-entry is missing its request or review plan'
										});
									const proposedValues = Object.fromEntries(
										Object.entries(root.payload).filter(([name]) => name !== 'id')
									) as Readonly<Record<string, Schema.Json>>;
									const decision = yield* approvals.gate({
										effectId: root.rootEffectId,
										subject,
										root: {
											collection: root.collection,
											id: root.rootId,
											action: root.rootAction
										},
										storedGraph: null,
										proposedValues,
										approval: graph.approval,
										review: graph.review,
										approved: {
											requestId: options.approval.approvalRequestId,
											expectedReview: options.approval.expectedReview
										}
									});
									if (
										decision._tag !== 'Proceed' ||
										decision.governingRequest !== options.approval.approvalRequestId
									)
										return yield* new ApprovalConflict({
											requestId: options.approval.approvalRequestId,
											reason: 'approved mutation did not re-enter its governing approval request'
										});
									return;
								}
								for (const root of roots) {
									const key = writeRecordKey({
										collection: root.collection,
										recordId: root.rootId
									});
									const held = heldApprovals.get(key);
									if (held === undefined) continue;
									const values = Object.fromEntries(
										Object.entries(root.payload).filter(([name]) => name !== 'id')
									);
									const requestId = yield* gateGraphApproval(
										root.rootEffectId,
										subject,
										root.collection,
										root.rootId,
										root.rootAction,
										values,
										held.cause,
										browserMutation
									);
									heldRequestIds.set(key, requestId);
								}
							});
						const commitPreparedGraphs = () =>
							lifecycleError(
								Effect.gen(function* () {
									if (preparedGraphs.length === 0) return;
									const approvedRoot = options?.approval?.approved === true ? roots[0] : undefined;
									const operations = preparedGraphs.flatMap((graph) => graph.operations);
									// PREPARE already owns graph discovery and normalization. COMMIT only orders the
									// resulting operations and proves that every operation has one loud guard.
									const compiled = statementPlanFor(operations, {
										...(browserMutation === undefined ? {} : { ledgerClaim: browserMutation })
									});
									applied = yield* applyDeclarativeGraph(
										effectId,
										subject,
										compiled,
										preparedGraphs.flatMap((graph) => graph.relationshipSnapshots),
										elevated,
										browserMutation,
										options?.approval?.approvalRequestId,
										approvedRoot === undefined
											? undefined
											: {
													collection: approvedRoot.collection,
													id: approvedRoot.rootId,
													action: approvedRoot.rootAction
												}
									).pipe(
										Effect.catchCause((cause) =>
											Effect.gen(function* () {
												const failure = Cause.squash(cause);
												if (failure instanceof BrowserMutationReplay)
													return yield* Effect.fail(failure);
												if (
													browserMutation !== undefined &&
													options?.approval?.approved !== true &&
													!Cause.hasInterruptsOnly(cause)
												) {
													const replay = yield* browserMutationOutcome(
														EffectId.make(`${effectId}:concurrent-replay`),
														browserMutation.scope,
														browserMutation.idempotencyKey,
														browserMutation.requestDigest
													).pipe(
														Effect.catchTag(
															'Bolt.Collections.MutationIdempotencyConflict',
															(conflict) =>
																Effect.fail(
																	mutationPhaseFailure('commit', collection, [], conflict)
																)
														)
													);
													if (replay !== undefined)
														return yield* replayBrowserMutationOutcome(replay);
												}
												return yield* Effect.fail(
													mutationPhaseFailure('commit', collection, [], failure)
												);
											})
										)
									);
								})
							);
						const settleAppliedGraph = () =>
							lifecycleError(
								Effect.gen(function* () {
									if (applied === undefined && preparedGraphs.length === 0) return;
									if (applied === undefined)
										return yield* graphRefusal(
											collection,
											'create',
											'The mutation lifecycle reached settlement before COMMIT.'
										);
									settled = yield* settleDeclarativeGraphService(
										{
											buildApi: authoringApi,
											runHook,
											emitChangeEventsMany: (eventEffectId, eventCollection, records, event) =>
												emitChangeEventsManyService(
													changeEventPorts,
													eventEffectId,
													eventCollection,
													records,
													event
												),
											embedRecords: (embeddingEffectId, limit, targets) =>
												embedRecordsService(embeddingPorts, embeddingEffectId, limit, targets)
										},
										effectId,
										subject,
										applied,
										depth
									);
								})
							);
						for (const [groupCollection, groupRoots] of groupsByCollection) {
							yield* readRootGroup(groupCollection, groupRoots);
							yield* prepareRootGroup(groupRoots);
						}
						yield* gatePreparedGraphs();
						yield* commitPreparedGraphs();
						yield* settleAppliedGraph();
					});
					yield* lifecycle.pipe(
						Effect.catchCause((cause) =>
							Effect.gen(function* () {
								// Approval is a suspended transaction, not a best-effort replay. Any drift or
								// preparation/gate failure before COMMIT permanently conflicts the request.
								if (
									applied === undefined &&
									options?.approval?.approved === true &&
									options.approval.approvalRequestId !== undefined &&
									!Cause.hasInterruptsOnly(cause)
								)
									yield* approvals
										.conflict(
											EffectId.make(`${effectId}:review-conflict`),
											options.approval.approvalRequestId,
											'the reviewed mutation graph changed while approval was pending'
										)
										.pipe(Effect.ignore);
								return yield* Effect.failCause(cause);
							})
						)
					);
					if (roots.length === 1) {
						const root = roots[0]!;
						const requestId = heldRequestIds.get(
							writeRecordKey({ collection: root.collection, recordId: root.rootId })
						);
						if (requestId !== undefined) {
							const pending = new PendingApproval({
								requestId,
								collection: root.collection,
								id: root.rootId,
								action: root.rootAction
							});
							if (browserMutation === undefined) return yield* pending;
							const outcome: BrowserMutationOutcome = {
								_tag: 'PendingApproval',
								requestId,
								collection: root.collection,
								id: root.rootId,
								action: root.rootAction,
								schemaFingerprint: browserMutation.currentSchemaFingerprint
							};
							return yield* rememberBrowserMutationOutcome(
								EffectId.make(`${effectId}:pending-approval`),
								browserMutation,
								outcome
							).pipe(
								Effect.flatMap((persisted) => replayBrowserMutationOutcome(persisted ?? outcome))
							);
						}
					}
					const changes: Array<{ collection: string; recordId: string }> = [];
					const seenChanges = new Set<string>();
					for (const operation of applied?.operations ?? []) {
						const key = `${operation.collection}\u0000${operation.id}`;
						if (seenChanges.has(key)) continue;
						seenChanges.add(key);
						changes.push({ collection: operation.collection, recordId: operation.id });
					}
					return {
						records: roots.map(
							(root) =>
								settled.get(`${root.collection}\u0000${root.rootId}`) ??
								applied?.records.get(`${root.collection}\u0000${root.rootId}`) ?? {
									id: root.rootId
								}
						),
						changes
					};
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
				const result = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({ count: countRows() })
						.from(table)
						.where(and(compiled, searched.predicate, AccessControl.predicateExpression(visibility)))
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
					const { definition, policy, context, compiled, searched, visibility } =
						yield* prepareRead(effectId, subject, input, ROOT_ALIAS, () =>
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
							and(compiled, searched.predicate, AccessControl.predicateExpression(visibility)) ??
							always(),
						ordering: compileOrderTerms(input.orderBy, context),
						searchOrdering:
							searched.mode === 'lexical'
								? desc(searched.rank)
								: searched.mode === 'semantic'
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

			/**
			 * Closes the durable hold behind a refused request.
			 *
			 * PREPARE never commits a held create, so there is no provisional domain row to delete. For an
			 * existing update or delete root, discard releases its approval marker without applying the
			 * proposed graph. Browser mutations also receive one durable terminal outcome.
			 */
			const discard = Effect.fn('Collections.discard')(function* (
				effectId: EffectId,
				requestId: string
			) {
				const engineDiscard = yield* approvals.discard(effectId, requestId);
				const browserMutation =
					engineDiscard.browserMutation === undefined
						? undefined
						: yield* Schema.decodeUnknownEffect(StoredBrowserMutationFence)(
								engineDiscard.browserMutation
							).pipe(
								Effect.mapError(
									() =>
										new ApprovalConflict({
											requestId,
											reason: 'refused request contains malformed browser mutation provenance'
										})
								)
							);
				if (browserMutation !== undefined) {
					const message =
						engineDiscard.resolution === 'rejected'
							? 'The approval request was rejected.'
							: engineDiscard.resolution === 'changes_requested'
								? 'Changes were requested for the approval request.'
								: 'The approval request was withdrawn.';
					const rejected: BrowserMutationOutcome = {
						_tag: 'Rejected',
						code: 'refused',
						message,
						schemaFingerprint: browserMutation.currentSchemaFingerprint,
						collection: engineDiscard.root.collection,
						action: engineDiscard.root.action
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
						durable.collection !== engineDiscard.root.collection ||
						durable.id !== engineDiscard.root.id ||
						durable.action !== engineDiscard.root.action
					)
						return yield* new ApprovalConflict({
							requestId,
							reason:
								'stored browser mutation approval provenance does not match its ledger outcome'
						});
					const releasesRecord = engineDiscard.root.action !== 'create';
					const statements = [
						browserMutationApprovalGuardStatement(
							browserMutation,
							requestId,
							engineDiscard.root.collection,
							engineDiscard.root.id,
							engineDiscard.root.action
						),
						...(releasesRecord
							? [
									approvalReleaseStatement(
										engineDiscard.root.collection,
										engineDiscard.root.id,
										requestId
									)
								]
							: []),
						browserMutationApprovalTerminalStatement(
							browserMutation,
							requestId,
							engineDiscard.root.collection,
							engineDiscard.root.id,
							engineDiscard.root.action,
							rejected
						)
					];
					yield* database.execute(effectId, { _tag: 'Transaction', statements });
					return;
				}
				if (engineDiscard.root.action !== 'create')
					yield* releaseLock(
						effectId,
						engineDiscard.root.collection,
						engineDiscard.root.id,
						requestId
					);
			});
			const resume = Effect.fn('Collections.resume')(function* (
				effectId: EffectId,
				requestId: string
			) {
				const engineResume = yield* approvals.resume(effectId, requestId);
				const stored = yield* Schema.decodeUnknownEffect(StoredEngineApprovalGraph)(
					engineResume.storedGraph
				).pipe(
					Effect.mapError(
						() =>
							new ApprovalConflict({
								requestId,
								reason: 'approved request contains a malformed engine graph'
							})
					)
				);
				yield* mutate(
					effectId,
					engineResume.subject,
					stored.collection,
					[{ ...stored.payload, id: stored.id }],
					false,
					0,
					{
						root: { id: stored.id, action: stored.action },
						approval: {
							approved: true,
							clearRootLock: stored.action === 'update',
							approvalRequestId: requestId,
							expectedReview: engineResume.expectedReview,
							...(stored.browserMutation === undefined
								? {}
								: { browserMutation: stored.browserMutation })
						}
					}
				);
			});
			const mutateBrowser = Effect.fn('Collections.mutateBrowser')(function* (
				effectId: EffectId,
				actor: Identity.Subject,
				subject: Identity.Subject,
				impersonatedTeam: string | null,
				input: CollectionMutateRequest
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
					throw new TypeError('Compiled workspace is missing its schema fingerprint.');
				const graph = input.graph;
				const baseVersions = input.baseVersions;
				const rootId = String(graph.action === 'delete' ? graph.id : graph.values['id']);
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
					Effect.gen(function* () {
						const records =
							outcome._tag !== 'Committed' || outcome.action === 'delete'
								? []
								: yield* findMany(EffectId.make(`${mutationEffectId}:readback`), subject, {
										collection: outcome.collection,
										where: { id: { in: [outcome.id] } },
										limit: 1
									}).pipe(Effect.catch(() => Effect.succeed([])));
						return projectBrowserMutationOutcome(input.idempotencyKey, outcome).settle(records);
					});
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
				const rootBaseVersion = baseVersions.find(
					(entry) => entry.row.collection === graph.collection && entry.row.recordId === rootId
				)?.rowVersion;
				if (graph.action === 'create' && rootBaseVersion !== undefined)
					quarantineReason = `The create graph carries a base version for its new root ${graph.collection} ${rootId}.`;
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
				const persistFailure = (cause: unknown) =>
					Effect.gen(function* () {
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
									: error instanceof MutationVersionConflict
										? {
												_tag: 'VersionConflict',
												collection: error.collection,
												id: error.id,
												baseVersion: error.baseVersion,
												currentVersion: error.currentVersion,
												schemaFingerprint: currentSchemaFingerprint
											}
										: error instanceof PendingApproval
											? {
													_tag: 'PendingApproval',
													requestId: error.requestId,
													collection: error.collection,
													id: error.id,
													action: error.action,
													schemaFingerprint: currentSchemaFingerprint
												}
											: {
													_tag: 'Quarantined',
													idempotencyKey: input.idempotencyKey,
													schemaFingerprint: currentSchemaFingerprint,
													reason: `The mutation stopped with an unclassified failure: ${describeCause(error)}`
												};
						return yield* settleTerminal(fence, terminal);
					});
				const write =
					graph.action === 'delete'
						? mutate(mutationEffectId, subject, graph.collection, [{ id: graph.id }], false, 0, {
								root: { id: graph.id, action: 'delete' },
								...(rootBaseVersion === undefined || rootBaseVersion === null
									? {}
									: { expectedRootVersion: rootBaseVersion }),
								browserMutation: fence
							})
						: mutate(mutationEffectId, subject, graph.collection, [graph.values], false, 0, {
								root: { id: rootId, action: graph.action },
								browserMutation: fence
							});
				const written = yield* Effect.result(write);
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
				const settlement = yield* settleOutcome(committed);
				return {
					...settlement,
					changes: written.success.changes.map((change) => ({
						...change,
						mutationId: input.idempotencyKey
					}))
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
			return Service.of({
				authoringCollectionNames,
				runAutomation: (effectId, name, input, scope = {}, options) =>
					startAutomation(effectId, name, input, scope, options),
				findMany,
				findFirst: Effect.fn('Collections.findFirst')(function* (effectId, subject, input) {
					return (yield* findMany(effectId, subject, { ...input, limit: 1 }))[0];
				}),
				count,
				findNearest,
				embedRecords: (effectId, limit = RECORD_EMBEDDING_BACKFILL_LIMIT) =>
					embedRecordsService(embeddingPorts, effectId, limit),
				findGrouped,
				mutate: (effectId, subject, collection, payloads, elevated = false, depth = 0, options) =>
					mutate(effectId, subject, collection, payloads, elevated, depth, options).pipe(
						Effect.catchIf(isBrowserMutationReplay, (cause) =>
							cause.outcome._tag === 'Committed'
								? Effect.succeed({
										records: [{ id: cause.outcome.id }],
										changes: [
											{
												collection: cause.outcome.collection,
												recordId: cause.outcome.id
											}
										]
									})
								: Effect.fail(mutationPhaseFailure('commit', collection, [], cause))
						)
					),
				// The implementation carries a `depth` argument for its own recursion guard; the service
				// contract is the three-argument call, so the extra parameter stops here rather than
				// widening the published signature.
				delete: (effectId, subject, collection, id, options) =>
					mutate(effectId, subject, collection, [{ id }], false, 0, {
						root: { id, action: 'delete' },
						...(options?.baseVersion === undefined
							? {}
							: { expectedRootVersion: options.baseVersion }),
						...(options?.browserMutation === undefined
							? {}
							: { browserMutation: options.browserMutation })
					}).pipe(
						Effect.catchIf(isBrowserMutationReplay, () =>
							Effect.succeed({
								records: [],
								changes: [{ collection, recordId: id }]
							})
						),
						Effect.catchIf(
							(cause): cause is MutationPhaseFailure => cause instanceof MutationPhaseFailure,
							(cause) => Effect.fail(cause.underlying as MutationError)
						)
					),
				mutateBrowser,
				lookupBrowserMutations,
				resume: (effectId, requestId) =>
					resume(effectId, requestId).pipe(
						Effect.catchIf(isBrowserMutationReplay, () => Effect.void),
						Effect.asVoid
					),
				discard,
				import: Effect.fn('Collections.import')(function* (effectId, subject, inputs) {
					type ImportRoot = Readonly<{
						collection: string;
						id: string;
						action: 'create' | 'update';
						payload: Readonly<Record<string, unknown>>;
					}>;
					const mutateImportChunk = (chunk: ReadonlyArray<ImportRoot>, chunkIndex: number) =>
						Effect.gen(function* () {
							const first = chunk[0];
							if (first === undefined) return 0;
							yield* mutate(
								EffectId.make(`${effectId}:chunk:${chunkIndex}`),
								subject,
								first.collection,
								chunk.map((root) => root.payload),
								false,
								0,
								{
									roots: chunk.map(({ collection, id, action }) => ({ collection, id, action }))
								}
							).pipe(
								Effect.catchIf(isBrowserMutationReplay, (cause) => Effect.die(cause)),
								Effect.catchIf(
									(cause): cause is MutationPhaseFailure => cause instanceof MutationPhaseFailure,
									(cause) => Effect.fail(cause.underlying as MutationError)
								)
							);
							return chunk.length;
						});
					const importChunks = <Row>(
						rows: ReadonlyArray<Row>,
						rootFor: (row: Row, index: number) => Effect.Effect<ImportRoot, MutationError>
					) =>
						Effect.gen(function* () {
							for (let offset = 0; offset < rows.length; offset += 100) {
								const chunk: Array<ImportRoot> = [];
								for (const [relativeIndex, row] of rows.slice(offset, offset + 100).entries())
									chunk.push(yield* rootFor(row, offset + relativeIndex));
								yield* mutateImportChunk(chunk, offset / 100);
							}
						});
					const pipeline = authored.pipelines[inputs[0]?.collection ?? ''];
					// The handler is bound to a local before the guard, rather than reached through
					// `pipeline.import` inside the thunk below. A narrowing does not survive into a closure —
					// TypeScript has to assume `pipeline` was reassigned by the time the thunk runs — so the
					// deferred form this now takes turned a checked access into an unchecked one. On a
					// collection with no import pipeline that is a real throw, not a type complaint.
					const declared = pipeline?.import;
					if (declared !== undefined) {
						const api = authoringApi(effectId, subject);
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
							declared.handler({ input: document, api })
						);
						if (!Array.isArray(rows)) {
							return yield* new AccessControl.AccessDenied({
								action: 'import',
								resource: inputs[0]?.collection ?? '',
								reason: 'import pipeline returned no rows'
							});
						}
						yield* importChunks(rows, (row, index) =>
							Effect.gen(function* () {
								const collection = inputs[index]?.collection ?? inputs[0]?.collection ?? '';
								if (typeof row !== 'object' || row === null || Array.isArray(row))
									return yield* new AccessControl.AccessDenied({
										action: 'import',
										resource: collection,
										reason: `import pipeline row ${index + 1} is not a record`
									});
								const record = row as Readonly<Record<string, unknown>>;
								const submittedId = record['id'];
								if (
									submittedId !== undefined &&
									(typeof submittedId !== 'string' || submittedId.length === 0)
								)
									return yield* new AccessControl.AccessDenied({
										action: 'import',
										resource: collection,
										reason: `import pipeline row ${index + 1} has an invalid id`
									});
								const action = typeof submittedId === 'string' ? 'update' : 'create';
								const id =
									typeof submittedId === 'string'
										? submittedId
										: deriveRecordId(`${collection}:${effectId}:${index}`);
								return { collection, id, action, payload: { ...record, id } };
							})
						);
						return rows.length;
					}
					yield* importChunks(inputs, (input) =>
						Effect.succeed({
							collection: input.collection,
							id: input.id,
							action: 'create' as const,
							payload: { ...input.values, id: input.id }
						})
					);
					return inputs.length;
				}),
				export: Effect.fn('Collections.export')(function* (effectId, subject, input) {
					// Bound before the guard, for the reason `import` above is: the thunk defers the call past
					// the point where the narrowing holds.
					const declared = authored.pipelines[input.collection]?.export;
					if (declared !== undefined) {
						const api = authoringApi(effectId, subject);
						const records = yield* findMany(effectId, subject, input);
						return yield* runAuthoredHandler(() => declared.handler({ records, api }));
					}
					return yield* findMany(effectId, subject, input);
				}) as Interface['export'],
				history: Effect.fn('Collections.history')(function* (effectId, subject, collection, id) {
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
					const projection = projectHistory({
						current: { id },
						patches: historyPatchesFromRows(rows),
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
					return presentHistoryRevisions(revisions);
				}),
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

export const layer = layerWith();
