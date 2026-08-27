import { Result, Schema } from 'effect';
import { workspaceSession } from '#lib/client/session.js';
import {
	SyncCursor,
	SyncPartitionIdentity,
	SyncPullResponse,
	type SyncCollectionGenerations,
	type SyncMutationConfirmation,
	type SyncMutationRejection,
	type SyncPartitionDelta,
	type SyncPartitionIdentity as SyncPartitionIdentityType,
	type SyncPullCost,
	type SyncRehydrationCost
} from '#lib/runtime/sync/sync.js';
import {
	ReplicaSchemaBarrier,
	type ReplicaSchemaBarrier as ReplicaSchemaBarrierType,
	ReplicaSchemaMaintenance,
	type ReplicaSchemaMaintenance as ReplicaSchemaMaintenanceType,
	ReplicaSchemaMaintenanceClear,
	type ReplicaSchemaMaintenanceClear as ReplicaSchemaMaintenanceClearType
} from '@norbital-ai/bolt-protocol';

export type EventSourceLike = {
	addEventListener: (type: string, listener: (event: { data?: string }) => void) => void;
	close: () => void;
	onerror: ((event: unknown) => void) | null;
};

export type Subscription = Readonly<{ readonly stop: () => void }>;

export type CollectionGenerations = SyncCollectionGenerations;

/** A full permitted row transition computed once for an authority partition. */
export type PartitionDelta = SyncPartitionDelta;

export type PartitionDeltaBatch = Readonly<{
	readonly partition: SyncPartitionIdentityType;
	readonly kind: 'delta';
	readonly deltas: ReadonlyArray<PartitionDelta>;
	readonly cursor: SyncCursor;
	readonly headCursor: SyncCursor;
	readonly generations: CollectionGenerations;
	readonly affectedCollections: ReadonlyArray<string>;
	readonly refillCollections: ReadonlyArray<string>;
	readonly cost: SyncPullCost;
	readonly mutationConfirmations: ReadonlyArray<SyncMutationConfirmation>;
	readonly mutationRejections: ReadonlyArray<SyncMutationRejection>;
	readonly complete: boolean;
}>;

export type PartitionRecoveryAdvice = Readonly<{
	readonly partition: SyncPartitionIdentityType;
	readonly kind: 'cursorExpired' | 'rehydrateAdvised';
	readonly cursor: SyncCursor;
	readonly headCursor: SyncCursor;
	readonly generations: CollectionGenerations;
	readonly affectedCollections: ReadonlyArray<string>;
	readonly refillCollections: ReadonlyArray<string>;
	readonly cost: SyncPullCost;
	readonly mutationConfirmations: ReadonlyArray<SyncMutationConfirmation>;
	readonly mutationRejections: ReadonlyArray<SyncMutationRejection>;
	readonly complete: boolean;
}>;

export type PartitionStreamReady = Readonly<{
	readonly connectionId: string;
	readonly partition: SyncPartitionIdentityType;
	readonly cursor: SyncCursor;
	readonly generations: CollectionGenerations;
}>;

export type PartitionStreamPosition = Readonly<{
	readonly cursor: SyncCursor;
	readonly generations: CollectionGenerations;
}>;

type PartitionSubscribeOptions = Readonly<{
	readonly collections: ReadonlyArray<string>;
	readonly position: PartitionStreamPosition;
	readonly pendingMutationIds?: ReadonlyArray<string>;
	readonly rehydration?: SyncRehydrationCost;
	readonly onDeltas: (batch: PartitionDeltaBatch) => void;
	readonly onRecovery: (advice: PartitionRecoveryAdvice) => void;
	readonly onPartitionChanged?: (partition: SyncPartitionIdentityType) => void;
	readonly onReady?: (ready: PartitionStreamReady) => void;
	readonly onBarrier?: (barrier: ReplicaSchemaBarrierType) => void;
	readonly onMaintenance?: (maintenance: ReplicaSchemaMaintenanceType) => void;
	readonly onMaintenanceClear?: (clear: ReplicaSchemaMaintenanceClearType) => void;
	readonly onConnecting?: () => void;
	readonly onError?: ((cause: unknown) => void) | undefined;
	readonly source?: (url: string) => EventSourceLike;
}>;

export type PartitionSubscription = Subscription &
	Readonly<{
		/** Reopens the one leader-owned stream only when its dependency set changes. */
	readonly update: (
		collections: ReadonlyArray<string>,
		position: PartitionStreamPosition,
		pendingMutationIds?: ReadonlyArray<string>,
		rehydration?: SyncRehydrationCost
	) => void;
}>;

const Generations = Schema.Record(Schema.String, Schema.Number);
const PartitionReadyWire = Schema.Struct({
	connectionId: Schema.NonEmptyString,
	partition: SyncPartitionIdentity,
	cursor: SyncCursor,
	generations: Generations
});
const RETRY_OPEN_MILLIS = 2_000;

const parseBarrier = (data: string | undefined) =>
	Result.try(() => Schema.decodeUnknownSync(ReplicaSchemaBarrier)(JSON.parse(data ?? '')));
const parseMaintenance = (data: string | undefined) =>
	Result.try(() => Schema.decodeUnknownSync(ReplicaSchemaMaintenance)(JSON.parse(data ?? '')));
const parseMaintenanceClear = (data: string | undefined) =>
	Result.try(() => Schema.decodeUnknownSync(ReplicaSchemaMaintenanceClear)(JSON.parse(data ?? '')));
const parseDeltaBatch = (data: string | undefined) =>
	Result.try(() => Schema.decodeUnknownSync(SyncPullResponse)(JSON.parse(data ?? '')));
const parsePartition = (data: string | undefined) =>
	Result.try(() => {
		const parsed = JSON.parse(data ?? '') as unknown;
		const partition =
			parsed !== null && typeof parsed === 'object' ? Reflect.get(parsed, 'partition') : undefined;
		return Schema.decodeUnknownSync(SyncPartitionIdentity)(partition);
	});
const parseReady = (data: string | undefined) =>
	Result.try(() => Schema.decodeUnknownSync(PartitionReadyWire)(JSON.parse(data ?? '')));
const eventSourceFactory = (url: string): EventSourceLike => {
	const source = new EventSource(url, { withCredentials: true });
	return {
		addEventListener: (type, listener) =>
			source.addEventListener(type, (event) =>
				listener(event instanceof MessageEvent ? { data: String(event.data) } : {})
			),
		close: () => source.close(),
		set onerror(listener: ((event: unknown) => void) | null) {
			source.onerror = listener;
		}
	};
};

const normalizeCollections = (collections: ReadonlyArray<string>): ReadonlyArray<string> =>
	[...new Set(collections.map((name) => name.trim()).filter((name) => name.length > 0))].sort();

const normalizeMutationIds = (ids: ReadonlyArray<string> = []): ReadonlyArray<string> => {
	const normalized = [...new Set(ids.filter((id) => id.length > 0))].sort();
	if (normalized.length > 256 || normalized.some((id) => id.length > 256))
		throw new TypeError('A partition stream accepts at most 256 mutation ids of at most 256 characters.');
	return normalized;
};

const partitionStreamUrl = (
	base: string,
	collections: ReadonlyArray<string>,
	position: PartitionStreamPosition,
	pendingMutationIds: ReadonlyArray<string>,
	rehydration?: SyncRehydrationCost
): string => {
	const query = new URLSearchParams();
	for (const collection of normalizeCollections(collections)) query.append('collection', collection);
	for (const mutationId of normalizeMutationIds(pendingMutationIds))
		query.append('pendingMutationId', mutationId);
	query.set('cursor', JSON.stringify(position.cursor));
	query.set('generations', JSON.stringify(position.generations));
	if (rehydration !== undefined) query.set('rehydration', JSON.stringify(rehydration));
	return `${base}${base.includes('?') ? '&' : '?'}${query.toString()}`;
};

/**
 * Opens the single leader-owned dependency stream for a partition.
 *
 * Collection names are only subscription requests. The authenticated host re-derives the partition
 * and validates every requested dependency, so this URL conveys no authority. Updating the mounted
 * dependency union replaces this connection; it never creates one stream per query/page.
 */
export const subscribeToPartition = (
	options: PartitionSubscribeOptions
): PartitionSubscription => {
	const create = options.source ?? eventSourceFactory;
	let stopped = false;
	let current: EventSourceLike | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let collections = normalizeCollections(options.collections);
	let position = options.position;
	let pendingMutationIds = normalizeMutationIds(options.pendingMutationIds);
	let rehydration = options.rehydration;
	let signature = '';

	const reportAndReopen = (cause: unknown, source?: EventSourceLike): void => {
		options.onError?.(cause);
		source?.close();
		if (current === source) current = undefined;
		if (retry === undefined && !stopped) {
			retry = setTimeout(() => {
				retry = undefined;
				open();
			}, RETRY_OPEN_MILLIS);
		}
	};
	const decode = <Value>(
		source: EventSourceLike,
		parsed: Result.Result<Value, unknown>,
		accept: (value: Value) => void
	): void => {
		if (Result.isSuccess(parsed)) {
			accept(parsed.success);
			return;
		}
		reportAndReopen(parsed.failure, source);
	};
	const open = (): void => {
		// An empty subscription is a workspace with no collections, not a reason to stay closed.
		if (stopped || current !== undefined || collections.length === 0) return;
		options.onConnecting?.();
		const nextSignature = JSON.stringify(collections);
		const opened = Result.try(() =>
			create(
				partitionStreamUrl(
					workspaceSession().syncStreamUrl,
					collections,
					position,
					pendingMutationIds,
					rehydration
				)
			)
		);
		if (Result.isFailure(opened)) {
			reportAndReopen(opened.failure);
			return;
		}
		const source = opened.success;
		current = source;
		signature = nextSignature;
		source.addEventListener('ready', (event) =>
			decode(source, parseReady(event.data), (ready) => options.onReady?.(ready))
		);
		source.addEventListener('deltas', (event) =>
			decode(source, parseDeltaBatch(event.data), (batch) => {
				if (batch.kind !== 'delta') return reportAndReopen(new Error('Delta event carried a recovery frame'), source);
				options.onDeltas(batch as PartitionDeltaBatch);
			})
		);
		source.addEventListener('cursor-expired', (event) =>
			decode(source, parseDeltaBatch(event.data), (advice) => {
				if (advice.kind !== 'cursorExpired') return reportAndReopen(new Error('Cursor-expired event carried another frame'), source);
				options.onRecovery(advice as PartitionRecoveryAdvice);
			})
		);
		source.addEventListener('rehydrate-advised', (event) =>
			decode(source, parseDeltaBatch(event.data), (advice) => {
				if (advice.kind !== 'rehydrateAdvised') return reportAndReopen(new Error('Rehydrate event carried another frame'), source);
				options.onRecovery(advice as PartitionRecoveryAdvice);
			})
		);
		source.addEventListener('generation', (event) =>
			decode(source, parseDeltaBatch(event.data), (batch) => {
				if (batch.kind !== 'delta')
					return reportAndReopen(new Error('Generation event carried a recovery frame'), source);
				options.onDeltas(batch as PartitionDeltaBatch);
			})
		);
		source.addEventListener('partition-changed', (event) =>
			decode(source, parsePartition(event.data), (partition) => options.onPartitionChanged?.(partition))
		);
		source.addEventListener('schema-barrier', (event) =>
			decode(source, parseBarrier(event.data), (barrier) => options.onBarrier?.(barrier))
		);
		source.addEventListener('schema-maintenance', (event) =>
			decode(source, parseMaintenance(event.data), (notice) => options.onMaintenance?.(notice))
		);
		source.addEventListener('schema-maintenance-clear', (event) =>
			decode(source, parseMaintenanceClear(event.data), (clear) =>
				options.onMaintenanceClear?.(clear)
			)
		);
		source.onerror = (event) => reportAndReopen(event, source);
	};

	open();
	return {
		update: (nextCollections, nextPosition, nextPendingMutationIds, nextRehydration) => {
			if (stopped) return;
			collections = normalizeCollections(nextCollections);
			position = nextPosition;
			pendingMutationIds = normalizeMutationIds(nextPendingMutationIds);
			rehydration = nextRehydration;
			// Cursor, mutation-status and cost facts advance on the live connection itself; they are
			// retained here only so a reconnect resumes from the newest values.
			const nextSignature = JSON.stringify(collections);
			// The stream is not re-targeted by a dependency change.
			//
			// Its subscription is the whole workspace and fixed for the session, so `collections` can no
			// longer differ between calls; cursor, mutation status and cost facts advance on the live
			// connection. Closing and reopening here is what made "connected" a property of whichever
			// surface happened to be mounted.
			signature = nextSignature;
			open();
		},
		stop: () => {
			stopped = true;
			if (retry !== undefined) clearTimeout(retry);
			retry = undefined;
			current?.close();
			current = undefined;
		}
	};
};
