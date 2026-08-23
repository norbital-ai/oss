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
import { createWorkspaceApiProxy } from '../../src/client/runtime.js';

type AgentCollections = Pick<
	CollectionRegistryFor<PlatformSchema>,
	'approval_request' | 'chat_session' | 'chat_message' | 'user' | 'bolt_notifications'
>;

export const settledQuery = <T>(current: T): RemoteQuery<T> => ({
	current,
	loading: false,
	error: undefined,
	refresh: () => Effect.runPromise(Effect.void),
	then: (onfulfilled, onrejected) =>
		Effect.runPromise(Effect.succeed(current)).then(onfulfilled, onrejected)
});

const page = <T extends object>(current: T[]): CollectionPageQuery<T> => ({
	...settledQuery(current),
	nextCursor: null
});

const emptyOperations = <T extends CollectionType<object, object, object>>() =>
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

/** A real query surface over settled rows, for action tests that do not read it. */
export const emptyAgentClient = (transport: BoltTransport): AgentRuntimeConfig['client'] => {
	const runtime = {
		db: {},
		bolt: createBoltClient(
			InvocationScope.make({
				tenantId: TenantId.make('test-tenant'),
				environment: EnvironmentName.make('test'),
				releaseId: ReleaseId.make('test-release')
			}),
			transport
		)
	};
	return {
		db: {
			approval_request: emptyOperations<AgentCollections['approval_request']>(),
			chat_session: emptyOperations<AgentCollections['chat_session']>(),
			chat_message: emptyOperations<AgentCollections['chat_message']>(),
			user: emptyOperations<AgentCollections['user']>(),
			bolt_notifications: emptyOperations<AgentCollections['bolt_notifications']>()
		},
		records: {
			findMany: () => page<CollectionRecord>([])
		},
		system: createWorkspaceApiProxy(runtime).system
	};
};
