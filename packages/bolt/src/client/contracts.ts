// repository-health:allow SEM_PARALLEL -- contract <-> runtime: runtime.ts consumes the client contract surface, linked through the #lib/client alias my probe cannot see.
import type {
	CollectionMutationIdempotencyKey,
	InvocationScope,
	SyncOutcome
} from '@norbital-ai/bolt-protocol';
import type {
	CollectionMutationPendingApproval,
	CollectionMutationSettlementStatus,
	RemoteQuery
} from '@norbital-ai/std/collection';
import type { Schema } from 'effect';
import type { ClientState } from './sync/machine.js';
import type { SyncClient } from './sync/client.js';

/** The transport a Bolt client speaks over; the host owns routing, credentials and headers. */
export type BoltTransport = Readonly<{
	readonly command: (
		command: string,
		input: Schema.Json,
		signal?: AbortSignal,
		headers?: Readonly<Record<string, string>>
	) => Promise<unknown>; // repository-health:allow EFF2 -- Fetch-compatible transports expose the browser Promise protocol and createBoltClient immediately adapts it with Effect.tryPromise.
}>;

/** The typed browser command seam; every internal workflow immediately adapts it into Effect. */
export type BoltClient = Readonly<{
	readonly scope: InvocationScope;
	readonly command: <S extends Schema.Top>(
		command: string,
		input: Schema.Json,
		output: S,
		signal?: AbortSignal,
		headers?: Readonly<Record<string, string>>
	) => Promise<Schema.Schema.Type<S>>; // repository-health:allow EFF2 -- BoltClient is the public browser command seam; every internal workflow immediately adapts it with Effect.tryPromise.
}>;

export type { RemoteQuery };
export type { CollectionMutationValues } from '#lib/authoring/contracts-schema.js';

/** Public settlement vocabulary projected one-to-one from the protocol's terminal write status. */
export type MutationSettlement = Readonly<
	| {
			readonly kind: 'accepted';
			readonly idempotencyKey: string;
			readonly settledAtEpochMs: number;
			readonly pendingApproval?: CollectionMutationPendingApproval;
	  }
	| {
			readonly kind: 'rebased';
			readonly idempotencyKey: string;
			readonly fromSchemaFingerprint: string;
			readonly toSchemaFingerprint: string;
			readonly settledAtEpochMs: number;
	  }
	| {
			readonly kind: 'rejected';
			readonly idempotencyKey: string;
			readonly code: string;
			readonly message: string;
			readonly settledAtEpochMs: number;
	  }
	| {
			readonly kind: 'quarantined';
			readonly idempotencyKey: string;
			readonly quarantine: Readonly<{
				readonly code: string;
				readonly message: string;
				readonly atEpochMs: number;
			}>;
			readonly settledAtEpochMs: number;
	  }
>;

/** The std settlement vocabulary is the authority; this adds only the Machine's queue phases. */
export type MutationSettlementStatus = CollectionMutationSettlementStatus | 'queued' | 'sent';

export type MutationSettlementHandle = Readonly<{
	readonly idempotencyKey: string;
	readonly settled: Promise<MutationSettlement>;
	readonly status: () => Promise<MutationSettlementStatus>;
	readonly wait: (signal?: AbortSignal) => Promise<MutationSettlement>;
}>;

/** A mutation accepted into this tab's in-memory queue; authority settles it asynchronously. */
export type MemoryMutationResult<Row extends object = Readonly<Record<string, Schema.Json>>> =
	Readonly<{
		readonly durability: 'memory';
		readonly pending: true;
		readonly row: Row | null;
		readonly idempotencyKey: string;
		readonly settlement: MutationSettlementHandle;
	}>;

/** Promise resolvers are runtime wiring, while all observable write state remains in the Machine. */
export type MutationSettlements = Readonly<{
	readonly create: (id: CollectionMutationIdempotencyKey) => MutationSettlementHandle;
	readonly accept: (outcomes: ReadonlyArray<SyncOutcome>) => void;
}>;

export type WorkspaceClientRuntime = Readonly<{
	readonly db: Readonly<Record<string, unknown>>;
	readonly bolt: BoltClient;
	readonly sync: SyncClient;
	readonly mutation: Readonly<{
		readonly partitionKey: string;
		readonly schemaFingerprint: string;
	}>;
	/** Reactive view of the Machine's state for the generated framework shell. */
	readonly syncStatus: ClientState;
	readonly settlements: MutationSettlements;
}>;

export type BrowserWorkspaceRuntimeOptions = Readonly<{
	readonly transport?: BoltTransport;
	readonly tenantId?: string;
	readonly environment?: string;
	readonly releaseId?: string;
	/** Baked into the generated client from the exact schema lineage shipped in this artifact. */
	readonly schemaFingerprint?: string;
}>;
