import { type Schema } from 'effect';
import type {
	CollectionMutationPushState,
	CollectionMutationQuarantine,
	CollectionMutationSettlement,
	CollectionMutationSettlementHandle,
	CollectionMutationSettlementStatus,
	LocallyDurableCollectionMutationResult
} from '@norbital-ai/std/collection';
import {
	COLLECTION_MUTATION_SCHEMA_COMPATIBILITY_HORIZON_MILLIS,
	type CollectionMutationBaseVersion,
	type CollectionMutationGraph as ProtocolCollectionMutationGraph,
	type CollectionMutationPush
} from '@norbital-ai/bolt-protocol';
import {
	overlayReferences,
	overlayRowKey,
	type MutationOverlayOperation,
	type OverlayMutation,
	type OverlayRowReference
} from './overlay.js';

/** The server promises compatibility for offline-authored mutations for this long after authoring. */
const SUPPORTED_OFFLINE_MUTATION_HORIZON_MS =
	COLLECTION_MUTATION_SCHEMA_COMPATIBILITY_HORIZON_MILLIS;
/** A tab that vanished while sending cannot own a journal entry forever. Server dedup makes retry safe. */
/** The exact lease after which another owner may replay the same idempotent mutation. */
export const MUTATION_PUSH_STALE_AFTER_MS = 30_000;

/** The exact operation fields the runtime adds durable identity and ordering to before transport. */
export type CollectionMutationGraph = ProtocolCollectionMutationGraph;

/** One whole-row optimistic-concurrency fence captured before the local mutation is accepted. */
export type MutationBaseRowVersion = CollectionMutationBaseVersion;

export type CollectionMutationWireRequest = CollectionMutationPush;

/** A complete locally-authored v2 mutation graph and its whole-row concurrency vector. */
export type CollectionMutationJournalDraft = CollectionMutationGraph &
	Readonly<{
		/** Exact opaque identity returned by the server's Sync.positions proof. */
		readonly serverPartitionKey: string;
		/** Credential-free local replica binding of the authenticated principal and authority. */
		readonly localActorBinding: string;
		readonly baseVersions: ReadonlyArray<MutationBaseRowVersion>;
		readonly overlay: ReadonlyArray<MutationOverlayOperation>;
		readonly compatibilityHorizonMs?: number;
	}>;

export type MutationCompatibilityHorizon = Readonly<{
	readonly authoredAtEpochMs: number;
	readonly expiresAtEpochMs: number;
	readonly durationMs: number;
}>;

export type MutationAuthoritativeCursor = Readonly<{
	readonly xid: number;
	readonly sequence: number;
}>;

/** Exact O1 provenance observed after the authority stamped this mutation's idempotency key. */
export type MutationAuthoritativeChange = Readonly<{
	readonly mutationId: string;
	readonly row: OverlayRowReference;
	readonly kind: 'upsert' | 'remove';
	readonly rowVersion: number;
}>;

/** Sync delta input. `null` means the row was not produced by a tracked browser mutation. */
export type MutationAuthoritativeDelta = Readonly<{
	readonly mutationId: string | null;
	readonly row: OverlayRowReference;
	readonly kind: 'upsert' | 'remove';
	readonly rowVersion: number;
}>;

export type MutationAuthoritativeConfirmation = Readonly<{
	readonly mutationId: string;
	/** Cursor after the server scan crossed the entire committed mutation, including invisible rows. */
	readonly cursor: MutationAuthoritativeCursor;
}>;

export type MutationAuthoritativeRejection = Readonly<{
	readonly mutationId: string;
	readonly code: 'refused' | 'forbidden';
	readonly message: string;
}>;

export type MutationOverlayRejection = Readonly<{
	readonly mutationId: string;
	readonly code: string;
	readonly message: string;
}>;

export type MutationAuthoritativeProgress = Readonly<{
	readonly changes: ReadonlyArray<MutationAuthoritativeChange>;
	readonly confirmation?: MutationAuthoritativeConfirmation;
}>;

export type MutationPushState = CollectionMutationPushState;
export type MutationQuarantine = CollectionMutationQuarantine;

/** One logical mutation, durably replayable under its original identity after reload or M3. */
export type ReservedCollectionMutation = CollectionMutationGraph &
	Readonly<{
		/** Verbatim authored graph retained for the v2 push and schema compatibility adapter. */
		readonly graph: CollectionMutationGraph;
		readonly partitionKey: string;
		readonly localActorBinding: string;
		readonly schemaFingerprint: string;
		readonly idempotencyKey: string;
		/** Never changes during compatibility adaptation or rebase. */
		readonly originalIdempotencyKey: string;
		readonly deviceSequence: number;
		readonly issuedAtEpochMs: number;
		readonly baseVersions: ReadonlyArray<MutationBaseRowVersion>;
		readonly overlay: ReadonlyArray<MutationOverlayOperation>;
		readonly compatibility: MutationCompatibilityHorizon;
		readonly authoritative: MutationAuthoritativeProgress;
		/** Durable M4 acknowledgement; overlay retirement still waits for exact O1 confirmation. */
		readonly authoritySettlement: SuccessfulMutationSettlement | null;
		readonly pushState: MutationPushState;
		readonly pushAttempts: number;
		readonly lastAttemptAtEpochMs?: number;
		readonly lastPushError?: string;
		readonly quarantine?: MutationQuarantine;
	}>;

export type MutationSettlement = CollectionMutationSettlement;
export type MutationSettlementStatus = CollectionMutationSettlementStatus;
type SuccessfulMutationSettlement = Extract<
	MutationSettlement,
	{ readonly kind: 'accepted' | 'rebased' }
>;

/** Durable terminal work the platform shell must surface even if it subscribed after settlement. */
export type MutationSyncIssue = Extract<
	MutationSettlement,
	{ readonly kind: 'rejected' | 'quarantined' }
>;

export type MutationJournalItem = Readonly<{
	readonly idempotencyKey: string;
	readonly deviceSequence: number;
	readonly collection: string;
	readonly action: CollectionMutationGraph['action'];
	readonly schemaFingerprint: string;
	readonly issuedAtEpochMs: number;
	readonly pushState: MutationPushState;
	readonly pushAttempts: number;
	readonly quarantine?: MutationQuarantine;
}>;

export type MutationJournalSnapshot = Readonly<{
	readonly mutations: ReadonlyArray<MutationJournalItem>;
	readonly issues: ReadonlyArray<MutationSyncIssue>;
}>;

/** Read-only shell seam. It never exposes mutation graphs or raw durable storage. */
export type MutationJournalMonitor = Readonly<{
	readonly snapshot: () => Promise<MutationJournalSnapshot>;
	readonly subscribe: (listener: (snapshot: MutationJournalSnapshot) => void) => () => void;
	readonly dismissIssue: (idempotencyKey: string) => Promise<void>;
}>;

/** A result-independent handle: server-computed fields arrive through settlement or reactive reads. */
export type MutationSettlementHandle = CollectionMutationSettlementHandle;

/** The explicit new meaning of `await mutate()`: durable and reflected locally, not yet committed. */
export type LocallyDurableMutationResult<Row extends object> =
	LocallyDurableCollectionMutationResult<Row>;

export type MutationReconciliation = Readonly<
	| {
			readonly kind: 'accepted';
	  }
	| {
			readonly kind: 'rebased';
			readonly fromSchemaFingerprint: string;
			readonly toSchemaFingerprint: string;
	  }
	| {
			readonly kind: 'rejected';
			readonly code: string;
			readonly message: string;
	  }
	| {
			readonly kind: 'quarantined';
			readonly code: MutationQuarantine['code'];
			readonly message: string;
	  }
>;

type MutationOverlayRetirementBase = Readonly<{
	readonly idempotencyKey: string;
	readonly deviceSequence: number;
	readonly affectedRows: ReadonlyArray<OverlayRowReference>;
	readonly affectedCollections: ReadonlyArray<string>;
	readonly authoritativeChanges: ReadonlyArray<MutationAuthoritativeChange>;
}>;

export type MutationOverlayRetirement = MutationOverlayRetirementBase &
	Readonly<
		| {
				readonly reason: 'authoritative-confirmation';
				readonly confirmationCursor: MutationAuthoritativeCursor;
		  }
		| {
				readonly reason: 'rejected';
				readonly rejection: MutationOverlayRejection;
		  }
	>;

export type MutationReconciliationResult = Readonly<{
	readonly mutation?: ReservedCollectionMutation;
	/** Present only when an earlier O1 confirmation raced ahead of the push response. */
	readonly retirement?: MutationOverlayRetirement;
}>;

export type MutationAuthoritativeBatch = Readonly<{
	readonly deltas: ReadonlyArray<MutationAuthoritativeDelta>;
	readonly confirmations: ReadonlyArray<MutationAuthoritativeConfirmation>;
	readonly mutationRejections: ReadonlyArray<MutationAuthoritativeRejection>;
}>;

export type MutationAuthoritativeBatchResult = Readonly<{
	/** Returned after durable overlay removal; callers may now dirty and recompute these windows. */
	readonly retirements: ReadonlyArray<MutationOverlayRetirement>;
}>;

export type MutationJournalStorage = Readonly<{
	readonly getItem: (key: string) => string | null;
	readonly setItem: (key: string, value: string) => void;
}>;

export type MutationJournalLocks = Readonly<{
	readonly request: <A>(name: string, callback: () => A | PromiseLike<A>) => Promise<A>;
}>;

export type MutationJournalOptions = Readonly<{
	readonly storage?: MutationJournalStorage;
	readonly locks?: MutationJournalLocks;
	readonly now?: () => number;
	readonly randomId?: () => string;
}>;

export type MutationJournalIdentity = Readonly<{
	/** Exact opaque identity returned by the server's Sync.positions proof. */
	readonly serverPartitionKey: string;
	/** Existing local replica key derived from stable principal fingerprint + authority; never a secret. */
	readonly localActorBinding: string;
	readonly schemaFingerprint: string;
}>;

export class MutationJournalUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MutationJournalUnavailable';
	}
}

type JournalEntry = ReservedCollectionMutation & Readonly<{ readonly fingerprint: string }>;

type JournalEnvelope = Readonly<{
	readonly formatVersion: 2;
	readonly nextDeviceSequence: number;
	readonly entries: ReadonlyArray<JournalEntry>;
	readonly issues: ReadonlyArray<MutationSyncIssue>;
}>;

export type RegisteredMutationJournalIdentity = Readonly<{
	readonly serverPartitionKey: string;
	readonly schemaFingerprint: string;
	readonly localActorBinding: string;
}>;

type ActorJournalIdentityRegistry = Readonly<{
	readonly formatVersion: 2;
	readonly identities: ReadonlyArray<
		Readonly<{ readonly serverPartitionKey: string; readonly schemaFingerprint: string }>
	>;
}>;

const MAX_PENDING_MUTATIONS = 128;
const MAX_SYNC_ISSUES = 128;
const RFC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const memory = new Map<string, string>();
let localCriticalSection: Promise<void> = Promise.resolve();

const memoryStorage: MutationJournalStorage = {
	getItem: (key) => memory.get(key) ?? null,
	setItem: (key, value) => {
		memory.set(key, value);
	}
};

const canonicalJson = (value: Schema.Json): string => {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	return `{${Object.entries(value)
		.toSorted(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
		.join(',')}}`;
};

const sha256Hex = async (value: string): Promise<string> => {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isOverlayRowReference = (value: unknown): value is OverlayRowReference =>
	isObject(value) &&
	typeof value['collection'] === 'string' &&
	value['collection'].trim().length > 0 &&
	typeof value['recordId'] === 'string' &&
	value['recordId'].trim().length > 0;

const isBaseVersion = (value: unknown): value is MutationBaseRowVersion =>
	isObject(value) &&
	isOverlayRowReference(value['row']) &&
	(value['rowVersion'] === null ||
		(Number.isSafeInteger(value['rowVersion']) && Number(value['rowVersion']) >= 1));

const isAuthoritativeCursor = (value: unknown): value is MutationAuthoritativeCursor =>
	isObject(value) &&
	Number.isSafeInteger(value['xid']) &&
	Number.isSafeInteger(value['sequence']);

const isAuthoritativeChange = (value: unknown): value is MutationAuthoritativeChange =>
	isObject(value) &&
	typeof value['mutationId'] === 'string' &&
	value['mutationId'].trim().length > 0 &&
	isOverlayRowReference(value['row']) &&
	(value['kind'] === 'upsert' || value['kind'] === 'remove') &&
	Number.isSafeInteger(value['rowVersion']) &&
	Number(value['rowVersion']) >= 1;

const isAuthoritativeConfirmation = (
	value: unknown
): value is MutationAuthoritativeConfirmation =>
	isObject(value) &&
	typeof value['mutationId'] === 'string' &&
	value['mutationId'].trim().length > 0 &&
	isAuthoritativeCursor(value['cursor']);

const isAuthoritativeRejection = (value: unknown): value is MutationAuthoritativeRejection =>
	isObject(value) &&
	typeof value['mutationId'] === 'string' &&
	value['mutationId'].trim().length > 0 &&
	(value['code'] === 'refused' || value['code'] === 'forbidden') &&
	typeof value['message'] === 'string';

const isAuthoritativeProgress = (value: unknown): value is MutationAuthoritativeProgress =>
	isObject(value) &&
	Array.isArray(value['changes']) &&
	value['changes'].every(isAuthoritativeChange) &&
	(value['confirmation'] === undefined ||
		isAuthoritativeConfirmation(value['confirmation']));

const authoritativeProgressMatches = (
	value: MutationAuthoritativeProgress,
	idempotencyKey: string
): boolean =>
	value.changes.every((change) => change.mutationId === idempotencyKey) &&
	(value.confirmation === undefined || value.confirmation.mutationId === idempotencyKey);

const isOverlayOperation = (value: unknown): value is MutationOverlayOperation => {
	if (!isObject(value) || !isOverlayRowReference(value['row'])) return false;
	if (value['kind'] === 'remove') return true;
	return (
		(value['kind'] === 'merge' || value['kind'] === 'replace') && isObject(value['values'])
	);
};

const isCompatibility = (value: unknown): value is MutationCompatibilityHorizon =>
	isObject(value) &&
	Number.isSafeInteger(value['authoredAtEpochMs']) &&
	Number.isSafeInteger(value['expiresAtEpochMs']) &&
	Number.isSafeInteger(value['durationMs']) &&
	Number(value['durationMs']) > 0 &&
	Number(value['expiresAtEpochMs']) ===
		Number(value['authoredAtEpochMs']) + Number(value['durationMs']);

const isPushState = (value: unknown): value is MutationPushState =>
	value === 'queued' ||
	value === 'pushing' ||
	value === 'awaiting-authoritative-delta' ||
	value === 'quarantined';

const isQuarantine = (value: unknown): value is MutationQuarantine =>
	isObject(value) &&
	(value['code'] === 'compatibility-horizon-expired' ||
		value['code'] === 'schema-incompatible' ||
		value['code'] === 'manual-review') &&
	typeof value['message'] === 'string' &&
	Number.isSafeInteger(value['atEpochMs']);

const isSyncIssue = (value: unknown): value is MutationSyncIssue =>
	isObject(value) &&
	typeof value['idempotencyKey'] === 'string' &&
	Number.isSafeInteger(value['settledAtEpochMs']) &&
	((value['kind'] === 'rejected' &&
		typeof value['code'] === 'string' &&
		typeof value['message'] === 'string') ||
		(value['kind'] === 'quarantined' && isQuarantine(value['quarantine'])));

const isSuccessfulMutationSettlement = (
	value: unknown
): value is SuccessfulMutationSettlement =>
	isObject(value) &&
	typeof value['idempotencyKey'] === 'string' &&
	value['idempotencyKey'].trim().length > 0 &&
	Number.isSafeInteger(value['settledAtEpochMs']) &&
	(value['kind'] === 'accepted' ||
		(value['kind'] === 'rebased' &&
			typeof value['fromSchemaFingerprint'] === 'string' &&
			value['fromSchemaFingerprint'].trim().length > 0 &&
			typeof value['toSchemaFingerprint'] === 'string' &&
			value['toSchemaFingerprint'].trim().length > 0));

const isCollectionMutationGraph = (value: unknown): value is CollectionMutationGraph =>
	isObject(value) &&
	typeof value['collection'] === 'string' &&
	value['collection'].trim().length > 0 &&
	(value['action'] === 'delete'
		? typeof value['id'] === 'string' && value['id'].trim().length > 0
		: (value['action'] === 'create' || value['action'] === 'update') && isObject(value['values']));

const graphMatchesEntry = (value: Readonly<Record<string, unknown>>): boolean => {
	const graph = value['graph'];
	if (!isCollectionMutationGraph(graph)) return false;
	if (graph.action !== value['action'] || graph.collection !== value['collection']) return false;
	return graph.action === 'delete'
		? graph.id === value['id']
		: isObject(value['values']) &&
			canonicalJson(graph.values) === canonicalJson(value['values'] as Schema.Json);
};

const isJournalEntry = (value: unknown): value is JournalEntry =>
	isObject(value) &&
	graphMatchesEntry(value) &&
	typeof value['fingerprint'] === 'string' &&
	typeof value['partitionKey'] === 'string' &&
	typeof value['localActorBinding'] === 'string' &&
	value['localActorBinding'].trim().length > 0 &&
	typeof value['schemaFingerprint'] === 'string' &&
	typeof value['idempotencyKey'] === 'string' &&
	value['originalIdempotencyKey'] === value['idempotencyKey'] &&
	Number.isSafeInteger(value['deviceSequence']) &&
	Number.isSafeInteger(value['issuedAtEpochMs']) &&
	Array.isArray(value['baseVersions']) &&
	value['baseVersions'].every(isBaseVersion) &&
	Array.isArray(value['overlay']) &&
	value['overlay'].every(isOverlayOperation) &&
	isCompatibility(value['compatibility']) &&
	isAuthoritativeProgress(value['authoritative']) &&
	authoritativeProgressMatches(value['authoritative'], String(value['idempotencyKey'])) &&
	(value['authoritySettlement'] === null ||
		(isSuccessfulMutationSettlement(value['authoritySettlement']) &&
			value['authoritySettlement'].idempotencyKey === value['idempotencyKey'])) &&
	isPushState(value['pushState']) &&
	Number.isSafeInteger(value['pushAttempts']) &&
	(value['lastAttemptAtEpochMs'] === undefined ||
		Number.isSafeInteger(value['lastAttemptAtEpochMs'])) &&
	(value['lastPushError'] === undefined || typeof value['lastPushError'] === 'string') &&
	(value['quarantine'] === undefined || isQuarantine(value['quarantine'])) &&
	(value['pushState'] === 'quarantined' ? isQuarantine(value['quarantine']) : true) &&
	(value['action'] === 'create' || value['action'] === 'update' || value['action'] === 'delete') &&
	typeof value['collection'] === 'string' &&
	value['collection'].trim().length > 0;

const emptyEnvelope = (): JournalEnvelope => ({
	formatVersion: 2,
	nextDeviceSequence: 1,
	entries: [],
	issues: []
});

const decodeJournal = (raw: string | null): JournalEnvelope => {
	if (raw === null) return emptyEnvelope();
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			!isObject(parsed) ||
			parsed['formatVersion'] !== 2 ||
			!Number.isSafeInteger(parsed['nextDeviceSequence']) ||
			!Array.isArray(parsed['entries']) ||
			!parsed['entries'].every(isJournalEntry) ||
			!Array.isArray(parsed['issues']) ||
			!parsed['issues'].every(isSyncIssue)
		)
			throw new TypeError('The browser mutation overlay journal has an invalid shape.');
		const envelope = parsed as JournalEnvelope;
		const identities = new Set(envelope.entries.map((entry) => entry.idempotencyKey));
		const sequences = new Set(envelope.entries.map((entry) => entry.deviceSequence));
		const greatestSequence = Math.max(0, ...envelope.entries.map((entry) => entry.deviceSequence));
		if (
			identities.size !== envelope.entries.length ||
			sequences.size !== envelope.entries.length ||
			envelope.nextDeviceSequence <= greatestSequence
		)
			throw new TypeError('The browser mutation overlay journal has conflicting identities.');
		return envelope;
	} catch (cause) {
		throw new MutationJournalUnavailable(
			`The browser mutation overlay journal cannot be read safely: ${cause instanceof Error ? cause.message : String(cause)}`
		);
	}
};

const defaultStorage = (): MutationJournalStorage => {
	if (typeof window === 'undefined') return memoryStorage;
	try {
		const storage = window.localStorage;
		storage.getItem('__bolt_mutation_journal_probe__');
		return storage;
	} catch (cause) {
		throw new MutationJournalUnavailable(
			`Durable browser storage is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`
		);
	}
};

const defaultLocks = (): MutationJournalLocks | undefined => {
	if (typeof navigator === 'undefined') return undefined;
	const locks = Reflect.get(navigator, 'locks');
	if (typeof locks !== 'object' || locks === null || typeof Reflect.get(locks, 'request') !== 'function')
		return undefined;
	return locks as MutationJournalLocks;
};

const inLocalCriticalSection = async <A>(operation: () => Promise<A>): Promise<A> => {
	const prior = localCriticalSection;
	let release: () => void = () => {};
	localCriticalSection = new Promise<void>((resolve) => {
		release = resolve;
	});
	await prior;
	try {
		return await operation();
	} finally {
		release();
	}
};

const actorJournalRegistry = async (
	localActorBinding: string
): Promise<Readonly<{ readonly storageKey: string; readonly lockName: string }>> => {
	if (localActorBinding.trim() === '')
		throw new MutationJournalUnavailable('The mutation journal owner binding is empty.');
	const digest = await sha256Hex(localActorBinding);
	return {
		storageKey: `bolt:mutation-overlay-identities:v2:${digest}`,
		lockName: `bolt:mutation-overlay-identities:${digest}`
	};
};

const decodeActorJournalRegistry = (raw: string | null): ActorJournalIdentityRegistry => {
	if (raw === null) return { formatVersion: 2, identities: [] };
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			!isObject(parsed) ||
			parsed['formatVersion'] !== 2 ||
			!Array.isArray(parsed['identities']) ||
			!parsed['identities'].every(
				(identity) =>
					isObject(identity) &&
					typeof identity['serverPartitionKey'] === 'string' &&
					identity['serverPartitionKey'].trim().length > 0 &&
					typeof identity['schemaFingerprint'] === 'string' &&
					identity['schemaFingerprint'].trim().length > 0
			)
		)
			throw new TypeError('The actor mutation-journal identity registry has an invalid shape.');
		return parsed as ActorJournalIdentityRegistry;
	} catch (cause) {
		throw new MutationJournalUnavailable(
			`The actor mutation-journal identity registry cannot be read safely: ${cause instanceof Error ? cause.message : String(cause)}`
		);
	}
};

const withRegistryLock = async <A>(
	locks: MutationJournalLocks | undefined,
	lockName: string,
	operation: () => Promise<A>
): Promise<A> =>
	locks === undefined ? inLocalCriticalSection(operation) : locks.request(lockName, operation);

/** Discovers payload-free identities for every physical journal previously opened by this actor. */
export const discoverCollectionMutationJournals = async (
	localActorBinding: string,
	options: Pick<MutationJournalOptions, 'storage' | 'locks'> = {}
): Promise<ReadonlyArray<RegisteredMutationJournalIdentity>> => {
	const storage = options.storage ?? defaultStorage();
	const locks = options.locks ?? defaultLocks();
	const registry = await actorJournalRegistry(localActorBinding);
	return withRegistryLock(locks, registry.lockName, async () =>
		decodeActorJournalRegistry(storage.getItem(registry.storageKey)).identities.map((identity) => ({
			...identity,
			localActorBinding
		}))
	);
};

const registerCollectionMutationJournal = async (
	identity: MutationJournalIdentity,
	storage: MutationJournalStorage,
	locks: MutationJournalLocks | undefined
): Promise<void> => {
	const registry = await actorJournalRegistry(identity.localActorBinding);
	await withRegistryLock(locks, registry.lockName, async () => {
		const current = decodeActorJournalRegistry(storage.getItem(registry.storageKey));
		if (
			current.identities.some(
				(candidate) =>
					candidate.serverPartitionKey === identity.serverPartitionKey &&
					candidate.schemaFingerprint === identity.schemaFingerprint
			)
		)
			return;
		try {
			storage.setItem(
				registry.storageKey,
				JSON.stringify({
					formatVersion: 2,
					identities: [
						...current.identities,
						{
							serverPartitionKey: identity.serverPartitionKey,
							schemaFingerprint: identity.schemaFingerprint
						}
					]
				} satisfies ActorJournalIdentityRegistry)
			);
		} catch (cause) {
			throw new MutationJournalUnavailable(
				`The actor mutation-journal identity registry cannot be persisted: ${cause instanceof Error ? cause.message : String(cause)}`
			);
		}
	});
};

const graphOf = (draft: CollectionMutationJournalDraft): CollectionMutationGraph =>
	draft.action === 'delete'
		? { action: 'delete', collection: draft.collection, id: draft.id }
		: { action: draft.action, collection: draft.collection, values: draft.values };

const wireFingerprintInput = (draft: CollectionMutationJournalDraft): Schema.Json => ({
	graph: graphOf(draft),
	baseVersions: draft.baseVersions
});

export type MutationGraphCatalog = Readonly<
	Record<
		string,
		Readonly<{
			readonly relationships?: ReadonlyArray<
				Readonly<{
					readonly name: string;
					readonly target: string;
					readonly cardinality: 'one' | 'many';
				}>
			>;
		}>
	>
>;

export type PreparedLocalCollectionMutation = Readonly<{
	readonly draft: CollectionMutationJournalDraft;
	/** Locally-known graph, including every stable id generated before durability. */
	readonly projectedRow: Readonly<Record<string, Schema.Json>>;
	readonly affectedCollections: ReadonlyArray<string>;
}>;

/**
 * Expands one declarative graph before journal reservation.
 *
 * Every new node receives its durable id exactly once. Every node that already had an id must have
 * an authoritative whole-row version; refusing a missing fence is safer than guessing that an
 * offline update is a create. Relationship arrays remain in the wire graph/projected result, while
 * row overlay operations contain only that collection's fields. The server uses the absence of a
 * base-version entry to distinguish a client-identified create from an update.
 */
export const prepareLocalCollectionMutation = (input: Readonly<{
	readonly catalog: MutationGraphCatalog;
	readonly collection: string;
	readonly values: Readonly<Record<string, Schema.Json>>;
	/** Mutations cannot be authored before a server proof binds this replica to exact current rights. */
	readonly serverPartitionKey: string | undefined;
	/** Local replica key derived from the stable principal fingerprint and rendered authority. */
	readonly localActorBinding: string | undefined;
	readonly rowVersion: (collection: string, recordId: string) => number | undefined;
	readonly randomId?: () => string;
}>): PreparedLocalCollectionMutation => {
	if (typeof input.serverPartitionKey !== 'string' || input.serverPartitionKey.trim() === '')
		throw new MutationJournalUnavailable(
			'The server partition proof is not known yet; complete sync partition bootstrap before mutating.'
		);
	if (typeof input.localActorBinding !== 'string' || input.localActorBinding.trim() === '')
		throw new MutationJournalUnavailable(
			'The authenticated local replica owner is not known yet; complete replica bootstrap before mutating.'
		);
	const serverPartitionKey = input.serverPartitionKey;
	const localActorBinding = input.localActorBinding;
	const randomId = input.randomId ?? (() => globalThis.crypto.randomUUID());
	const baseVersions: Array<MutationBaseRowVersion> = [];
	const overlay: Array<MutationOverlayOperation> = [];
	const affectedCollections = new Set<string>();
	const seen = new Set<string>();

	const visit = (
		collection: string,
		values: Readonly<Record<string, Schema.Json>>
	): Readonly<{ readonly values: Readonly<Record<string, Schema.Json>>; readonly created: boolean }> => {
		affectedCollections.add(collection);
		const submittedId = values['id'];
		if (submittedId !== undefined && (typeof submittedId !== 'string' || submittedId.trim() === ''))
			throw new TypeError(`Mutation ${collection} id must be a non-empty string`);
		const existingId = typeof submittedId === 'string' ? submittedId : undefined;
		const created = existingId === undefined;
		const recordId = existingId ?? randomId();
		if (recordId.trim() === '') throw new TypeError(`Mutation ${collection} generated an empty id`);
		if (created && !RFC_UUID.test(recordId))
			throw new TypeError(`Mutation ${collection} generated an id that is not an RFC UUID`);
		const reference = { collection, recordId };
		const referenceKey = overlayRowKey(reference);
		if (seen.has(referenceKey))
			throw new TypeError(`Mutation graph names ${collection} ${recordId} more than once`);
		seen.add(referenceKey);

		if (!created) {
			const version = input.rowVersion(collection, recordId);
			if (version === undefined)
				throw new Error(
					`Cannot update ${collection} ${recordId} without an authoritative row version; refetch it first.`
				);
			if (!Number.isSafeInteger(version) || version < 1)
				throw new TypeError(`Mutation ${collection} ${recordId} has an invalid row version`);
			baseVersions.push({ row: reference, rowVersion: version });
		}

		const relationships = new Map(
			(input.catalog[collection]?.relationships ?? [])
				.filter((relationship) => relationship.cardinality === 'many')
				.map((relationship) => [relationship.name, relationship] as const)
		);
		const graphValues: Record<string, Schema.Json> = { id: recordId };
		const rowValues: Record<string, Schema.Json> = { id: recordId };
		for (const [key, value] of Object.entries(values)) {
			if (key === 'id') continue;
			const relationship = relationships.get(key);
			if (relationship === undefined) {
				graphValues[key] = value;
				rowValues[key] = value;
				continue;
			}
			if (!Array.isArray(value))
				throw new TypeError(`Mutation relationship ${collection}.${key} must be an array`);
			graphValues[key] = value.map((child, index) => {
				if (!isObject(child))
					throw new TypeError(`Mutation relationship ${collection}.${key}[${index}] must be a record`);
				return visit(relationship.target, child as Readonly<Record<string, Schema.Json>>).values;
			});
		}
		overlay.push({ kind: created ? 'replace' : 'merge', row: reference, values: rowValues });
		return { values: graphValues, created };
	};

	const root = visit(input.collection, input.values);
	const draft: CollectionMutationJournalDraft = root.created
		? {
				action: 'create',
				collection: input.collection,
				values: root.values,
				serverPartitionKey,
				localActorBinding,
				baseVersions,
				overlay,
			}
		: {
				action: 'update',
				collection: input.collection,
				values: root.values,
				serverPartitionKey,
				localActorBinding,
				baseVersions,
				overlay,
			};
	return {
		draft,
		projectedRow: root.values,
		affectedCollections: [...affectedCollections]
	};
};

const mutationCompatibilityHorizon = (
	authoredAtEpochMs: number,
	durationMs = SUPPORTED_OFFLINE_MUTATION_HORIZON_MS
): MutationCompatibilityHorizon => {
	if (!Number.isSafeInteger(authoredAtEpochMs) || authoredAtEpochMs < 0)
		throw new TypeError('Mutation authored time must be a non-negative safe integer');
	if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
		throw new TypeError('Mutation compatibility horizon must be a positive safe integer');
	const expiresAtEpochMs = authoredAtEpochMs + durationMs;
	if (!Number.isSafeInteger(expiresAtEpochMs))
		throw new TypeError('Mutation compatibility expiry exceeds the safe integer range');
	return {
		authoredAtEpochMs,
		expiresAtEpochMs,
		durationMs
	};
};

const mutationCompatibilityAt = (
	compatibility: MutationCompatibilityHorizon,
	atEpochMs: number
): 'supported' | 'expired' =>
	atEpochMs <= compatibility.expiresAtEpochMs ? 'supported' : 'expired';

/** Projects a rich journal entry to the existing server mutation request. */
export const mutationWireRequest = (
	mutation: ReservedCollectionMutation
): CollectionMutationWireRequest => {
	return {
		protocolVersion: 2,
		idempotencyKey: mutation.originalIdempotencyKey,
		issuedAtEpochMs: mutation.issuedAtEpochMs,
		deviceSequence: mutation.deviceSequence,
		partitionKey: mutation.partitionKey,
		schemaFingerprint: mutation.schemaFingerprint,
		graph: mutation.graph,
		baseVersions: mutation.baseVersions
	} as CollectionMutationWireRequest;
};

/** Constructs the browser-facing local acknowledgement after the overlay view has rerun. */
export const locallyDurableMutationResult = <
	Row extends object
>(
	journal: Pick<CollectionMutationJournal, 'settlement'>,
	mutation: ReservedCollectionMutation,
	row: Row | null
): LocallyDurableMutationResult<Row> => ({
	durability: 'local',
	pending: true,
	row,
	idempotencyKey: mutation.originalIdempotencyKey,
	deviceSequence: mutation.deviceSequence,
	settlement: journal.settlement(mutation.originalIdempotencyKey)
});

const asOverlayMutation = (entry: JournalEntry): OverlayMutation => ({
	partitionKey: entry.partitionKey,
	localActorBinding: entry.localActorBinding,
	issuedAtEpochMs: entry.issuedAtEpochMs,
	idempotencyKey: entry.originalIdempotencyKey,
	deviceSequence: entry.deviceSequence,
	active: entry.pushState !== 'quarantined',
	operations: entry.overlay
});

const overlayRetirementOf = (
	entry: JournalEntry,
	confirmation: MutationAuthoritativeConfirmation
): MutationOverlayRetirement => {
	const affectedRows = overlayReferences(entry.overlay);
	return {
		idempotencyKey: entry.originalIdempotencyKey,
		deviceSequence: entry.deviceSequence,
		reason: 'authoritative-confirmation',
		confirmationCursor: confirmation.cursor,
		affectedRows,
		affectedCollections: [...new Set(affectedRows.map((row) => row.collection))],
		authoritativeChanges: entry.authoritative.changes
	};
};

const rejectedOverlayRetirementOf = (
	entry: JournalEntry,
	rejection: MutationOverlayRejection
): MutationOverlayRetirement => {
	const affectedRows = overlayReferences(entry.overlay);
	return {
		idempotencyKey: entry.originalIdempotencyKey,
		deviceSequence: entry.deviceSequence,
		reason: 'rejected',
		rejection,
		affectedRows,
		affectedCollections: [...new Set(affectedRows.map((row) => row.collection))],
		authoritativeChanges: entry.authoritative.changes
	};
};

export type CollectionMutationJournal = Readonly<{
	readonly reserve: (draft: CollectionMutationJournalDraft) => Promise<ReservedCollectionMutation>;
	/** Full durable entries used by bootstrap, overlay replay and the leader push worker. */
	readonly entries: () => Promise<ReadonlyArray<ReservedCollectionMutation>>;
	readonly nextPushable: (atEpochMs?: number) => Promise<ReservedCollectionMutation | undefined>;
	readonly markPushing: (idempotencyKey: string) => Promise<ReservedCollectionMutation>;
	readonly retry: (idempotencyKey: string, cause: unknown) => Promise<ReservedCollectionMutation>;
	readonly reconcile: (
		idempotencyKey: string,
		outcome: MutationReconciliation
	) => Promise<MutationReconciliationResult>;
	/** Accumulates exact mutation provenance across batches and retires only confirmed overlays. */
	readonly observeAuthoritativeBatch: (
		batch: MutationAuthoritativeBatch
	) => Promise<MutationAuthoritativeBatchResult>;
	/** Bounded exact ids the next pull asks the server to confirm after crossing their commits. */
	readonly pendingAuthoritativeMutationIds: () => Promise<ReadonlyArray<string>>;
	readonly settlement: (idempotencyKey: string) => MutationSettlementHandle;
	readonly overlay: () => Promise<ReadonlyArray<OverlayMutation>>;
	readonly protectedRows: () => Promise<ReadonlyArray<OverlayRowReference>>;
}> &
	MutationJournalMonitor;

/**
 * Opens the server-proven physical-partition mutation overlay journal.
 *
 * The opaque server key commits to schema, policy surface, impersonation and authority generation,
 * but policy-equivalent actors may share it. The local namespace therefore also includes the
 * credential-free replica owner binding (stable principal fingerprint plus rendered authority).
 * Compatibility bootstrap may reopen an old proven pair, while another login cannot discover it.
 */
export const createCollectionMutationJournal = async (
	identity: MutationJournalIdentity,
	options: MutationJournalOptions = {}
): Promise<CollectionMutationJournal> => {
	if (
		typeof identity.serverPartitionKey !== 'string' ||
		identity.serverPartitionKey.trim() === ''
	)
		throw new MutationJournalUnavailable(
			'The mutation journal cannot open until a server partition proof is known.'
		);
	if (
		typeof identity.localActorBinding !== 'string' ||
		identity.localActorBinding.trim() === ''
	)
		throw new MutationJournalUnavailable(
			'The mutation journal cannot open without its authenticated local replica owner.'
		);
	if (identity.schemaFingerprint.trim() === '')
		throw new TypeError('Mutation schema fingerprint is empty');
	const storage = options.storage ?? defaultStorage();
	const locks = options.locks ?? defaultLocks();
	await registerCollectionMutationJournal(identity, storage, locks);
	const namespaceDigest = await sha256Hex(
		canonicalJson({
			serverPartitionKey: identity.serverPartitionKey,
			localActorBinding: identity.localActorBinding
		})
	);
	const storageKey = `bolt:mutation-overlay:v2:${namespaceDigest}`;
	const lockName = `bolt:mutation-overlay:${namespaceDigest}`;
	const now = options.now ?? Date.now;
	const randomId = options.randomId ?? (() => globalThis.crypto.randomUUID());
	const terminalOutcomes = new Map<string, MutationSettlement>();
	const listeners = new Set<(snapshot: MutationJournalSnapshot) => void>();
	type Deferred = Readonly<{
		readonly promise: Promise<MutationSettlement>;
		readonly resolve: (settlement: MutationSettlement) => void;
	}>;
	const deferred = new Map<string, Deferred>();
	const settlementDeferred = (idempotencyKey: string): Deferred => {
		const existing = deferred.get(idempotencyKey);
		if (existing !== undefined) return existing;
		let resolve: (settlement: MutationSettlement) => void = () => {};
		const promise = new Promise<MutationSettlement>((complete) => {
			resolve = complete;
		});
		const created = { promise, resolve };
		deferred.set(idempotencyKey, created);
		return created;
	};
	const complete = (settlement: MutationSettlement) => {
		terminalOutcomes.set(settlement.idempotencyKey, settlement);
		settlementDeferred(settlement.idempotencyKey).resolve(settlement);
	};
	const snapshotOf = (envelope: JournalEnvelope): MutationJournalSnapshot => ({
		mutations: envelope.entries.map((entry) => ({
			idempotencyKey: entry.idempotencyKey,
			deviceSequence: entry.deviceSequence,
			collection: entry.collection,
			action: entry.action,
			schemaFingerprint: entry.schemaFingerprint,
			issuedAtEpochMs: entry.issuedAtEpochMs,
			pushState: entry.pushState,
			pushAttempts: entry.pushAttempts,
			...(entry.quarantine === undefined ? {} : { quarantine: entry.quarantine })
		})),
		issues: envelope.issues
	});
	const notify = (envelope: JournalEnvelope) => {
		const snapshot = snapshotOf(envelope);
		for (const listener of listeners) {
			queueMicrotask(() => {
				try {
					listener(snapshot);
				} catch {
					// A view subscriber cannot make a durable journal transition fail.
				}
			});
		}
	};
	const write = (envelope: JournalEnvelope) => {
		try {
			storage.setItem(storageKey, JSON.stringify(envelope));
		} catch (cause) {
			throw new MutationJournalUnavailable(
				`The browser mutation overlay journal cannot be persisted: ${cause instanceof Error ? cause.message : String(cause)}`
			);
		}
		notify(envelope);
	};
	const locked = <A>(operation: () => Promise<A>): Promise<A> =>
		locks === undefined ? inLocalCriticalSection(operation) : locks.request(lockName, operation);
	const read = (): JournalEnvelope => decodeJournal(storage.getItem(storageKey));
	const entryWith = (entry: JournalEntry, changes: Partial<JournalEntry>): JournalEntry =>
		Object.assign({}, entry, changes);
	const replaceEntry = (
		envelope: JournalEnvelope,
		idempotencyKey: string,
		update: (entry: JournalEntry) => JournalEntry
	): Readonly<{ readonly envelope: JournalEnvelope; readonly entry: JournalEntry }> => {
		const index = envelope.entries.findIndex((entry) => entry.idempotencyKey === idempotencyKey);
		if (index < 0) throw new MutationJournalUnavailable('The mutation is not present in the journal.');
		const entry = update(envelope.entries[index] as JournalEntry);
		return {
			envelope: {
				...envelope,
				entries: envelope.entries.map((candidate, at) => (at === index ? entry : candidate))
			},
			entry
		};
	};
	const removeEntry = (envelope: JournalEnvelope, idempotencyKey: string): JournalEnvelope => ({
		...envelope,
		entries: envelope.entries.filter((entry) => entry.idempotencyKey !== idempotencyKey)
	});
	const withIssue = (envelope: JournalEnvelope, issue: MutationSyncIssue): JournalEnvelope => ({
		...envelope,
		issues: [
			...envelope.issues.filter(
				(candidate) => candidate.idempotencyKey !== issue.idempotencyKey
			),
			issue
		].slice(-MAX_SYNC_ISSUES)
	});

	const journal: CollectionMutationJournal = {
		reserve: (draft) =>
			locked(async () => {
				if (
					typeof draft.serverPartitionKey !== 'string' ||
					draft.serverPartitionKey.trim() === ''
				)
					throw new MutationJournalUnavailable(
						'The mutation is missing its server partition proof and cannot be made durable.'
					);
				if (draft.serverPartitionKey !== identity.serverPartitionKey)
					throw new MutationJournalUnavailable(
						'The mutation server partition proof changed before journal reservation; refetch under the current authority.'
					);
				if (
					typeof draft.localActorBinding !== 'string' ||
					draft.localActorBinding.trim() === ''
				)
					throw new MutationJournalUnavailable(
						'The mutation is missing its authenticated local replica owner and cannot be made durable.'
					);
				if (draft.localActorBinding !== identity.localActorBinding)
					throw new MutationJournalUnavailable(
						'The authenticated local replica owner changed before journal reservation; reopen under the current session.'
					);
				const at = now();
				const fingerprint = await sha256Hex(canonicalJson(wireFingerprintInput(draft)));
				const envelope = read();
				const existing = envelope.entries.find(
					(entry) => entry.fingerprint === fingerprint
				);
				if (existing !== undefined) {
					if (existing.pushState === 'quarantined')
						throw new MutationJournalUnavailable(
							'This logical mutation is quarantined and cannot be resubmitted without review.'
						);
					return existing;
				}
				const pendingCount = envelope.entries.length;
				if (pendingCount >= MAX_PENDING_MUTATIONS)
					throw new MutationJournalUnavailable(
						`The browser has ${MAX_PENDING_MUTATIONS} unsettled mutations; reconcile them before authoring another.`
					);
				const issuedAtEpochMs = at;
				const idempotencyKey = randomId();
				const deviceSequence = envelope.nextDeviceSequence;
				const graph = graphOf(draft);
				const entry = {
					...graph,
					graph,
					fingerprint,
					partitionKey: identity.serverPartitionKey,
					localActorBinding: identity.localActorBinding,
					schemaFingerprint: identity.schemaFingerprint,
					idempotencyKey,
					originalIdempotencyKey: idempotencyKey,
					deviceSequence,
					issuedAtEpochMs,
					baseVersions: draft.baseVersions,
					overlay: draft.overlay,
					compatibility: mutationCompatibilityHorizon(
						issuedAtEpochMs,
						draft.compatibilityHorizonMs
					),
					authoritative: { changes: [] },
					authoritySettlement: null,
					pushState: 'queued',
					pushAttempts: 0
				} as JournalEntry;
				write({
					formatVersion: 2,
					nextDeviceSequence: deviceSequence + 1,
					entries: [...envelope.entries, entry],
					issues: envelope.issues
				});
				settlementDeferred(idempotencyKey);
				return entry;
			}),
		entries: () => locked(async () => read().entries),
		nextPushable: (atEpochMs = now()) =>
			locked(async () => {
				const current = read();
				const expired = current.entries.filter(
					(entry) =>
						entry.pushState === 'queued' &&
						mutationCompatibilityAt(entry.compatibility, atEpochMs) === 'expired'
				);
				let envelope = current;
				const settlements: Array<MutationSyncIssue> = [];
				for (const expiredEntry of expired) {
					const quarantine: MutationQuarantine = {
						code: 'compatibility-horizon-expired',
						message:
							'The mutation is older than the supported offline compatibility horizon.',
						atEpochMs
					};
					const changed = replaceEntry(envelope, expiredEntry.idempotencyKey, (entry) =>
						entryWith(entry, { pushState: 'quarantined', quarantine })
					);
					envelope = changed.envelope;
					const settlement: MutationSyncIssue = {
						kind: 'quarantined',
						idempotencyKey: expiredEntry.idempotencyKey,
						quarantine,
						settledAtEpochMs: atEpochMs
					};
					settlements.push(settlement);
					envelope = withIssue(envelope, settlement);
				}
				const interrupted = envelope.entries.filter(
					(entry) =>
						entry.pushState === 'pushing' &&
						(entry.lastAttemptAtEpochMs === undefined ||
							entry.lastAttemptAtEpochMs <= atEpochMs - MUTATION_PUSH_STALE_AFTER_MS)
				);
				for (const interruptedEntry of interrupted) {
					const changed = replaceEntry(envelope, interruptedEntry.idempotencyKey, (entry) =>
						entryWith(entry, {
							pushState: 'queued',
							lastPushError: 'The previous push owner disappeared before recording an outcome.'
						})
					);
					envelope = changed.envelope;
				}
				if (expired.length > 0 || interrupted.length > 0) {
					write(envelope);
					for (const settlement of settlements) complete(settlement);
				}
				const earliest = envelope.entries
					.filter((entry) => entry.pushState === 'queued' || entry.pushState === 'pushing')
					.toSorted((left, right) => left.deviceSequence - right.deviceSequence)[0];
				return earliest?.pushState === 'queued' ? earliest : undefined;
			}),
		markPushing: (idempotencyKey) =>
			locked(async () => {
				const envelope = read();
				const changed = replaceEntry(envelope, idempotencyKey, (entry) => {
					if (entry.pushState !== 'queued')
						throw new MutationJournalUnavailable(
							`Cannot push a mutation while it is ${entry.pushState}.`
						);
					return entryWith(entry, {
						pushState: 'pushing',
						pushAttempts: entry.pushAttempts + 1,
						lastAttemptAtEpochMs: now()
					});
				});
				write(changed.envelope);
				return changed.entry;
			}),
		retry: (idempotencyKey, cause) =>
			locked(async () => {
				const envelope = read();
				const changed = replaceEntry(envelope, idempotencyKey, (entry) => {
					if (entry.pushState !== 'pushing')
						throw new MutationJournalUnavailable(
							`Cannot retry a mutation while it is ${entry.pushState}.`
						);
					return entryWith(entry, {
						pushState: 'queued',
						lastPushError: cause instanceof Error ? cause.message : String(cause)
					});
				});
				write(changed.envelope);
				return changed.entry;
			}),
		reconcile: (idempotencyKey, outcome) =>
			locked(async () => {
				const envelope = read();
				const existing = envelope.entries.find(
					(entry) => entry.idempotencyKey === idempotencyKey
				);
				if (existing === undefined)
					throw new MutationJournalUnavailable('The mutation is not present in the journal.');
				const settledAtEpochMs = now();
				if (outcome.kind === 'accepted' || outcome.kind === 'rebased') {
					const settlement: SuccessfulMutationSettlement =
						outcome.kind === 'accepted'
							? { kind: 'accepted', idempotencyKey, settledAtEpochMs }
							: {
									kind: 'rebased',
									idempotencyKey,
									fromSchemaFingerprint: outcome.fromSchemaFingerprint,
									toSchemaFingerprint: outcome.toSchemaFingerprint,
									settledAtEpochMs
								};
					const confirmation = existing.authoritative.confirmation;
					if (confirmation !== undefined) {
						const retirement = overlayRetirementOf(existing, confirmation);
						write(removeEntry(envelope, idempotencyKey));
						complete(settlement);
						return { retirement };
					}
					const changed = replaceEntry(envelope, idempotencyKey, (entry) =>
						entryWith(entry, {
							pushState: 'awaiting-authoritative-delta',
							authoritySettlement: settlement
						})
					);
					write(changed.envelope);
					complete(settlement);
					return { mutation: changed.entry };
				}
				if (outcome.kind === 'rejected') {
					const retirement = rejectedOverlayRetirementOf(existing, {
						mutationId: existing.originalIdempotencyKey,
						code: outcome.code,
						message: outcome.message
					});
					const settlement: MutationSyncIssue = {
						kind: 'rejected',
						idempotencyKey,
						code: outcome.code,
						message: outcome.message,
						settledAtEpochMs
					};
					write(withIssue(removeEntry(envelope, idempotencyKey), settlement));
					complete(settlement);
					return { retirement };
				}
				if (outcome.kind === 'quarantined') {
					const quarantine: MutationQuarantine = {
						code: outcome.code,
						message: outcome.message,
						atEpochMs: settledAtEpochMs
					};
					const changed = replaceEntry(envelope, idempotencyKey, (entry) =>
						entryWith(entry, { pushState: 'quarantined', quarantine })
					);
					const settlement: MutationSyncIssue = {
						kind: 'quarantined',
						idempotencyKey,
						quarantine,
						settledAtEpochMs
					};
					write(withIssue(changed.envelope, settlement));
					complete(settlement);
					return { mutation: changed.entry };
				}
				throw new TypeError('Unknown mutation reconciliation outcome.');
			}),
		observeAuthoritativeBatch: (batch) =>
			locked(async () => {
				const observedAtEpochMs = now();
				let envelope = read();
				let changed = false;
				const retirements: Array<MutationOverlayRetirement> = [];
				for (const delta of batch.deltas) {
					if (delta.mutationId === null) continue;
					if (!isAuthoritativeChange(delta))
						throw new TypeError('The authoritative mutation delta has an invalid shape.');
					const existing = envelope.entries.find(
						(entry) => entry.originalIdempotencyKey === delta.mutationId
					);
					if (existing === undefined) continue;
					const deltaKey = canonicalJson(delta as Schema.Json);
					if (
						existing.authoritative.changes.some(
							(candidate) => canonicalJson(candidate as Schema.Json) === deltaKey
						)
					)
						continue;
					const updated = replaceEntry(envelope, existing.idempotencyKey, (entry) =>
						entryWith(entry, {
							authoritative: {
								...entry.authoritative,
								changes: [...entry.authoritative.changes, delta]
							}
						})
					);
					envelope = updated.envelope;
					changed = true;
				}
				for (const confirmation of batch.confirmations) {
					if (!isAuthoritativeConfirmation(confirmation))
						throw new TypeError('The authoritative mutation confirmation has an invalid shape.');
					const existing = envelope.entries.find(
						(entry) => entry.originalIdempotencyKey === confirmation.mutationId
					);
					if (existing === undefined) continue;
					const updated = replaceEntry(envelope, existing.idempotencyKey, (entry) =>
						entryWith(entry, {
							authoritative: { ...entry.authoritative, confirmation }
						})
					);
					envelope = updated.envelope;
					changed = true;
				}
				for (const rejection of batch.mutationRejections) {
					if (!isAuthoritativeRejection(rejection))
						throw new TypeError('The authoritative mutation rejection has an invalid shape.');
					const existing = envelope.entries.find(
						(entry) => entry.originalIdempotencyKey === rejection.mutationId
					);
					if (existing === undefined) continue;
					const settlement: MutationSyncIssue = {
						kind: 'rejected',
						idempotencyKey: existing.originalIdempotencyKey,
						code: rejection.code,
						message: rejection.message,
						settledAtEpochMs: now()
					};
					retirements.push(rejectedOverlayRetirementOf(existing, rejection));
					envelope = withIssue(removeEntry(envelope, existing.idempotencyKey), settlement);
					complete(settlement);
					changed = true;
				}
				for (const entry of envelope.entries) {
					const confirmation = entry.authoritative.confirmation;
					const interruptedPushConfirmed =
						entry.pushState === 'pushing' &&
						(entry.lastAttemptAtEpochMs === undefined ||
							entry.lastAttemptAtEpochMs <=
								observedAtEpochMs - MUTATION_PUSH_STALE_AFTER_MS);
					if (
						(entry.pushState !== 'awaiting-authoritative-delta' &&
							!interruptedPushConfirmed) ||
						confirmation === undefined
					)
						continue;
					if (interruptedPushConfirmed) {
						complete({
							kind: 'accepted',
							idempotencyKey: entry.idempotencyKey,
							settledAtEpochMs: observedAtEpochMs
						});
					}
					retirements.push(overlayRetirementOf(entry, confirmation));
					envelope = removeEntry(envelope, entry.idempotencyKey);
					changed = true;
				}
				if (changed) write(envelope);
				return { retirements };
			}),
		pendingAuthoritativeMutationIds: () =>
			locked(async () =>
				read().entries
					.filter(
						(entry) =>
							entry.pushState === 'pushing' ||
							entry.pushState === 'awaiting-authoritative-delta'
					)
					.map((entry) => entry.originalIdempotencyKey)
				),
		settlement: (idempotencyKey) => {
			const persisted = read();
			const persistedIssue = persisted.issues.find(
				(issue) => issue.idempotencyKey === idempotencyKey
			);
			if (persistedIssue !== undefined && !terminalOutcomes.has(idempotencyKey))
				complete(persistedIssue);
			const persistedSettlement = persisted.entries.find(
				(entry) => entry.idempotencyKey === idempotencyKey
			)?.authoritySettlement;
			if (persistedSettlement !== undefined && persistedSettlement !== null &&
				!terminalOutcomes.has(idempotencyKey)) complete(persistedSettlement);
			const owned = settlementDeferred(idempotencyKey);
			const wait = (signal?: AbortSignal): Promise<MutationSettlement> => {
				if (signal === undefined) return owned.promise;
				if (signal.aborted) return Promise.reject(signal.reason);
				return new Promise<MutationSettlement>((resolve, reject) => {
					const abort = () => reject(signal.reason);
					signal.addEventListener('abort', abort, { once: true });
					void owned.promise.then(
						(value) => {
							signal.removeEventListener('abort', abort);
							resolve(value);
						},
						(cause: unknown) => {
							signal.removeEventListener('abort', abort);
							reject(cause);
						}
					);
				});
			};
			return {
				idempotencyKey,
				settled: owned.promise,
				wait,
				status: () =>
					locked(async () => {
						const terminal = terminalOutcomes.get(idempotencyKey);
						if (terminal !== undefined) return terminal.kind;
						return (
							read().entries.find(
								(entry) => entry.idempotencyKey === idempotencyKey
							)?.pushState ?? 'unknown'
						);
					})
			};
		},
		overlay: () =>
			locked(async () => read().entries.map((entry) => asOverlayMutation(entry))),
		protectedRows: () =>
			locked(async () => {
				const references = new Map<string, OverlayRowReference>();
				for (const entry of read().entries) {
					for (const row of overlayReferences(entry.overlay))
						references.set(`${row.collection}\u0000${row.recordId}`, row);
				}
				return [...references.values()];
			}),
		snapshot: () => locked(async () => snapshotOf(read())),
		subscribe: (listener) => {
			listeners.add(listener);
			const initial = snapshotOf(read());
			queueMicrotask(() => {
				if (!listeners.has(listener)) return;
				try {
					listener(initial);
				} catch {
					// A view subscriber cannot make journal construction or another subscriber fail.
				}
			});
			return () => listeners.delete(listener);
		},
		dismissIssue: (idempotencyKey) =>
			locked(async () => {
				const envelope = read();
				write({
					...envelope,
					issues: envelope.issues.filter(
						(issue) => issue.idempotencyKey !== idempotencyKey
					)
				});
			})
	};
	return journal;
};
