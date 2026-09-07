import {
	EnvironmentName,
	ReleaseId,
	TenantId,
	syncRetainedPrefixBytes
} from '@norbital-ai/bolt-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncClient, type SyncWorkspaceAttachment } from '../src/client/sync/client.js';
import { SyncHttpError } from '../src/client/sync/http-driver.js';
import { stableKey } from '../src/client/live-query/stable-key.js';
import type { BrowserSyncScope } from '../src/client/sync/sse-driver.js';

/**
 * SYNC-400 (RFC/bolt.md B9a): a registration the host refuses with a 400 is terminal for the
 * keys it carried, whether the link was live or the request was the one opening it.
 *
 * An opening refusal used to fall through to the attachment's terminal disconnect, which closed the
 * whole client: every later page threw "Cannot mount a query on a closed Sync client", which is how
 * one `orderBy: { effective_range: 'desc' }` on the leave page reappeared on the entities page.
 */
const scope: BrowserSyncScope = {
	workspaceId: 'ws',
	tenantId: TenantId.make('tenant-1'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release-1')
};
const plans = {
	kind: 'findMany' as const,
	collection: 'leave_plans',
	orderBy: { effective_range: 'desc' as const },
	limit: 20
};
const entities = {
	kind: 'findMany' as const,
	collection: 'entities',
	orderBy: { id: 'asc' as const },
	limit: 20
};
const sentence =
	'Live ordering requires a scalar field: leave_plans.effective_range is instant_range, which cannot key a live prefix. Order by a scalar column, such as one generated from it.';
const plansKey = stableKey(plans);
const entitiesKey = stableKey(entities);

const accepted = (keys: ReadonlyArray<string>) => ({
	queries: keys.map((queryKey) => ({
		queryKey,
		version: 0,
		rows: [] as const,
		retainedBytes: syncRetainedPrefixBytes([])
	})),
	outcomes: [] as const
});

const refusingAttachment = (requests: string[][]): SyncWorkspaceAttachment => ({
	scope,
	register: async (request) => {
		const keys = request.queries.map(({ queryKey }) => queryKey);
		requests.push(keys);
		if (keys.includes(plansKey)) throw new SyncHttpError(sentence, 400, true);
		return accepted(keys);
	},
	extend: async () => {
		throw new Error('extend is unused');
	},
	push: async () => undefined,
	subscribe: () => () => undefined
});

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('opening-request refusal', () => {
	const clients: Array<{ shutdown: () => void }> = [];
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		for (const client of clients) client.shutdown();
		clients.length = 0;
		vi.useRealTimers();
	});

	it('fails the refused query once, keeps the link, and never asks for it again', async () => {
		const requests: string[][] = [];
		const errors: unknown[] = [];
		const client = createSyncClient({ scope, onError: (cause) => errors.push(cause) });
		clients.push(client);
		client.attach(refusingAttachment(requests));
		client.mount(plans);
		client.start();
		await settle();

		expect(client.current().queries.get(plansKey)).toMatchObject({
			phase: 'failed',
			error: sentence
		});
		expect(client.current().link).not.toBe('closed');
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(Error);
		expect((errors[0] as Error).message).toBe(sentence);

		// The next page mounts on the same client; the refused key is dropped from the opening
		// request that follows, and the link comes up without it.
		expect(() => client.mount(entities)).not.toThrow();
		await vi.advanceTimersByTimeAsync(35_000);
		expect(client.current().link).toBe('live');
		expect(client.current().queries.get(entitiesKey)).toMatchObject({ phase: 'fresh' });
		expect(client.current().queries.get(plansKey)).toMatchObject({
			phase: 'failed',
			error: sentence
		});
		expect(requests.filter((keys) => keys.includes(plansKey))).toHaveLength(1);
		expect(errors).toHaveLength(1);
	});

	it('lands a batched opening refusal on the query it names and opens the rest', async () => {
		const requests: string[][] = [];
		const client = createSyncClient({ scope });
		clients.push(client);
		client.attach(refusingAttachment(requests));
		client.mount(plans);
		client.mount(entities);
		client.start();
		await settle();

		expect(requests[0]).toEqual(expect.arrayContaining([plansKey, entitiesKey]));
		expect(client.current().link).toBe('live');
		expect(client.current().queries.get(entitiesKey)).toMatchObject({ phase: 'fresh' });
		expect(client.current().queries.get(plansKey)).toMatchObject({
			phase: 'failed',
			error: sentence
		});

		await vi.advanceTimersByTimeAsync(35_000);
		expect(requests.filter((keys) => keys.includes(plansKey))).toHaveLength(2);
		expect(client.current().queries.get(plansKey)?.phase).toBe('failed');
	});
});
