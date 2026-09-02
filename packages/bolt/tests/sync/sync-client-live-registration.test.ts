import { EnvironmentName, ReleaseId, TenantId, syncRetainedPrefixBytes } from '@norbital-ai/bolt-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createSyncClient,
	type SyncWorkspaceAttachment
} from '../../src/client/sync/client.js';
import { SyncHttpError } from '../../src/client/sync/http-driver.js';
import { stableKey } from '../../src/client/live-query/stable-key.js';
import type { BrowserSyncScope } from '../../src/client/sync/sse-driver.js';

const scope: BrowserSyncScope = {
	workspaceId: 'ws',
	tenantId: TenantId.make('tenant-1'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release-1')
};

const jobs = {
	kind: 'findMany' as const,
	collection: 'jobs',
	orderBy: { id: 'asc' as const },
	limit: 20
};
const people = {
	kind: 'findMany' as const,
	collection: 'people',
	orderBy: { id: 'asc' as const },
	limit: 20
};

const accepted = (queryKey: string) => ({
	queries: [
		{
			queryKey,
			version: 0,
			rows: [] as const,
			retainedBytes: syncRetainedPrefixBytes([])
		}
	],
	outcomes: [] as const
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const attachment = (
	register: SyncWorkspaceAttachment['register']
): SyncWorkspaceAttachment => ({
	scope,
	register,
	extend: async () => {
		throw new Error('extend is unused');
	},
	push: async () => undefined,
	subscribe: () => () => undefined
});

describe('live-link registration failure', () => {
	const clients: Array<{ shutdown: () => void }> = [];
	afterEach(() => {
		for (const client of clients) client.shutdown();
		clients.length = 0;
	});

	it('retries a live-link 500 instead of failing the key permanently', async () => {
		const jobsKey = stableKey(jobs);
		const peopleKey = stableKey(people);
		const client = createSyncClient({ scope });
		clients.push(client);
		let registers = 0;
		client.attach(
			attachment(async (request) => {
				registers += 1;
				const key = request.queries[0]?.queryKey;
				if (registers === 1 && key === jobsKey) return accepted(jobsKey);
				if (key === peopleKey) throw new SyncHttpError('upstream unavailable', 500, false);
				return accepted(key ?? jobsKey);
			})
		);
		client.mount(jobs);
		client.start();
		await flush();
		expect(client.current().link).toBe('live');
		expect(client.current().queries.get(jobsKey)?.phase).toBe('fresh');

		client.mount(people);
		await flush();
		expect(client.current().link).toBe('reconnecting');
		expect(client.current().queries.get(peopleKey)?.phase).not.toBe('failed');
		expect(client.current().queries.get(jobsKey)?.phase).not.toBe('failed');
	});

	it('fails only the refused keys when a live registration is a 400', async () => {
		const jobsKey = stableKey(jobs);
		const peopleKey = stableKey(people);
		const sentence = 'The initial live prefix exceeds its encoded byte ceiling.';
		const client = createSyncClient({ scope });
		clients.push(client);
		let registers = 0;
		client.attach(
			attachment(async (request) => {
				registers += 1;
				const key = request.queries[0]?.queryKey;
				if (registers === 1 && key === jobsKey) return accepted(jobsKey);
				if (key === peopleKey) throw new SyncHttpError(sentence, 400, true);
				return accepted(key ?? jobsKey);
			})
		);
		client.mount(jobs);
		client.start();
		await flush();
		expect(client.current().link).toBe('live');

		client.mount(people);
		await flush();
		expect(client.current().link).toBe('live');
		expect(client.current().queries.get(jobsKey)).toMatchObject({ phase: 'fresh' });
		expect(client.current().queries.get(peopleKey)).toMatchObject({
			phase: 'failed',
			error: sentence
		});
	});
});
