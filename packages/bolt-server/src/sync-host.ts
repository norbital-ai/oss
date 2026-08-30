import {
	SyncRegistry,
	SyncConnectionLane,
	type SyncAdvanceRequest,
	type SyncAdvanceResponse,
	type SyncApplyFrame,
	type SyncConnectEvaluation,
	type SyncConnectRequest,
	type SyncConnectResponse,
	type SyncRegistryConnection
} from '@norbital-ai/bolt-protocol';
import { createHash } from 'node:crypto';

/**
 * bolt-server's half of the host contract (RFC/live-query-sync.md §1.2): one tenant, one process,
 * the same registry and pump semantics as Colony because both take them from the one shared core.
 *
 * What is left here is plumbing — the single serial lane, this process's connection object, and the
 * two disconnect reasons a single-tenant host can produce.
 */

/** Why a standing stream ended. */
export type SyncDisconnectReason = 'client' | 'guest-failed';

/**
 * The stream owns bytes; the registry only learns whether one complete frame was accepted.
 *
 * `write` returning false means the frame was refused, not buffered — that refusal is the pump's
 * signal to collapse the connection's backlog into one full answer (§2.5).
 */
export type SyncSink = Readonly<{
	readonly writable: () => boolean;
	readonly write: (frame: SyncApplyFrame) => boolean;
	readonly close: (reason: SyncDisconnectReason) => void;
}>;

/** bolt-server's process-local connection. Deliberately neither durable nor serializable. */
export interface SyncConnection extends SyncRegistryConnection {
	readonly id: string;
	readonly sink: SyncSink;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The shared registry bound to this host's connection type and digest primitive. */
export const makeSyncRegistry = (
	invalidate: (connection: SyncConnection, keys: ReadonlyArray<string>) => void
): SyncRegistry<SyncConnection> => new SyncRegistry({ hash: sha256, invalidate });

export class SyncConnectionUnavailable extends Error {
	readonly name = 'SyncConnectionUnavailable';
	readonly connectionId: string;
	constructor(connectionId: string) {
		super(`sync connection ${connectionId} is not available`);
		this.connectionId = connectionId;
	}
}

export class SyncGuestRejected extends Error {
	readonly name = 'SyncGuestRejected';
	readonly status: number;
	readonly command: 'sync.connect' | 'sync.advance';
	constructor(status: number, command: 'sync.connect' | 'sync.advance') {
		super(`${command} returned status ${status}`);
		this.status = status;
		this.command = command;
	}
}

/** The two guest invocations the whole design rides; everything else is filing and fanning. */
export type SyncGuestBridge = Readonly<{
	readonly connect: (input: Readonly<{
		credential: string;
		request: SyncConnectRequest;
	}>) => Promise<SyncConnectEvaluation>;
	readonly advance: (input: Readonly<{
		request: SyncAdvanceRequest;
	}>) => Promise<SyncAdvanceResponse>;
}>;

/** One committed write the command path hands to the pump. */
type SyncCommit = Readonly<{
	readonly writerConnectionId?: string | undefined;
	readonly writerCredential?: string | undefined;
	readonly changes: SyncAdvanceRequest['changes'];
	readonly pending: SyncAdvanceRequest['pending'];
}>;

export type SyncInterface = Readonly<{
	readonly open: (input: Readonly<{
		connectionId: string;
		credential: string;
		sink: SyncSink;
	}>) => void;
	readonly connect: (input: Readonly<{
		connectionId: string;
		credential: string;
		request: SyncConnectRequest;
	}>) => Promise<SyncConnectResponse>;
	readonly committed: (commit: SyncCommit) => Promise<void>;
	readonly ready: (connectionId: string) => void;
	readonly detach: (connectionId: string) => void;
}>;

/**
 * The pump over the registry: one serial lane for the single tenant, per-connection ordering,
 * collapse-on-refusal. It turns one commit batch into one frame per connection.
 */
export const makeSyncHost = (bridge: SyncGuestBridge): SyncInterface => {
	const lane = new SyncConnectionLane<SyncConnection, SyncDisconnectReason>({
		hash: sha256,
		invalidate: (connection, keys) => {
			if (connection.closed) return;
			for (const key of keys) if (connection.queries.has(key)) connection.dirty.add(key);
		},
		connect: (connection, request) => bridge.connect({ credential: connection.credential, request }),
		guestFailure: 'guest-failed',
		close: (connection, reason) => connection.sink.close(reason)
	});

	const connect: SyncInterface['connect'] = (input) =>
		lane.connect({
			request: input.request,
			resolve: () => {
				const connection = lane.get(input.connectionId);
				if (
					connection === undefined ||
					connection.closed ||
					connection.credential !== input.credential
				)
					return undefined;
				return connection;
			},
			unavailable: () => new SyncConnectionUnavailable(input.connectionId),
			refresh: () => {
				for (const candidate of lane.connections()) lane.refresh(candidate);
			}
		});

	const committed: SyncInterface['committed'] = (commit) =>
		lane.committed({
			changes: commit.changes,
			pending: commit.pending,
			resolveWriter: () => {
				const writer =
					commit.writerConnectionId === undefined
						? undefined
						: lane.get(commit.writerConnectionId);
				return writer !== undefined && writer.credential === commit.writerCredential
					? writer
					: undefined;
			},
			writerProof: (connection) => ({ credential: connection.credential }),
			advance: (request) => bridge.advance({ request })
		});

	return {
		open: (input) => {
			lane.open({
				id: input.connectionId,
				credential: input.credential,
				sink: input.sink,
				subscriptions: new Map(),
				queries: new Map(),
				dirty: new Set(),
				closed: false,
				refreshing: false
			}, 'client');
		},
		connect,
		committed,
		ready: (connectionId) => {
			const connection = lane.get(connectionId);
			if (connection !== undefined) lane.refresh(connection);
		},
		detach: (connectionId) => {
			lane.detach(connectionId, 'client');
		}
	};
};
