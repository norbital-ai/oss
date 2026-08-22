import { describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { EnvironmentName, ReleaseId, TenantId } from '@norbital-ai/bolt-protocol';
import { createBoltClient } from '../../src/client.js';
import { createWorkspaceApiProxy } from '../../src/client/runtime.js';
import {
	ANY_COLLECTION,
	cacheKeyFor,
	collectionsFor,
	createQueryCache
} from '../../src/client/replica/query-cache.js';
import { createLiveQueryRegistry } from '../../src/client/replica/live-queries.js';

const scope = {
	tenantId: TenantId.make('tenant'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release')
};

/** Lets a test hold a response open, so what the cache paints is observable while the wire is busy. */
const deferred = () => {
	let resolve: (value: unknown) => void = () => undefined;
	const promise = new Promise<unknown>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
};

describe('the sync engine read cache', () => {
	it('keys a query by its question, independent of object key order', () => {
		expect(cacheKeyFor('collections.findMany', { collection: 'people', limit: 20 })).toBe(
			cacheKeyFor('collections.findMany', { limit: 20, collection: 'people' })
		);
		expect(cacheKeyFor('collections.findMany', { collection: 'people', limit: 20 })).not.toBe(
			cacheKeyFor('collections.findMany', { collection: 'people', limit: 21 })
		);
	});

	it('names the collections an answer depends on, and admits when it cannot know', () => {
		expect(collectionsFor('collections.findMany', { collection: 'leave_requests' })).toEqual([
			'leave_requests'
		]);
		// A join makes the answer depend on the joined rows just as much as on the root rows.
		expect(
			collectionsFor('collections.findMany', {
				collection: 'leave_requests',
				with: { leave_request_type: {} }
			})
		).toEqual(['leave_requests', 'leave_request_type']);
		// A remote handler is arbitrary server code; nothing in the input says what it read.
		expect(collectionsFor('invoke.approval_analytics', { subject: 'LEAVE' })).toEqual([
			ANY_COLLECTION
		]);
	});

	it('drops only the answers a change could falsify, and every answer on a wildcard', async () => {
		const cache = createQueryCache('tenant::test');
		cache.write('a', 1, ['leave_requests']);
		cache.write('b', 2, ['companies']);
		cache.write('c', 3, [ANY_COLLECTION]);

		// The remote entry goes too: it declared it could have read anything.
		expect(cache.invalidate(['leave_requests']).toSorted()).toEqual(['a', 'c']);
		expect(await Effect.runPromise(cache.read('b'))).toBe(2);
		expect(await Effect.runPromise(cache.read('a'))).toBeUndefined();
	});

	it('paints the previous answer before the wire replies, then stops once the change lands', async () => {
		const cache = createQueryCache('tenant::test');
		const queries = createLiveQueryRegistry();
		let held = deferred();
		const bolt = createBoltClient(scope, {
			command: () => held.promise as Promise<never>
		});
		const runtime = { bolt, db: {}, cache, queries };
		const proxy = createWorkspaceApiProxy(runtime);
		const employees = Reflect.get(proxy.db, 'employees') as {
			findMany: (input?: object) => { current: unknown };
		};

		// First read: nothing cached, so the answer only exists once the wire replies.
		const cold = employees.findMany({ limit: 20 });
		expect(cold.current).toBeUndefined();
		held.resolve({ rows: [{ id: 'e1', name: 'Ada' }], nextCursor: null });
		expect(await (cold as unknown as PromiseLike<unknown>)).toEqual([{ id: 'e1', name: 'Ada' }]);

		// Second read of the same question, with the wire held open: the cache is what paints.
		held = deferred();
		const warm = employees.findMany({ limit: 20 });
		await vi.waitFor(() => expect(warm.current).toEqual([{ id: 'e1', name: 'Ada' }]));

		// A write to that collection falsifies it, so the next read is cold again.
		cache.invalidate(['employees']);
		const afterChange = employees.findMany({ limit: 20 });
		await new Promise((settle) => setTimeout(settle, 10));
		expect(afterChange.current).toBeUndefined();
		held.resolve({ rows: [], nextCursor: null });
	});

	it('keeps schema-owned system reads reactive while decoding both cache and wire answers', async () => {
		const cache = createQueryCache('tenant::test');
		const queries = createLiveQueryRegistry();
		const held = deferred();
		cache.write(
			cacheKeyFor('schema.plan', {}),
			{ fingerprint: 'cached', steps: [{ id: 'cached-step', sql: 'select 1' }] },
			[ANY_COLLECTION]
		);
		const bolt = createBoltClient(scope, { command: () => held.promise });
		const proxy = createWorkspaceApiProxy({ bolt, db: {}, cache, queries });

		const plan = proxy.system.schema.plan({});
		await vi.waitFor(() => expect(plan.current?.fingerprint).toBe('cached'));
		expect(plan.loading).toBe(true);

		held.resolve({ fingerprint: 'fresh', steps: [{ id: 'fresh-step', sql: 'select 2' }] });
		await expect(Promise.resolve(plan)).resolves.toEqual({
			fingerprint: 'fresh',
			steps: [{ id: 'fresh-step', sql: 'select 2' }]
		});
		expect(plan.current?.fingerprint).toBe('fresh');
		expect(plan.loading).toBe(false);
	});

	it('rejects a system read whose wire answer does not satisfy its owned schema', async () => {
		const bolt = createBoltClient(scope, {
			command: async () => ({ fingerprint: 42, steps: 'not a schema plan' })
		});
		const proxy = createWorkspaceApiProxy({ bolt, db: {} });

		const plan = proxy.system.schema.plan({});
		await expect(Promise.resolve(plan)).rejects.toThrow();
		expect(plan.current).toBeUndefined();
		expect(plan.error).toBeInstanceOf(Error);
		expect(plan.loading).toBe(false);
	});
});

describe('the live query registry', () => {
	it('re-runs only the queries that read a changed collection', () => {
		const registry = createLiveQueryRegistry();
		const refreshed: Array<string> = [];
		const leave = {
			collections: ['leave_requests'],
			refresh: async () => {
				refreshed.push('leave');
			}
		};
		const companies = {
			collections: ['companies'],
			refresh: async () => {
				refreshed.push('companies');
			}
		};
		const remote = {
			collections: [ANY_COLLECTION],
			refresh: async () => {
				refreshed.push('remote');
			}
		};
		registry.register(leave);
		registry.register(companies);
		registry.register(remote);

		// The remote answers too: it never claimed to know what it read.
		expect(registry.refreshAffected(['leave_requests'])).toBe(2);
		expect(refreshed.toSorted()).toEqual(['leave', 'remote']);
	});
});
