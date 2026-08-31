import type {
	CollectionOperations,
	CollectionPageQuery,
	CollectionRecord,
	CollectionType,
	RemoteQuery
} from '@norbital-ai/std/collection';
import { Effect, Schema } from 'effect';
import { EnvironmentName, InvocationScope, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import type { CollectionRegistryFor, PlatformSchema } from '../../src/authoring/internals.js';
import type { AgentRuntimeConfig } from '../../src/client/ui/agent/client.svelte.js';
import { createBoltClient, type BoltTransport } from '../../src/client.js';
import type {
	MutationSettlement,
	MutationSettlements,
	WorkspaceClientRuntime
} from '../../src/client/contracts.js';
import type { SyncClient } from '../../src/client/sync/index.js';
import { initialClientState } from '../../src/client/sync/machine.js';
import { stableKey } from '../../src/client/live-query/stable-key.js';
import { createSystemClient, type SystemClientApi } from '../../src/client/system-client.js';
import { createRemoteQuery } from '../../src/client/remote-query.svelte.js';

type AgentCollections = Pick<
	CollectionRegistryFor<PlatformSchema>,
	| 'approval_request'
	| 'agent_inbox'
	| 'agent_lane'
	| 'agent_run'
	| 'chat_session'
	| 'chat_message'
	| 'chat_message_part'
	| 'user'
	| 'bolt_notifications'
>;

export const settledQuery = <T>(current: T): RemoteQuery<T> => ({
	current,
	loading: false,
	error: undefined,
	then: (onfulfilled, onrejected) =>
		Effect.runPromise(Effect.succeed(current)).then(onfulfilled, onrejected)
});

const page = <T extends object>(current: T[]): CollectionPageQuery<T> => ({
	...settledQuery(current),
	nextCursor: null
});

const emptyOperations = <T extends CollectionType<object, object>>() =>
	({
		findMany: () => page<T['row']>([]),
		findFirst: () => settledQuery<T['row'] | undefined>(undefined),
		findGrouped: () => settledQuery<Readonly<Record<string, T['row'][]>>>({}),
		count: () => settledQuery(0),
		mutate: async () => {
			throw new Error('The empty agent client does not execute mutations');
		},
		pending: 0
	}) satisfies CollectionOperations<T>;

/**
 * The runtime pieces the workspace API proxy reads but an empty agent client never exercises:
 * no mount ever runs and no mutation is ever settled, so the doubles stay inert.
 */
const emptySync: SyncClient = {
	start: () => undefined,
	current: () => initialClientState(),
	subscribe: () => () => undefined,
	mount: (input) => ({
		key: stableKey(input),
		release: () => undefined
	}),
	enqueue: () => undefined
};

const emptySettlements: MutationSettlements = {
	create: (idempotencyKey) => ({
		idempotencyKey,
		settled: new Promise<MutationSettlement>(() => undefined),
		status: async () => 'unknown',
		wait: () => new Promise<MutationSettlement>(() => undefined)
	}),
	accept: () => undefined
};

/** A real query surface over settled rows, for action tests that do not read it. */
export const emptyAgentClient = (transport: BoltTransport): AgentRuntimeConfig['client'] => {
	const runtime: WorkspaceClientRuntime = {
		db: {},
		bolt: createBoltClient(
			InvocationScope.make({
				tenantId: TenantId.make('test-tenant'),
				environment: EnvironmentName.make('test'),
				releaseId: ReleaseId.make('test-release')
			}),
			transport
		),
		sync: emptySync,
		mutation: { partitionKey: 'test-partition', schemaFingerprint: 'sha256:test' },
		syncStatus: initialClientState(),
		settlements: emptySettlements
	};
	const system: SystemClientApi = createSystemClient(
		runtime,
		(name, input, inputSchema, outputSchema, signal) =>
			createRemoteQuery(
				() =>
					Effect.gen(function* () {
						const checked = yield* Schema.decodeUnknownEffect(inputSchema)(input);
						const payload = yield* Schema.decodeUnknownEffect(Schema.Json)(checked);
						return yield* Effect.tryPromise({
							try: () => runtime.bolt.command(name, payload, outputSchema, signal),
							catch: (cause) => cause
						});
					}),
				outputSchema
			)
	);
	return {
		db: {
			approval_request: emptyOperations<AgentCollections['approval_request']>(),
			agent_inbox: emptyOperations<AgentCollections['agent_inbox']>(),
			agent_lane: emptyOperations<AgentCollections['agent_lane']>(),
			agent_run: emptyOperations<AgentCollections['agent_run']>(),
			chat_session: emptyOperations<AgentCollections['chat_session']>(),
			chat_message: emptyOperations<AgentCollections['chat_message']>(),
			chat_message_part: emptyOperations<AgentCollections['chat_message_part']>(),
			user: emptyOperations<AgentCollections['user']>(),
			bolt_notifications: emptyOperations<AgentCollections['bolt_notifications']>()
		},
		records: {
			findMany: () => page<CollectionRecord>([])
		},
		system
	};
};
