/**
 * Client-side mirror of the `/_runtime/sync/*` wire protocol (server side in
 * packages/pod/src/lib/server/collection/sync/). Kept as plain interfaces so the sync client
 * stays isomorphic (runs identically in the browser and in Node tests).
 */

export const SYNC_REPLICA_STAMP_HEADER = 'x-norbital-sync-replica-stamp';
export const SYNC_REPLICA_EPOCH_HEADER = 'x-norbital-sync-replica-epoch';

/**
 * What a browser needs to open its local replica, delivered with the workspace shell.
 *
 * `replicaStamp` names the local database as `<organizationId>:<userId>`; `replicaEpoch` identifies
 * the physical tenant database, so rows cached against a database that has since been replaced are
 * discarded rather than served.
 */
export type SyncBootstrap = {
	readonly schemaSql: string;
	readonly replicaStamp: string;
	readonly replicaEpoch: string;
};

export type SyncCursor = { readonly xid: string; readonly seq: string };

export type SyncDiff = {
	readonly seq: string;
	/** Writing transaction id. `(xid, seq)` together are the resume cursor; advancing `seq` alone
	 *  leaves a stale `xid` behind and replays the whole feed on every reconnect. */
	readonly xid?: string;
	readonly collection: string;
	readonly action: 'insert' | 'update' | 'delete' | 'leave';
	readonly id: string;
	readonly version: number | null;
	readonly row?: Record<string, unknown>;
};

// ── shape protocol (collection catch-up) ───────────────────────────────────────

export type ShapeRequest = {
	readonly collection: string;
	readonly cursor?: string | null;
	readonly pageSize?: number;
};

export type ShapeResponse = {
	readonly rows: Record<string, unknown>[];
	/** Null means the server has no rows after this page — the collection is fully fetched. */
	readonly nextCursor: string | null;
	readonly watermark: string;
	/** Full (xid, seq) cursor for the SSE stream to resume from. Set on the first page. */
	readonly cursor?: SyncCursor;
};

// ── persisted per-collection sync state ────────────────────────────────────────

export type CollectionSyncState = {
	readonly collection: string;
	/** Every row the policy exposes is local. False means only a bounded window is. */
	readonly resident: boolean;
	readonly rows: number;
	/** Approximate encoded size held locally, charged against the shared residency budget. */
	readonly bytes: number;
	readonly syncedAt: number;
};

// ── mutate ─────────────────────────────────────────────────────────────────────

export type WireMutation = {
	readonly clientId: string;
	readonly collection: string;
	readonly action: 'create' | 'update' | 'delete';
	readonly row?: Record<string, unknown>;
	readonly version?: number;
};

export type MutationResult =
	| {
			readonly clientId: string;
			readonly status: 'confirmed';
			readonly serverId: string | null;
			readonly row?: Record<string, unknown>;
	  }
	| {
			readonly clientId: string;
			readonly status: 'rejected';
			readonly reason: string;
			readonly currentRow?: Record<string, unknown>;
			readonly detail?: string;
	  };

export type MutateResponse = { readonly results: MutationResult[] };

// ── transport ──────────────────────────────────────────────────────────────────

export type SyncFetch = (
	path: string,
	init: { method: 'GET' | 'POST'; body?: string; signal?: AbortSignal; accept?: string }
) => Promise<Response>;
