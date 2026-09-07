import {
	EnvironmentName,
	ReleaseId,
	TenantId,
	syncRetainedPrefixBytes
} from '@norbital-ai/bolt-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncClient, type SyncWorkspaceAttachment } from '../src/client/sync/client.js';
import type { BrowserSyncScope } from '../src/client/sync/sse-driver.js';

/**
 * SYNC-LAT (RFC/bolt.md B6): every live query a page mounts in one turn of the event loop rides one
 * registration request. Before this, a page that mounted twelve queries on a live link sent twelve
 * requests, each a guest dispatch, serialised on the host lane: the scheduling page's four seconds
 * on an empty tenant.
 */
const scope: BrowserSyncScope = {
	workspaceId: 'ws',
	tenantId: TenantId.make('tenant-1'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release-1')
};

const query = (collection: string) => ({
	kind: 'findMany' as const,
	collection,
	orderBy: { id: 'asc' as const },
	limit: 20
});

const acceptingAttachment = (requests: string[][]): SyncWorkspaceAttachment => ({
	scope,
	register: async (request) => {
		const keys = request.queries.map(({ queryKey }) => queryKey);
		requests.push(keys);
		return {
			queries: keys.map((queryKey) => ({
				queryKey,
				version: 0,
				rows: [] as const,
				retainedBytes: syncRetainedPrefixBytes([])
			})),
			outcomes: [] as const
		};
	},
	extend: async () => {
		throw new Error('extend is unused');
	},
	push: async () => undefined,
	subscribe: () => () => undefined
});

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('registration batching', () => {
	const clients: Array<{ shutdown: () => void }> = [];
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		for (const client of clients) client.shutdown();
		clients.length = 0;
		vi.useRealTimers();
	});

	it('sends one request for every query mounted in the same turn on a live link', async () => {
		const requests: string[][] = [];
		const client = createSyncClient({ scope });
		clients.push(client);
		client.attach(acceptingAttachment(requests));
		client.mount(query('companies'));
		client.start();
		await settle();
		expect(client.current().link).toBe('live');
		expect(requests).toHaveLength(1);

		// The next page: twelve queries mounted synchronously, as a component tree mounts them.
		const collections = Array.from({ length: 12 }, (_, index) => `collection_${index}`);
		for (const collection of collections) client.mount(query(collection));
		await settle();

		expect(requests).toHaveLength(2);
		expect(requests[1]).toHaveLength(12);
		for (const collection of collections) {
			const state = [...client.current().queries.values()].find(
				({ input }) => input.collection === collection
			);
			expect(state?.phase).toBe('fresh');
		}
	});

	it('still registers a query mounted in a later turn on its own', async () => {
		const requests: string[][] = [];
		const client = createSyncClient({ scope });
		clients.push(client);
		client.attach(acceptingAttachment(requests));
		client.mount(query('companies'));
		client.start();
		await settle();
		client.mount(query('employees'));
		await settle();
		client.mount(query('employments'));
		await settle();
		expect(requests.map((keys) => keys.length)).toEqual([1, 1, 1]);
	});
});

describe('opening request without queries', () => {
	const clients: Array<{ shutdown: () => void }> = [];
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		for (const client of clients) client.shutdown();
		clients.length = 0;
		vi.useRealTimers();
	});

	it('still opens the link, so queries mounted afterwards register', async () => {
		const requests: string[][] = [];
		const client = createSyncClient({ scope });
		clients.push(client);
		client.attach(acceptingAttachment(requests));
		client.start();
		await settle();
		// The empty opening request is what moves the link to live; dropping it as "nothing to
		// register" left every page's tables on their skeletons.
		expect(requests).toEqual([[]]);
		expect(client.current().link).toBe('live');
		client.mount(query('companies'));
		await settle();
		expect(requests).toHaveLength(2);
		expect(requests[1]).toHaveLength(1);
		expect([...client.current().queries.values()][0]?.phase).toBe('fresh');
	});
});
