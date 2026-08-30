import { Schema } from 'effect';
import {
	CollectionGroupedQueryRequestFields,
	CollectionMutationIdempotencyKey,
	CollectionQueryRequestFields,
	StoredRecord
} from './collections.js';

const NonNegativeInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

/** Header joining a control/write request to the SSE connection allocated by its host. */
export const SYNC_CONNECTION_HEADER = 'x-bolt-sync-connection';
/** Above this base, the host keeps only a digest and every wake receives a full answer. */
export const MAX_SYNC_HELD_IDS = 20_000;

/** First SSE control event; subsequent events are exclusively `apply`. */
export const SyncReadyFrame = Schema.Struct({
	connectionId: Schema.NonEmptyString
}).annotate({ identifier: 'BoltSyncReadyFrame' });
export interface SyncReadyFrame extends Schema.Schema.Type<typeof SyncReadyFrame> {}

/** A reconnect position in the collection-granular changelog. */
export const SyncCursor = Schema.Struct({ sequence: NonNegativeInteger }).annotate({
	identifier: 'BoltSyncCursor'
});
export interface SyncCursor extends Schema.Schema.Type<typeof SyncCursor> {}

/** The complete semantic input of one live collection query. */
export const SyncQueryInput = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('findMany'), ...CollectionQueryRequestFields }),
	Schema.Struct({ kind: Schema.Literal('findFirst'), ...CollectionQueryRequestFields }),
	Schema.Struct({ kind: Schema.Literal('findGrouped'), ...CollectionGroupedQueryRequestFields }),
	Schema.Struct({ kind: Schema.Literal('count'), ...CollectionQueryRequestFields })
]).annotate({ identifier: 'BoltSyncQueryInput' });
export type SyncQueryInput = typeof SyncQueryInput.Type;

/** Opaque equality partition filed by the host to avoid waking unrelated query holders. */
export const SyncRoutingConstraint = Schema.Struct({
	field: Schema.NonEmptyString,
	values: Schema.Array(Schema.Json)
}).annotate({ identifier: 'BoltSyncRoutingConstraint' });
export interface SyncRoutingConstraint extends Schema.Schema.Type<typeof SyncRoutingConstraint> {}

/** One committed value for an equality partition. The host compares it but never interprets it. */
export const SyncRoutingValue = Schema.Struct({
	field: Schema.NonEmptyString,
	value: Schema.Json
}).annotate({ identifier: 'BoltSyncRoutingValue' });
export interface SyncRoutingValue extends Schema.Schema.Type<typeof SyncRoutingValue> {}

/** One committed coordinate returned by the invocation that performed the write. */
export const SyncChange = Schema.Struct({
	collection: Schema.NonEmptyString,
	recordId: Schema.NonEmptyString,
	/** Trusted post-commit equality values used only to narrow host-side invalidation. */
	routing: Schema.optionalKey(Schema.Array(SyncRoutingValue)),
	mutationId: Schema.optionalKey(CollectionMutationIdempotencyKey)
}).annotate({ identifier: 'BoltSyncChange' });
export interface SyncChange extends Schema.Schema.Type<typeof SyncChange> {}

/** Minimal host-held row state needed to derive the next content digest without re-running a query. */
export const SyncHeldCoordinate = Schema.Struct({
	id: Schema.NonEmptyString,
	rowVersion: Schema.NullOr(Schema.Union([Schema.Number, Schema.String])),
	/** Values of the authoritative order terms, including the primary-key tiebreaker. */
	order: Schema.Array(Schema.Json)
}).annotate({ identifier: 'BoltSyncHeldCoordinate' });
export interface SyncHeldCoordinate extends Schema.Schema.Type<typeof SyncHeldCoordinate> {}

/** One cursored page: the authoritative rows and the keyset continuation for the next one. */
export const SyncPageAnswer = Schema.Struct({
	rows: Schema.Array(StoredRecord),
	/** The keyset continuation for the next page, or null when this page is the last. */
	nextCursor: Schema.NullOr(Schema.NonEmptyString)
}).annotate({ identifier: 'BoltSyncPageAnswer' });
export interface SyncPageAnswer extends Schema.Schema.Type<typeof SyncPageAnswer> {}

/**
 * A query answer. Lists preserve authoritative order; grouped and scalar answers stay exact.
 *
 * The cursored-page arm is answered only for a read whose input carries `after` — a one-shot read
 * the delta engine never patches (RFC §2.3). It must stay ahead of `StoredRecord`, whose open
 * record would otherwise absorb it and lose the cursor slot on the wire.
 */
export const SyncAnswer = Schema.Union([
	Schema.Array(StoredRecord),
	SyncPageAnswer,
	StoredRecord,
	Schema.Record(Schema.String, Schema.Array(StoredRecord)),
	Schema.Number,
	Schema.Null
]).annotate({ identifier: 'BoltSyncAnswer' });
export type SyncAnswer = typeof SyncAnswer.Type;

/** The only patches the browser reducer accepts. */
export const SyncPatch = Schema.Union([
	Schema.Struct({
		op: Schema.Literal('insert'),
		index: NonNegativeInteger,
		row: StoredRecord
	}),
	Schema.Struct({
		op: Schema.Literal('replace'),
		recordId: Schema.NonEmptyString,
		/** New seat when the row moved, or when an entrant replaces a window boundary row. */
		index: Schema.optionalKey(NonNegativeInteger),
		/**
		 * The row that loses its seat when this patch is a boundary seat change (§2.3). `index`
		 * names the entrant's actual rank; it need not be the displaced row's former seat.
		 */
		displaces: Schema.optionalKey(Schema.NonEmptyString),
		row: StoredRecord
	}),
	Schema.Struct({ op: Schema.Literal('remove'), recordId: Schema.NonEmptyString }),
	Schema.Struct({ op: Schema.Literal('scalar'), value: Schema.Number }),
	Schema.Struct({ op: Schema.Literal('answer'), answer: SyncAnswer })
]).annotate({ identifier: 'BoltSyncPatch' });
export type SyncPatch = typeof SyncPatch.Type;

/** The public handshake, used for initial connect and one-entry revalidation alike. */
export const SyncConnectRequest = Schema.Struct({
	head: Schema.optionalKey(SyncCursor),
	queries: Schema.Array(
		Schema.Struct({
			key: Schema.NonEmptyString,
			input: SyncQueryInput,
			digest: Schema.optionalKey(Schema.NonEmptyString),
			/** Reconnect base retained by the client answer; lets changelog skipping avoid a resolve. */
			heldIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
			/** Reconnect base for point/rank advances; omitted by older clients forces one fresh resolve. */
			heldCoordinates: Schema.optionalKey(Schema.Array(SyncHeldCoordinate)),
			/** Echo of a guest-issued ceiling; forces full answers and needs no positional base. */
			digestOnly: Schema.optionalKey(Schema.Boolean)
		})
	),
	/** Keys whose retained attachment this control request releases. */
	released: Schema.Array(Schema.NonEmptyString),
	pending: Schema.Array(CollectionMutationIdempotencyKey)
}).annotate({ identifier: 'BoltSyncConnectRequest' });
export interface SyncConnectRequest extends Schema.Schema.Type<typeof SyncConnectRequest> {}

/** Every durable terminal write state the stream may settle. */
export const SyncWriteStatus = Schema.Union([
	Schema.Struct({
		resolution: Schema.Literal('accepted'),
		schemaFingerprint: Schema.NonEmptyString,
		pendingApproval: Schema.optionalKey(
			Schema.Struct({
				requestId: Schema.NonEmptyString,
				collection: Schema.NonEmptyString,
				id: Schema.NonEmptyString,
				action: Schema.Literals(['create', 'update', 'delete'])
			})
		)
	}),
	Schema.Struct({
		resolution: Schema.Literal('rebased'),
		fromSchemaFingerprint: Schema.NonEmptyString,
		toSchemaFingerprint: Schema.NonEmptyString
	}),
	Schema.Struct({
		resolution: Schema.Literal('rejected'),
		code: Schema.Literals(['refused', 'forbidden', 'conflict']),
		message: Schema.NonEmptyString,
		schemaFingerprint: Schema.NonEmptyString
	}),
	Schema.Struct({
		resolution: Schema.Literal('quarantined'),
		schemaFingerprint: Schema.NonEmptyString,
		reason: Schema.NonEmptyString
	})
]).annotate({ identifier: 'BoltSyncWriteStatus' });
export type SyncWriteStatus = typeof SyncWriteStatus.Type;

export const SyncOutcome = Schema.Struct({
	id: CollectionMutationIdempotencyKey,
	status: SyncWriteStatus
}).annotate({ identifier: 'BoltSyncOutcome' });
export interface SyncOutcome extends Schema.Schema.Type<typeof SyncOutcome> {}

/** Registration facts computed in the guest and filed, without interpretation, by a host. */
export const SyncSubEntry = Schema.Struct({
	key: Schema.NonEmptyString,
	input: SyncQueryInput,
	/** Header-derived preview coordinate; absent means the credential's ordinary authority. */
	impersonatedTeam: Schema.optionalKey(Schema.NonEmptyString),
	policyHash: Schema.NonEmptyString,
	dependencies: Schema.Array(Schema.NonEmptyString),
	/** Subset whose commits require re-authenticating every attached credential. */
	policyDependencies: Schema.Array(Schema.NonEmptyString),
	/** Necessary root-query equality constraints; absent means collection-wide routing. */
	routing: Schema.optionalKey(Schema.Array(SyncRoutingConstraint)),
	heldIds: Schema.Array(Schema.NonEmptyString),
	heldCoordinates: Schema.optionalKey(Schema.Array(SyncHeldCoordinate)),
	digestOnly: Schema.Boolean,
	digest: Schema.NonEmptyString
}).annotate({ identifier: 'BoltSyncSubEntry' });
export interface SyncSubEntry extends Schema.Schema.Type<typeof SyncSubEntry> {}

export const SyncConnectResult = Schema.Union([
	Schema.Struct({
		key: Schema.NonEmptyString,
		digest: Schema.NonEmptyString,
		digestOnly: Schema.Boolean,
		changed: Schema.Literal(false)
	}),
	Schema.Struct({
		key: Schema.NonEmptyString,
		digest: Schema.NonEmptyString,
		digestOnly: Schema.Boolean,
		changed: Schema.Literal(true),
		answer: SyncAnswer
	})
]).annotate({ identifier: 'BoltSyncConnectResult' });
export type SyncConnectResult = typeof SyncConnectResult.Type;

/** Guest-to-host registration evaluation; the host projects this to `SyncConnectResult`. */
export const SyncConnectEvaluationResult = Schema.Union([
	Schema.Struct({ ...SyncSubEntry.fields, changed: Schema.Literal(false) }),
	Schema.Struct({ ...SyncSubEntry.fields, changed: Schema.Literal(true), answer: SyncAnswer })
]).annotate({ identifier: 'BoltSyncConnectEvaluationResult' });
export type SyncConnectEvaluationResult = typeof SyncConnectEvaluationResult.Type;

export const SyncConnectResponse = Schema.Struct({
	head: SyncCursor,
	results: Schema.Array(SyncConnectResult),
	outcomes: Schema.Array(SyncOutcome)
}).annotate({ identifier: 'BoltSyncConnectResponse' });
export interface SyncConnectResponse extends Schema.Schema.Type<typeof SyncConnectResponse> {}

export const SyncConnectEvaluation = Schema.Struct({
	head: SyncCursor,
	results: Schema.Array(SyncConnectEvaluationResult),
	outcomes: Schema.Array(SyncOutcome)
}).annotate({ identifier: 'BoltSyncConnectEvaluation' });
export interface SyncConnectEvaluation extends Schema.Schema.Type<typeof SyncConnectEvaluation> {}

/**
 * Host-held state sent back to the stateless guest for one advance.
 *
 * `credential` is deliberately opaque. The host stores it but never derives a subject or policy;
 * the guest authenticates it afresh, which makes revocation and policy drift visible on a wake.
 */
export const SyncAdvanceSubscription = Schema.Struct({
	subId: Schema.NonEmptyString,
	key: Schema.NonEmptyString,
	input: SyncQueryInput,
	credential: Schema.NonEmptyString,
	impersonatedTeam: Schema.optionalKey(Schema.NonEmptyString),
	heldIds: Schema.Array(Schema.NonEmptyString),
	heldCoordinates: Schema.optionalKey(Schema.Array(SyncHeldCoordinate)),
	digestOnly: Schema.Boolean,
	digest: Schema.NonEmptyString,
	policyHash: Schema.NonEmptyString
}).annotate({ identifier: 'BoltSyncAdvanceSubscription' });
export interface SyncAdvanceSubscription extends Schema.Schema.Type<
	typeof SyncAdvanceSubscription
> {}

export const SyncAdvanceRequest = Schema.Struct({
	changes: Schema.Array(SyncChange),
	subscriptions: Schema.Array(SyncAdvanceSubscription),
	/** Writer-owned ledger ids, including terminal outcomes that committed no collection change. */
	pending: Schema.Array(CollectionMutationIdempotencyKey),
	/** Opaque authority used only to scope `pending` ledger lookup. */
	writer: Schema.optionalKey(
		Schema.Struct({
			credential: Schema.NonEmptyString,
			impersonatedTeam: Schema.optionalKey(Schema.NonEmptyString)
		})
	)
}).annotate({ identifier: 'BoltSyncAdvanceRequest' });
export interface SyncAdvanceRequest extends Schema.Schema.Type<typeof SyncAdvanceRequest> {}

/** One full-answer fallback or one exact positional delta for a subscription. */
export const SyncAdvanceUpdate = Schema.Struct({
	subId: Schema.NonEmptyString,
	from: Schema.NonEmptyString,
	to: Schema.NonEmptyString,
	patch: SyncPatch,
	heldIds: Schema.Array(Schema.NonEmptyString),
	heldCoordinates: Schema.optionalKey(Schema.Array(SyncHeldCoordinate)),
	digestOnly: Schema.Boolean,
	policyHash: Schema.NonEmptyString,
	dependencies: Schema.Array(Schema.NonEmptyString),
	policyDependencies: Schema.Array(Schema.NonEmptyString)
}).annotate({ identifier: 'BoltSyncAdvanceUpdate' });
export interface SyncAdvanceUpdate extends Schema.Schema.Type<typeof SyncAdvanceUpdate> {}

export const SyncAdvanceRefusal = Schema.Struct({
	subId: Schema.NonEmptyString
}).annotate({ identifier: 'BoltSyncAdvanceRefusal' });
export interface SyncAdvanceRefusal extends Schema.Schema.Type<typeof SyncAdvanceRefusal> {}

export const SyncAdvanceResponse = Schema.Struct({
	head: SyncCursor,
	updates: Schema.Array(SyncAdvanceUpdate),
	refused: Schema.Array(SyncAdvanceRefusal),
	outcomes: Schema.Array(SyncOutcome)
}).annotate({ identifier: 'BoltSyncAdvanceResponse' });
export interface SyncAdvanceResponse extends Schema.Schema.Type<typeof SyncAdvanceResponse> {}

export const SyncApplyPatch = Schema.Struct({
	key: Schema.NonEmptyString,
	from: Schema.NonEmptyString,
	to: Schema.NonEmptyString,
	patch: SyncPatch
}).annotate({ identifier: 'BoltSyncApplyPatch' });
export interface SyncApplyPatch extends Schema.Schema.Type<typeof SyncApplyPatch> {}

/** The sole SSE payload. A commit's query changes and write settlements are one reducer event. */
export const SyncApplyFrame = Schema.Struct({
	head: SyncCursor,
	patches: Schema.Array(SyncApplyPatch),
	outcomes: Schema.Array(SyncOutcome)
}).annotate({ identifier: 'BoltSyncApplyFrame' });
export interface SyncApplyFrame extends Schema.Schema.Type<typeof SyncApplyFrame> {}
