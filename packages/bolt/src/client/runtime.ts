import {
	EnvironmentName,
	InvocationScope,
	ReleaseId,
	SYNC_CONNECTION_HEADER,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { createBoltClient } from '#lib/client.js';
import { getErrorMessage } from '@norbital-ai/std';
import type {
	BoltClient,
	BoltTransport,
	BrowserWorkspaceRuntimeOptions,
	MutationSettlement,
	MutationSettlementStatus,
	MutationSettlements,
	WorkspaceClientRuntime
} from '#lib/client/contracts.js';
import {
	createBrowserSyncBroker,
	createSyncClient,
	createSyncHttpDriver,
	type BrowserSyncScope,
	type SyncClient
} from './sync/index.js';
import {
	mutationSettlementOf,
	rejectedSyncOutcome,
	syncOutcomeFromMutateCommand
} from './mutation-settlement.js';
import type { ClientState } from './sync/machine.js';
import { workspaceSession } from './session.js';
import { databaseOf } from './workspace-api.js';
import { createSyncStatusView } from './sync-status.svelte.js';

export type { SystemClientApi } from './workspace-api.js';
export type { BrowserWorkspaceRuntimeOptions } from '#lib/client/contracts.js';
export type { RemoteQuery } from '#lib/client/contracts.js';
export {
	createWorkspaceApiProxy,
	databaseOf,
	type CollectionCatalog,
	type CollectionCatalogEntry,
	type CollectionCatalogField,
	type CollectionCatalogRelation,
	type CollectionPageQuery,
	type WorkspaceApiVisibility
} from './workspace-api.js';

/** --- writes: one graph per mutation, settled asynchronously through the Machine --- */

/**
 * The promise side of the write path. Every observable write phase stays in the Machine; these
 * resolvers only wake the `mutate()` caller when the Machine deletes a settled write on an outcome.
 */
const createMutationSettlements = (machine: () => SyncClient): MutationSettlements => {
	const waiters = new Map<string, Array<(settlement: MutationSettlement) => void>>();
	const settled = new Map<string, MutationSettlementStatus>();
	const register = (id: string, resolve: (settlement: MutationSettlement) => void): void => {
		const queue = waiters.get(id) ?? [];
		queue.push(resolve);
		waiters.set(id, queue);
	};
	return {
		create: (id) => ({
			idempotencyKey: id,
			settled: new Promise<MutationSettlement>((resolve) => register(id, resolve)),
			status: async () => settled.get(id) ?? machine().current().writes.get(id)?.phase ?? 'unknown',
			wait: (signal) => {
				const promise = new Promise<MutationSettlement>((resolve) => register(id, resolve));
				if (signal === undefined) return promise;
				return new Promise<MutationSettlement>((resolve, reject) => {
					signal.addEventListener('abort', () => reject(signal.reason), { once: true });
					promise.then(resolve, reject);
				});
			}
		}),
		accept: (outcomes) => {
			if (outcomes.length === 0) return;
			const at = Date.now();
			for (const outcome of outcomes) {
				settled.set(outcome.id, outcome.status.resolution);
				const queue = waiters.get(outcome.id);
				if (queue === undefined) continue;
				waiters.delete(outcome.id);
				const settlement = mutationSettlementOf(outcome, at);
				for (const resolve of queue) resolve(settlement);
			}
		}
	};
};

/** --- wiring --- */

/**
 * The transport the host declared, resolved per call.
 *
 * It is not a second HTTP client written out here: the host's declared transport is the one
 * implementation of "post a Bolt command", and sync control rides it with the connection header.
 */
const browserTransport: BoltTransport = {
	command: (command, input, signal) => workspaceSession().transport.command(command, input, signal)
};

/** Sync controls share the stream route's host-owned prefix. Keep the query (headed session token). */
export const syncControlUrlOf = (streamUrl: string, control: 'connect' | 'extend'): string => {
	const absolute = streamUrl.startsWith('http://') || streamUrl.startsWith('https://');
	const parsed = absolute ? new URL(streamUrl) : new URL(streamUrl, 'http://bolt.invalid');
	if (parsed.pathname.endsWith('/stream')) {
		parsed.pathname = `${parsed.pathname.slice(0, -'/stream'.length)}/${control}`;
	} else {
		parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/${control}`;
	}
	return absolute ? parsed.href : `${parsed.pathname}${parsed.search}`;
};

/**
 * Creates the browser runtime for the session the host declared.
 *
 * One Machine, one SSE stream, one HTTP seam. There is no local engine to start and no readiness to
 * wait for: reads are live from the first connect, writes queue in tab memory, and `runtime.sync`
 * exposes the Machine's three link states to any surface that needs them.
 */
export const createBrowserWorkspaceRuntime = (
	options: BrowserWorkspaceRuntimeOptions = {}
): WorkspaceClientRuntime => {
	const session = workspaceSession();
	const schemaFingerprint = options.schemaFingerprint?.trim();
	if (schemaFingerprint === undefined || schemaFingerprint.length === 0) {
		throw new Error('The generated workspace client did not declare its schema fingerprint');
	}
	const scope = InvocationScope.make({
		tenantId: TenantId.make(options.tenantId ?? session.tenantId),
		environment: EnvironmentName.make(options.environment ?? session.environment),
		releaseId: ReleaseId.make(options.releaseId ?? session.releaseId)
	});
	const bolt = createBoltClient(scope, options.transport ?? browserTransport);
	const syncScope: BrowserSyncScope = { workspaceId: session.workspaceId, ...scope };
	let acceptSettlements: (outcomes: Parameters<MutationSettlements['accept']>[0]) => void =
		() => undefined;
	const machine = createSyncClient({
		scope: syncScope,
		onOutcomes: (outcomes) => acceptSettlements(outcomes),
		onError: (cause) => console.warn('[bolt] sync', cause)
	});
	const settlements = createMutationSettlements(() => machine);
	acceptSettlements = settlements.accept;
	const broker = createBrowserSyncBroker({
		election: { syncPrincipal: session.syncPrincipal },
		streamUrl: session.syncStreamUrl,
		onError: (cause) => console.warn('[bolt] sync broker', cause)
	});
	const binding = broker.attachWorkspace({
		scope: syncScope,
		controls: createSyncHttpDriver({
			registrationUrl: syncControlUrlOf(session.syncStreamUrl, 'connect'),
			extensionUrl: syncControlUrlOf(session.syncStreamUrl, 'extend'),
			authorization: () => `Bearer ${workspaceSession().credential}`,
			push: async ({ connectionId, ...request }, signal) => {
				try {
					const value = await session.transport.command('collections.mutate', request, signal, {
						[SYNC_CONNECTION_HEADER]: connectionId
					});
					const outcome = syncOutcomeFromMutateCommand(
						request.idempotencyKey,
						value,
						request.schemaFingerprint
					);
					if (outcome !== null) acceptSettlements([outcome]);
				} catch (cause) {
					acceptSettlements([
						rejectedSyncOutcome(
							request.idempotencyKey,
							getErrorMessage(cause),
							request.schemaFingerprint
						)
					]);
					throw cause;
				}
			}
		})
	});
	const detach = machine.attach(binding.attachment);
	const sync: SyncClient = {
		...machine,
		shutdown: (message) => {
			machine.shutdown(message);
			detach();
			binding.close();
			broker.close();
		}
	};
	sync.start();
	const runtime: {
		bolt: BoltClient;
		db: Readonly<Record<string, unknown>>;
		sync: SyncClient;
		mutation: WorkspaceClientRuntime['mutation'];
		syncStatus: ClientState;
		settlements: MutationSettlements;
	} = {
		bolt,
		db: {},
		sync,
		mutation: { partitionKey: crypto.randomUUID(), schemaFingerprint },
		settlements,
		syncStatus: createSyncStatusView(sync)
	};
	runtime.db = databaseOf(runtime);
	return runtime;
};
