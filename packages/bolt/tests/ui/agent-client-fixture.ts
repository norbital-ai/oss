import type {
	CollectionOperations,
	CollectionPageQuery,
	CollectionRecord,
	CollectionType,
	RemoteQuery
} from '@norbital-ai/std/collection';
import { Effect } from 'effect';
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
import {
	createWorkspaceApiProxy,
	type SystemClientApi
} from '../../src/client/workspace-api.js';

type AgentCollections = Pick<
	CollectionRegistryFor<PlatformSchema>,
	| 'approval_request'
	| 'requestor'
	| 'session'
	| 'account'
	| 'verification'
	| 'auth_config'
	| 'team'
	| 'agent_task'
	| 'agent_plan'
	| 'agent_message'
	| 'agent_inbox'
	| 'agent_run'
	| 'agent_usage'
	| 'automation_run'
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
	attach: () => () => undefined,
	shutdown: () => undefined,
	current: () => initialClientState(),
	subscribe: () => () => undefined,
	mount: (input) => ({
		key: stableKey(input),
		extend: () => undefined,
		detach: () => undefined
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
	const api = createWorkspaceApiProxy(runtime, {}, { system: true });
	if (!('system' in api)) throw new Error('The agent fixture requires the projected system client');
	const system: SystemClientApi = api.system;
	return {
		automations: {},
		db: {
			approval_request: emptyOperations<AgentCollections['approval_request']>(),
			requestor: emptyOperations<AgentCollections['requestor']>(),
			session: emptyOperations<AgentCollections['session']>(),
			account: emptyOperations<AgentCollections['account']>(),
			verification: emptyOperations<AgentCollections['verification']>(),
			auth_config: emptyOperations<AgentCollections['auth_config']>(),
			team: emptyOperations<AgentCollections['team']>(),
			agent_task: emptyOperations<AgentCollections['agent_task']>(),
			agent_plan: emptyOperations<AgentCollections['agent_plan']>(),
			agent_message: emptyOperations<AgentCollections['agent_message']>(),
			agent_inbox: emptyOperations<AgentCollections['agent_inbox']>(),
			agent_run: emptyOperations<AgentCollections['agent_run']>(),
			agent_usage: emptyOperations<AgentCollections['agent_usage']>(),
			automation_run: emptyOperations<AgentCollections['automation_run']>(),
			user: emptyOperations<AgentCollections['user']>(),
			bolt_notifications: emptyOperations<AgentCollections['bolt_notifications']>()
		},
		collections: {},
		records: {
			findMany: () => page<CollectionRecord>([])
		},
		system
	};
};
