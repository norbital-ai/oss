import { beforeEach, describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { EnvironmentName, ReleaseId, TenantId, type SyncAnswer } from '@norbital-ai/bolt-protocol';
import { createBoltClient } from '../../src/client.js';
import { createWorkspaceApiProxy } from '../../src/client/runtime.js';
import { stableKey } from '../../src/client/live-query/stable-key.js';
import { initialClientState, type ClientState } from '../../src/client/sync/machine.js';
import type {
	BoltClient,
	MutationSettlement,
	MutationSettlements,
	WorkspaceClientRuntime
} from '../../src/client/contracts.js';
import type { SyncClient } from '../../src/client/sync/index.js';
import { setWorkspaceSession } from '#lib/client/session.js';

const scope = {
	tenantId: TenantId.make('tenant'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release')
};

/**
 * A SyncClient double that answers reads the way the Machine does.
 *
 * `publish` paints one query's answer with the phase the caller names; `released` counts the
 * unmounts, which is what a one-shot read must produce once its answer has landed.
 */
const fakeSyncClient = () => {
	let state = initialClientState();
	const listeners = new Set<(state: ClientState) => void>();
	const mounted: Array<{ readonly key: string; readonly input: unknown }> = [];
	let released = 0;
	const client = {
		start: () => undefined,
		current: () => state,
		subscribe: (listener: (state: ClientState) => void) => {
			listeners.add(listener);
			listener(state);
			return () => listeners.delete(listener);
		},
		mount: (input: Schema.Json) => {
			const key = stableKey(input);
			mounted.push({ key, input });
			return {
				key,
				release: () => {
					released += 1;
				}
			};
		},
		enqueue: () => undefined,
		publish: (key: string, answer: SyncAnswer, phase: 'fresh' | 'pending' = 'fresh') => {
			state = {
				...state,
				queries: new Map([...state.queries]).set(key, {
					input: { kind: 'findMany', collection: 'people' },
					answer,
					phase,
					subscribers: 1
				})
			};
			for (const listener of listeners) listener(state);
		}
	};
	return { client, mounted, released: () => released };
};

/**
 * The runtime members these tests never drive: reads ride the fake Machine above and no write is
 * ever settled, so the stubs stay inert while satisfying the runtime contract.
 */
const inertSettlements: MutationSettlements = {
	create: (idempotencyKey) => ({
		idempotencyKey,
		settled: new Promise<MutationSettlement>(() => undefined),
		status: async () => 'unknown',
		wait: () => new Promise<MutationSettlement>(() => undefined)
	}),
	accept: () => undefined
};

const runtimeOf = (bolt: BoltClient, sync: SyncClient): WorkspaceClientRuntime => ({
	bolt,
	db: {},
	sync,
	syncStatus: initialClientState(),
	settlements: inertSettlements
});

const proxyWith = (sync: ReturnType<typeof fakeSyncClient>) => {
	const bolt = createBoltClient(scope, { command: async () => null });
	return createWorkspaceApiProxy(runtimeOf(bolt, sync.client));
};

beforeEach(() => {
	setWorkspaceSession({
		tenantId: 'typed-client-test',
		environment: 'test',
		releaseId: 'release',
		principal: 'operator-1',
		accessScope: 'operator',
		credential: 'test-credential',
		transport: { command: async () => null },
		syncStreamUrl: '/sync',
		files: {
			store: async () => '',
			remove: async () => undefined,
			urlFor: (key) => key
		},
		chatDocuments: {
			store: async (_conversation, key, file) => ({
				storage_key: key,
				file_name: file.name,
				file_size: file.size,
				mime_type: file.type || 'application/octet-stream'
			}),
			remove: async () => undefined,
			urlFor: (_conversation, key) => key
		},
		operations: { read: async () => null, run: async () => null }
	});
});

describe('collection search handoff', () => {
	it('carries explicit lexical and semantic commands without inferring a mode', () => {
		const sync = fakeSyncClient();
		const bolt = createBoltClient(scope, { command: async () => null });
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt, sync.client));
		const employees = Reflect.get(proxy.db, 'employees') as {
			findMany: (input?: object) => { readonly current: unknown };
			count: (input?: object) => unknown;
		};
		employees.findMany({ search: { mode: 'semantic', term: 'similar contracts' } });
		employees.findMany({ search: { mode: 'lexical', term: 'similar contracts' } });
		employees.findMany({ search: { mode: 'lexical', term: '>' } });
		employees.count({ search: { mode: 'semantic', term: 'similar contracts' } });
		// The browser carries the chosen arm unchanged; it does not decode string conventions.
		expect(sync.mounted[0]?.input).toEqual({
			kind: 'findMany',
			collection: 'employees',
			search: { mode: 'semantic', term: 'similar contracts' }
		});
		expect(sync.mounted[1]?.input).toEqual({
			kind: 'findMany',
			collection: 'employees',
			search: { mode: 'lexical', term: 'similar contracts' }
		});
		expect(sync.mounted[2]?.input).toEqual({
			kind: 'findMany',
			collection: 'employees',
			search: { mode: 'lexical', term: '>' }
		});
		expect(sync.mounted[3]?.input).toEqual({
			kind: 'count',
			collection: 'employees',
			search: { mode: 'semantic', term: 'similar contracts' }
		});
	});

	it('refuses the removed plain-string search arm', () => {
		const sync = fakeSyncClient();
		const bolt = createBoltClient(scope, { command: async () => null });
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt, sync.client));
		const employees = Reflect.get(proxy.db, 'employees') as {
			findMany: (input?: object) => { readonly current: unknown };
		};
		expect(() => employees.findMany({ search: 'legacy string' })).toThrow();
		expect(sync.mounted).toHaveLength(0);
	});

	it('answers a cursored page once, carries its nextCursor, and releases the mount', async () => {
		const sync = fakeSyncClient();
		const proxy = proxyWith(sync);
		const employees = Reflect.get(proxy.db, 'employees') as {
			findMany: (input?: object) => PromiseLike<unknown> & { readonly nextCursor: unknown };
		};
		const query = employees.findMany({ limit: 1, after: 'page-1-token' });
		expect(sync.mounted).toHaveLength(1);
		expect(sync.mounted[0]?.input).toEqual({
			kind: 'findMany',
			collection: 'employees',
			limit: 1,
			after: 'page-1-token'
		});
		// The cursored answer rides the SyncAnswer page arm: rows beside the continuation.
		sync.client.publish(sync.mounted[0]?.key ?? '', {
			rows: [{ id: 'p1', name: 'Ada' }],
			nextCursor: 'page-2-token'
		});
		expect(await query).toEqual([{ id: 'p1', name: 'Ada' }]);
		expect(query.nextCursor).toBe('page-2-token');
		// Answered once, then released — the §2.3 one-shot: the unmounted control still fires, so
		// the host stops computing for the page once retention lapses.
		expect(sync.released()).toBe(1);
	});

	it('resolves an authoritative empty findFirst instead of waiting forever', async () => {
		const sync = fakeSyncClient();
		const proxy = proxyWith(sync);
		const people = Reflect.get(proxy.db, 'people') as {
			findFirst: (input?: object) => PromiseLike<unknown> & { readonly loading: boolean };
		};
		const query = people.findFirst({ where: { name: { eq: 'Nobody' } } });
		sync.client.publish(sync.mounted[0]?.key ?? '', null);
		// `null` is the authoritative empty set, not a missing answer: the awaited half settles
		// with undefined (the same value a template reads from `current`), and `loading` is false
		// because the answer exists — while a pending query keeps waiting.
		await expect(query).resolves.toBeUndefined();
		expect(query.loading).toBe(false);
	});

	it('keeps a pending query waiting until its answer exists', async () => {
		const sync = fakeSyncClient();
		const proxy = proxyWith(sync);
		const people = Reflect.get(proxy.db, 'people') as {
			findFirst: (input?: object) => PromiseLike<unknown> & { readonly loading: boolean };
		};
		const query = people.findFirst({});
		const key = sync.mounted[0]?.key ?? '';
		sync.client.publish(key, null, 'pending');
		expect(query.loading).toBe(true);
		let settled = false;
		void Promise.resolve(query).then(
			() => {
				settled = true;
			},
			() => undefined
		);
		await Promise.resolve();
		expect(settled).toBe(false);
		sync.client.publish(key, { id: 'p1', name: 'Ada' });
		expect(await query).toEqual({ id: 'p1', name: 'Ada' });
	});
});
