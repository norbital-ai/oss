import {
	MAX_SYNC_OUTBOUND_FRAME_BYTES,
	SyncConnectionLane,
	SyncRegistry,
	SyncScope as SyncScopeSchema,
	syncScopedApplyFrameByteLength,
	type SyncAdvanceRequest,
	type SyncAdvanceResponse,
	type SyncApplyFrame,
	type SyncConnectEvaluation,
	type SyncConnectRequest,
	type SyncConnectResponse,
	type SyncExtendPrefixEvaluation,
	type SyncExtendPrefixRequest,
	type SyncExtendPrefixResponse,
	type SyncRegistryConnection,
	type SyncScope,
	type SyncScopedApplyFrame
} from '@norbital-ai/bolt-protocol';
import { createHash } from 'node:crypto';

export type SyncDisconnectReason = 'client' | 'guest-failed';
export type SyncSink = Readonly<{
	readonly writable: () => boolean;
	readonly write: (frame: SyncScopedApplyFrame) => boolean;
	readonly close: (reason: SyncDisconnectReason) => void;
}>;

export interface SyncConnection extends SyncRegistryConnection {
	readonly id: string;
	readonly scope: SyncScope;
	readonly sink: Readonly<{
		readonly writable: () => boolean;
		readonly write: (frame: SyncApplyFrame) => boolean;
		readonly close: (reason: SyncDisconnectReason) => void;
	}>;
}

type SyncBrowserConnection = {
	readonly id: string;
	readonly principal: string;
	readonly sink: SyncSink;
	readonly scopes: Map<string, SyncConnection>;
	closed: boolean;
};

type ScopeLane = Readonly<{
	readonly scope: SyncScope;
	readonly pump: SyncConnectionLane<SyncConnection, SyncDisconnectReason>;
}>;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const scopeKey = (scope: SyncScope): string =>
	`${scope.tenantId}\u0000${scope.environment}\u0000${scope.releaseId}`;

export const makeSyncRegistry = (): SyncRegistry<SyncConnection> =>
	new SyncRegistry({ hash: sha256 });

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
	readonly command: 'sync.connect' | 'sync.extendPrefix' | 'sync.advance';
	constructor(status: number, command: 'sync.connect' | 'sync.extendPrefix' | 'sync.advance') {
		super(`${command} returned status ${status}`);
		this.status = status;
		this.command = command;
	}
}

export type SyncGuestBridge = Readonly<{
	readonly connect: (input: Readonly<{
		scope: SyncScope;
		credential: string;
		request: SyncConnectRequest;
	}>) => Promise<SyncConnectEvaluation>;
	readonly extendPrefix: (input: Readonly<{
		scope: SyncScope;
		request: SyncExtendPrefixRequest;
		state: SyncAdvanceRequest['subscriptions'][number];
	}>) => Promise<SyncExtendPrefixEvaluation>;
	readonly advance: (input: Readonly<{
		scope: SyncScope;
		request: SyncAdvanceRequest;
	}>) => Promise<SyncAdvanceResponse>;
}>;

type SyncCommit = Readonly<{
	readonly scope: SyncScope;
	readonly writerConnectionId?: string | undefined;
	readonly writerCredential?: string | undefined;
	readonly changes: SyncAdvanceRequest['changes'];
	readonly pending: SyncAdvanceRequest['pending'];
}>;

type ScopedInput = Readonly<{
	readonly connectionId: string;
	readonly principal: string;
	readonly scope: SyncScope;
	readonly credential: string;
}>;

export type SyncInterface = Readonly<{
	readonly open: (input: Readonly<{
		connectionId: string;
		principal: string;
		sink: SyncSink;
	}>) => void;
	readonly connect: (
		input: ScopedInput & { readonly request: SyncConnectRequest }
	) => Promise<SyncConnectResponse>;
	readonly extendPrefix: (
		input: ScopedInput & { readonly request: SyncExtendPrefixRequest }
	) => Promise<SyncExtendPrefixResponse>;
	readonly committed: (commit: SyncCommit) => Promise<void>;
	readonly detach: (connectionId: string) => void;
}>;

export const makeSyncHost = (bridge: SyncGuestBridge): SyncInterface => {
	const connectionIndex = new Map<string, SyncBrowserConnection>();
	const lanes = new Map<string, ScopeLane>();

	const detachPhysical = (connectionId: string, reason: SyncDisconnectReason): void => {
		const physical = connectionIndex.get(connectionId);
		if (physical === undefined || physical.closed) return;
		physical.closed = true;
		connectionIndex.delete(connectionId);
		const attached = [...physical.scopes.values()];
		physical.scopes.clear();
		for (const connection of attached)
			lanes.get(scopeKey(connection.scope))?.pump.detach(connection.id, reason);
		physical.sink.close(reason);
	};

	const laneFor = (scope: SyncScope): ScopeLane => {
		const key = scopeKey(scope);
		const existing = lanes.get(key);
		if (existing !== undefined && !existing.pump.closed) return existing;
		let pump: SyncConnectionLane<SyncConnection, SyncDisconnectReason>;
		pump = new SyncConnectionLane<SyncConnection, SyncDisconnectReason>({
			hash: sha256,
			connect: (connection, request) =>
				bridge.connect({ scope, credential: connection.credential, request }),
			extendPrefix: (connection, request) => {
				const viewer = pump.registry.prefixViewer(connection, request.queryKey);
				const details = viewer === undefined ? undefined : pump.registry.details(viewer.subId);
				const attachment = details?.attachments.find(
					(candidate) =>
						candidate.connection === connection && candidate.queryKey === request.queryKey
				);
				if (details === undefined || attachment === undefined)
					throw new SyncConnectionUnavailable(connection.id);
				const { impersonatedTeam: _representativeTeam, ...sharedState } = details.subscription;
				return bridge.extendPrefix({
					scope,
					request,
					state: {
						...sharedState,
						credential: connection.credential,
						...(attachment.authority === undefined ? {} : { impersonatedTeam: attachment.authority })
					}
				});
			},
			guestFailure: 'guest-failed',
			close: (connection, reason) => detachPhysical(connection.id, reason)
		});
		const created = { scope, pump } satisfies ScopeLane;
		lanes.set(key, created);
		return created;
	};

	const physicalFor = (
		connectionId: string,
		principal: string
	): SyncBrowserConnection | undefined => {
		const connection = connectionIndex.get(connectionId);
		return connection !== undefined && !connection.closed && connection.principal === principal
			? connection
			: undefined;
	};

	const resolveScope = (input: ScopedInput): SyncConnection | undefined => {
		const connection = physicalFor(input.connectionId, input.principal)?.scopes.get(
			scopeKey(input.scope)
		);
		return connection !== undefined &&
			!connection.closed &&
			connection.credential === input.credential
			? connection
			: undefined;
	};

	const attachScope = (input: ScopedInput): SyncConnection | undefined => {
		const physical = physicalFor(input.connectionId, input.principal);
		if (physical === undefined) return undefined;
		const key = scopeKey(input.scope);
		const existing = physical.scopes.get(key);
		if (existing !== undefined)
			return !existing.closed && existing.credential === input.credential ? existing : undefined;
		const scoped = SyncScopeSchema.make({
			tenantId: input.scope.tenantId,
			environment: input.scope.environment,
			releaseId: input.scope.releaseId
		});
		const connection: SyncConnection = {
			id: input.connectionId,
			scope: scoped,
			credential: input.credential,
			sink: {
				writable: physical.sink.writable,
				write: (frame) => {
					const envelope = { scope: scoped, frame } satisfies SyncScopedApplyFrame;
					return (
						syncScopedApplyFrameByteLength(envelope) <= MAX_SYNC_OUTBOUND_FRAME_BYTES &&
						physical.sink.write(envelope)
					);
				},
				close: (reason) => detachPhysical(input.connectionId, reason)
			},
			subscriptions: new Map(),
			closed: false
		};
		laneFor(scoped).pump.open(connection, 'client');
		physical.scopes.set(key, connection);
		return connection;
	};

	return {
		open: (input) => {
			detachPhysical(input.connectionId, 'client');
			const principal = input.principal.trim();
			if (principal.length === 0) throw new SyncConnectionUnavailable(input.connectionId);
			connectionIndex.set(input.connectionId, {
				id: input.connectionId,
				principal,
				sink: input.sink,
				scopes: new Map(),
				closed: false
			});
		},
		connect: (input) => {
			const connection = attachScope(input);
			const lane = lanes.get(scopeKey(input.scope));
			if (connection === undefined || lane === undefined || lane.pump.closed)
				return Promise.reject(new SyncConnectionUnavailable(input.connectionId));
			return lane.pump.connect({
				request: input.request,
				resolve: () => resolveScope(input),
				unavailable: () => new SyncConnectionUnavailable(input.connectionId)
			});
		},
		extendPrefix: (input) => {
			const lane = lanes.get(scopeKey(input.scope));
			if (lane === undefined || lane.pump.closed)
				return Promise.reject(new SyncConnectionUnavailable(input.connectionId));
			return lane.pump.extendPrefix({
				request: input.request,
				resolve: () => resolveScope(input),
				unavailable: () => new SyncConnectionUnavailable(input.connectionId)
			});
		},
		committed: (commit) =>
			laneFor(commit.scope).pump.committed({
				changes: commit.changes,
				pending: commit.pending,
				resolveWriter: () => {
					const physical =
						commit.writerConnectionId === undefined
							? undefined
							: connectionIndex.get(commit.writerConnectionId);
					const writer = physical?.scopes.get(scopeKey(commit.scope));
					return writer !== undefined && writer.credential === commit.writerCredential
						? writer
						: undefined;
				},
				writerProof: (connection) => ({ credential: connection.credential }),
				advance: (request) => bridge.advance({ scope: commit.scope, request })
			}),
		detach: (connectionId) => detachPhysical(connectionId, 'client')
	};
};
