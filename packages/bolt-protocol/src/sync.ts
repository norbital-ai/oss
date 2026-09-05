import { Schema } from 'effect';
import { CommandHeaders, commandContract } from './host.js';
import {
	CollectionMutationIdempotencyKey,
	CollectionQueryRequestFields,
	StoredRecord
} from './collections.js';
import { InvocationScope } from './invocation.js';

const NonNegativeInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

export const SYNC_CONNECTION_HEADER = 'x-bolt-sync-connection';
export const DEFAULT_SYNC_LOADED_KEYS = 100;
/**
 * 10,000, raised from 1,000. Pagination across the platform maxes at 10,000, and a live query is
 * pagination that keeps itself current — a lower ceiling here made "the list you can page through"
 * and "the list you can watch" two different lists, which is not a distinction anybody asked for.
 * RFC/sync-engine.md carries the amendment.
 */
export const MAX_SYNC_LOADED_KEYS = 10_000;
export const MAX_SYNC_INITIAL_ANSWER_BYTES = 2 * 1024 * 1024;
export const MAX_SYNC_OUTBOUND_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_SYNC_RETAINED_PREFIX_BYTES = 8 * 1024 * 1024;

const SyncPrefixLengthValue = NonNegativeInteger.check(
	Schema.isLessThanOrEqualTo(MAX_SYNC_LOADED_KEYS)
);
const SyncPositivePrefixLengthValue = PositiveInteger.check(
	Schema.isLessThanOrEqualTo(MAX_SYNC_LOADED_KEYS)
);
const SyncPrefixIndexValue = NonNegativeInteger.check(Schema.isLessThan(MAX_SYNC_LOADED_KEYS));
const SyncRetainedPrefixBytesValue = NonNegativeInteger.check(
	Schema.isLessThanOrEqualTo(MAX_SYNC_RETAINED_PREFIX_BYTES)
);

export const syncJsonByteLength = (value: unknown): number =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Sum of each retained row's JSON bytes. Not `syncJsonByteLength(rows)` — the array wrapper is not retained. */
export const syncRetainedPrefixBytes = (rows: ReadonlyArray<unknown>): number =>
	rows.reduce<number>((total, row) => total + syncJsonByteLength(row), 0);

export const syncApplyFrameByteLength = (frame: unknown): number =>
	new TextEncoder().encode(`event: apply\ndata: ${JSON.stringify(frame)}\n\n`).byteLength;

export const syncScopedApplyFrameByteLength = syncApplyFrameByteLength;

const { after: _after, ...LiveCollectionQueryRequestFields } = CollectionQueryRequestFields;

export const SyncQueryInput = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('findMany'), ...LiveCollectionQueryRequestFields }),
	Schema.Struct({ kind: Schema.Literal('findFirst'), ...LiveCollectionQueryRequestFields })
]).annotate({ identifier: 'BoltSyncQueryInput' });
export type SyncQueryInput = typeof SyncQueryInput.Type;

export const SyncRoutingConstraint = Schema.Struct({
	field: Schema.NonEmptyString,
	values: Schema.Array(Schema.Json)
}).annotate({ identifier: 'BoltSyncRoutingConstraint' });
export interface SyncRoutingConstraint extends Schema.Schema.Type<typeof SyncRoutingConstraint> {}

export const LinkAndRouteValues = Schema.Record(Schema.String, Schema.Json).annotate({
	identifier: 'BoltLinkAndRouteValues'
});
export interface LinkAndRouteValues extends Schema.Schema.Type<typeof LinkAndRouteValues> {}

const SyncChangeIdentity = {
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	mutationId: Schema.optionalKey(CollectionMutationIdempotencyKey)
};

export const SyncChange = Schema.Union([
	Schema.Struct({
		...SyncChangeIdentity,
		operation: Schema.Literal('insert'),
		after: LinkAndRouteValues
	}),
	Schema.Struct({
		...SyncChangeIdentity,
		operation: Schema.Literal('update'),
		before: LinkAndRouteValues,
		after: LinkAndRouteValues
	}),
	Schema.Struct({
		...SyncChangeIdentity,
		operation: Schema.Literal('delete'),
		before: LinkAndRouteValues
	})
]).annotate({ identifier: 'BoltSyncChange' });
export type SyncChange = typeof SyncChange.Type;

export const ChangeBatch = Schema.Struct({
	changes: Schema.Array(SyncChange)
}).annotate({ identifier: 'BoltChangeBatch' });
export interface ChangeBatch extends Schema.Schema.Type<typeof ChangeBatch> {}

const syncChangeKey = (change: Pick<SyncChange, 'collection' | 'id'>): string =>
	`${change.collection.length}:${change.collection}:${change.id}`;

const syncChangeAfter = (change: SyncChange): LinkAndRouteValues | undefined =>
	change.operation === 'delete' ? undefined : change.after;

const syncChangeBefore = (change: SyncChange): LinkAndRouteValues | undefined =>
	change.operation === 'insert' ? undefined : change.before;

const withLatestMutationId = (
	change: SyncChange,
	current: SyncChange,
	next: SyncChange
): SyncChange => {
	const mutationId = next.mutationId ?? current.mutationId;
	return mutationId === undefined ? change : { ...change, mutationId };
};

export const compactSyncChanges = (
	changes: ReadonlyArray<SyncChange>
): ReadonlyArray<SyncChange> => {
	const order: Array<string> = [];
	const ordered = new Set<string>();
	const compacted = new Map<string, SyncChange>();
	for (const next of changes) {
		const key = syncChangeKey(next);
		if (!ordered.has(key)) {
			ordered.add(key);
			order.push(key);
		}
		const current = compacted.get(key);
		if (current === undefined) {
			compacted.set(key, next);
			continue;
		}
		if (current.operation === 'insert') {
			if (next.operation === 'delete') {
				compacted.delete(key);
				continue;
			}
			const after = syncChangeAfter(next);
			if (after === undefined) continue;
			compacted.set(
				key,
				withLatestMutationId(
					{
						collection: current.collection,
						id: current.id,
						operation: 'insert',
						after
					},
					current,
					next
				)
			);
			continue;
		}
		const before = syncChangeBefore(current);
		if (before === undefined) continue;
		if (next.operation === 'delete') {
			compacted.set(
				key,
				withLatestMutationId(
					{
						collection: current.collection,
						id: current.id,
						operation: 'delete',
						before
					},
					current,
					next
				)
			);
			continue;
		}
		const after = syncChangeAfter(next);
		if (after === undefined) continue;
		compacted.set(
			key,
			withLatestMutationId(
				{
					collection: current.collection,
					id: current.id,
					operation: 'update',
					before,
					after
				},
				current,
				next
			)
		);
	}
	return order.flatMap((key) => {
		const change = compacted.get(key);
		return change === undefined ? [] : [change];
	});
};

export const SyncQueryKey = Schema.NonEmptyString.annotate({ identifier: 'BoltSyncQueryKey' });
export type SyncQueryKey = typeof SyncQueryKey.Type;

export const SyncQueryVersion = NonNegativeInteger.annotate({
	identifier: 'BoltSyncQueryVersion'
});
export type SyncQueryVersion = typeof SyncQueryVersion.Type;

export const SyncPrefixKey = Schema.Struct({
	id: Schema.NonEmptyString,
	order: Schema.Array(Schema.Json)
}).annotate({ identifier: 'BoltSyncPrefixKey' });
export interface SyncPrefixKey extends Schema.Schema.Type<typeof SyncPrefixKey> {}

export const SyncPrefixPut = Schema.Struct({
	id: Schema.NonEmptyString,
	index: SyncPrefixIndexValue,
	row: StoredRecord
}).annotate({ identifier: 'BoltSyncPrefixPut' });
export interface SyncPrefixPut extends Schema.Schema.Type<typeof SyncPrefixPut> {}

export const SyncPrefixDelta = Schema.Struct({
	removeIds: Schema.Array(Schema.NonEmptyString),
	put: Schema.Array(SyncPrefixPut)
}).annotate({ identifier: 'BoltSyncPrefixDelta' });
export interface SyncPrefixDelta extends Schema.Schema.Type<typeof SyncPrefixDelta> {}

export const SyncPrefixUpdate = Schema.Struct({
	queryKey: SyncQueryKey,
	fromVersion: SyncQueryVersion,
	toVersion: SyncQueryVersion,
	delta: SyncPrefixDelta
}).annotate({ identifier: 'BoltSyncPrefixUpdate' });
export interface SyncPrefixUpdate extends Schema.Schema.Type<typeof SyncPrefixUpdate> {}

export const SyncResetReason = Schema.Literals([
	'stale-version',
	'prefix-limit',
	'prefix-bytes',
	'inconsistent-prefix',
	'plan-changed',
	'policy-changed',
	'release-changed',
	'authority-changed'
]).annotate({ identifier: 'BoltSyncResetReason' });
export type SyncResetReason = typeof SyncResetReason.Type;

export const SyncPrefixReset = Schema.Struct({
	queryKey: SyncQueryKey,
	reason: SyncResetReason
}).annotate({ identifier: 'BoltSyncPrefixReset' });
export interface SyncPrefixReset extends Schema.Schema.Type<typeof SyncPrefixReset> {}

export const SyncExtendPrefixRequest = Schema.Struct({
	queryKey: SyncQueryKey,
	version: SyncQueryVersion,
	loadedPrefix: SyncPrefixLengthValue,
	requestedPrefix: SyncPositivePrefixLengthValue
}).annotate({ identifier: 'BoltSyncExtendPrefixRequest' });
export type SyncExtendPrefixRequest = typeof SyncExtendPrefixRequest.Type;

export const SyncExtendPrefixResponse = Schema.Struct({
	queryKey: SyncQueryKey,
	version: SyncQueryVersion,
	fromPrefix: SyncPrefixLengthValue,
	toPrefix: SyncPrefixLengthValue,
	rows: Schema.Array(StoredRecord),
	retainedBytes: SyncRetainedPrefixBytesValue
}).annotate({ identifier: 'BoltSyncExtendPrefixResponse' });
export type SyncExtendPrefixResponse = typeof SyncExtendPrefixResponse.Type;

export const SyncExtendPrefixEvaluation = Schema.Struct({
	...SyncExtendPrefixResponse.fields,
	prefixKeys: Schema.Array(SyncPrefixKey)
}).annotate({ identifier: 'BoltSyncExtendPrefixEvaluation' });
export type SyncExtendPrefixEvaluation = typeof SyncExtendPrefixEvaluation.Type;

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

export const SyncApplyFrame = Schema.Struct({
	updates: Schema.Array(SyncPrefixUpdate),
	resets: Schema.Array(SyncPrefixReset),
	outcomes: Schema.Array(SyncOutcome)
}).annotate({ identifier: 'BoltSyncApplyFrame' });
export interface SyncApplyFrame extends Schema.Schema.Type<typeof SyncApplyFrame> {}

export const SyncScope = InvocationScope;
export interface SyncScope extends Schema.Schema.Type<typeof SyncScope> {}

export const SyncScopedApplyFrame = Schema.Struct({
	scope: SyncScope,
	frame: SyncApplyFrame
}).annotate({ identifier: 'BoltSyncScopedApplyFrame' });
export interface SyncScopedApplyFrame extends Schema.Schema.Type<typeof SyncScopedApplyFrame> {}

export const SyncSubEntry = Schema.Struct({
	key: SyncQueryKey,
	input: SyncQueryInput,
	planKey: Schema.NonEmptyString,
	version: SyncQueryVersion,
	prefixKeys: Schema.Array(SyncPrefixKey),
	/** Admitted live window; actual rows may be fewer and can grow after later commits. */
	loadedPrefix: SyncPrefixLengthValue,
	prefixBytes: SyncRetainedPrefixBytesValue,
	impersonatedTeam: Schema.optionalKey(Schema.NonEmptyString),
	authorityFingerprint: Schema.NonEmptyString,
	dependencies: Schema.Array(Schema.NonEmptyString),
	routing: Schema.Array(SyncRoutingConstraint)
}).annotate({ identifier: 'BoltSyncSubEntry' });
export interface SyncSubEntry extends Schema.Schema.Type<typeof SyncSubEntry> {}

export const SyncConnectResult = Schema.Struct({
	queryKey: SyncQueryKey,
	version: SyncQueryVersion,
	rows: Schema.Array(StoredRecord),
	retainedBytes: SyncRetainedPrefixBytesValue
}).annotate({ identifier: 'BoltSyncConnectResult' });
export interface SyncConnectResult extends Schema.Schema.Type<typeof SyncConnectResult> {}

export const SyncConnectEvaluationResult = Schema.Struct({
	...SyncSubEntry.fields,
	rows: Schema.Array(StoredRecord)
}).annotate({ identifier: 'BoltSyncConnectEvaluationResult' });
export type SyncConnectEvaluationResult = typeof SyncConnectEvaluationResult.Type;

export const SyncConnectRequest = Schema.Struct({
	queries: Schema.Array(
		Schema.Struct({
			queryKey: SyncQueryKey,
			input: SyncQueryInput,
			requestedPrefix: SyncPositivePrefixLengthValue
		})
	),
	detached: Schema.Array(SyncQueryKey),
	pending: Schema.Array(CollectionMutationIdempotencyKey)
}).annotate({ identifier: 'BoltSyncConnectRequest' });
export interface SyncConnectRequest extends Schema.Schema.Type<typeof SyncConnectRequest> {}

export const SyncConnectResponse = Schema.Struct({
	queries: Schema.Array(SyncConnectResult),
	outcomes: Schema.Array(SyncOutcome)
}).annotate({ identifier: 'BoltSyncConnectResponse' });
export interface SyncConnectResponse extends Schema.Schema.Type<typeof SyncConnectResponse> {}

export const SyncConnectEvaluation = Schema.Struct({
	results: Schema.Array(SyncConnectEvaluationResult),
	outcomes: Schema.Array(SyncOutcome)
}).annotate({ identifier: 'BoltSyncConnectEvaluation' });
export interface SyncConnectEvaluation extends Schema.Schema.Type<typeof SyncConnectEvaluation> {}

export const SyncAdvanceSubscription = Schema.Struct({
	subId: Schema.NonEmptyString,
	input: SyncQueryInput,
	planKey: Schema.NonEmptyString,
	version: SyncQueryVersion,
	prefixKeys: Schema.Array(SyncPrefixKey),
	prefixBytes: SyncRetainedPrefixBytesValue,
	viewerPrefixes: Schema.Array(SyncPrefixLengthValue),
	credential: Schema.NonEmptyString,
	impersonatedTeam: Schema.optionalKey(Schema.NonEmptyString),
	authorityFingerprint: Schema.NonEmptyString
}).annotate({ identifier: 'BoltSyncAdvanceSubscription' });
export type SyncAdvanceSubscription = typeof SyncAdvanceSubscription.Type;

export const SyncAdvanceRequest = Schema.Struct({
	changes: Schema.Array(SyncChange),
	subscriptions: Schema.Array(SyncAdvanceSubscription),
	pending: Schema.Array(CollectionMutationIdempotencyKey),
	writer: Schema.optionalKey(
		Schema.Struct({
			credential: Schema.NonEmptyString,
			impersonatedTeam: Schema.optionalKey(Schema.NonEmptyString)
		})
	)
}).annotate({ identifier: 'BoltSyncAdvanceRequest' });
export interface SyncAdvanceRequest extends Schema.Schema.Type<typeof SyncAdvanceRequest> {}

export const SyncViewerPrefixDelta = Schema.Struct({
	loadedPrefix: SyncPrefixLengthValue,
	delta: SyncPrefixDelta
}).annotate({ identifier: 'BoltSyncViewerPrefixDelta' });
export type SyncViewerPrefixDelta = typeof SyncViewerPrefixDelta.Type;

export const SyncAdvanceUpdate = Schema.Struct({
	subId: Schema.NonEmptyString,
	fromVersion: SyncQueryVersion,
	toVersion: SyncQueryVersion,
	prefixKeys: Schema.Array(SyncPrefixKey),
	prefixBytes: SyncRetainedPrefixBytesValue,
	deltas: Schema.Array(SyncViewerPrefixDelta),
	authorityFingerprint: Schema.NonEmptyString,
	dependencies: Schema.Array(Schema.NonEmptyString)
}).annotate({ identifier: 'BoltSyncAdvanceUpdate' });
export interface SyncAdvanceUpdate extends Schema.Schema.Type<typeof SyncAdvanceUpdate> {}

export const SyncAdvanceReset = Schema.Struct({
	subId: Schema.NonEmptyString,
	reason: SyncResetReason
}).annotate({ identifier: 'BoltSyncAdvanceReset' });
export interface SyncAdvanceReset extends Schema.Schema.Type<typeof SyncAdvanceReset> {}

export const SyncAdvanceResponse = Schema.Struct({
	updates: Schema.Array(SyncAdvanceUpdate),
	resets: Schema.Array(SyncAdvanceReset),
	outcomes: Schema.Array(SyncOutcome)
}).annotate({ identifier: 'BoltSyncAdvanceResponse' });
export interface SyncAdvanceResponse extends Schema.Schema.Type<typeof SyncAdvanceResponse> {}

export const SyncCommandContracts = [
	commandContract({
		name: 'sync.connect',
		input: SyncConnectRequest,
		responses: [{ status: 200, value: SyncConnectEvaluation, headers: CommandHeaders }]
	}),
	commandContract({
		name: 'sync.extendPrefix',
		input: Schema.Struct({ request: SyncExtendPrefixRequest, state: SyncAdvanceSubscription }),
		responses: [{ status: 200, value: SyncExtendPrefixEvaluation, headers: CommandHeaders }]
	}),
	commandContract({
		name: 'sync.advance',
		input: SyncAdvanceRequest,
		responses: [{ status: 200, value: SyncAdvanceResponse, headers: CommandHeaders }]
	})
] as const;
