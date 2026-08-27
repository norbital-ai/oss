// repository-health:allow SEM_PARALLEL -- contract <-> runtime: runtime.ts consumes the client contract surface, linked through the #lib/client alias my probe cannot see.
import type { RemoteQuery } from '@norbital-ai/std/collection';
import type { InvocationScope } from '@norbital-ai/bolt-protocol';
import type { Schema } from 'effect';
import type { QueryCache } from './replica/query-cache.js';
import type { LiveQueryRegistry } from './replica/live-queries.js';
import type { LocalReader } from './replica/local-reads.js';
import type { WorkspaceSyncStatusSignal } from './replica/sync-status.js';

/** The transport a bolt client speaks over; the seam between a page and the workspace runtime. */
export type BoltTransport = Readonly<{
	readonly command: (command: string, input: Schema.Json, signal?: AbortSignal) => Promise<unknown>; // repository-health:allow EFF2 -- Fetch-compatible transports expose the browser Promise protocol and createBoltClient immediately adapts it with Effect.tryPromise.
}>;

/** The typed browser command seam; every internal workflow immediately adapts its decoded Promise into Effect. */
export type BoltClient = Readonly<{
	readonly scope: InvocationScope;
	readonly command: <S extends Schema.ConstraintDecoder<unknown>>(
		command: string,
		input: Schema.Json,
		output: S,
		signal?: AbortSignal
	) => Promise<S['Type']>; // repository-health:allow EFF2 -- BoltClient is the public browser command seam; every internal workflow immediately adapts its decoded Promise into Effect.
}>;

export type { RemoteQuery };
export type { CollectionMutationValues } from '#lib/authoring/contracts-schema.js';
export type {
	LocallyDurableMutationResult,
	MutationSettlement,
	MutationSettlementHandle,
	MutationSettlementStatus
} from './replica/mutation-journal.js';

export type WorkspaceClientRuntime = Readonly<{
	readonly db: Readonly<Record<string, unknown>>;
	readonly bolt: BoltClient;
	/**
	 * The sync engine's read cache and the live queries it invalidates.
	 *
	 * Optional together: a runtime built without them — the test harness, a caller outside a browser —
	 * issues every read over the wire exactly as before, rather than taking a second code path through
	 * a cache that has nowhere to persist to.
	 */
	readonly cache?: QueryCache;
	readonly queries?: LiveQueryRegistry;
	/** Platform-owned online/offline, proof freshness and mutation settlement signal. */
	readonly syncStatus?: WorkspaceSyncStatusSignal;
	/**
	 * Where the replica installs its reader once it is up.
	 *
	 * A mutable slot rather than a constructor argument because the ordering is fixed the other way:
	 * pages are rendering, and therefore reading, long before several megabytes of WebAssembly have
	 * finished loading. Reads before that go to the server, which is simply how it worked before.
	 */
	readonly local?: { current?: LocalReader };
}>;

export type BrowserWorkspaceRuntimeOptions = Readonly<{
	readonly transport?: BoltTransport;
	readonly tenantId?: string;
	readonly environment?: string;
	readonly releaseId?: string;
}>;
