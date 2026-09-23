import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import {
	EnvironmentName,
	FixedCommandCatalogue,
	ReleaseId,
	syncRetainedPrefixBytes,
	TenantId,
	type StoredRecord,
	type SyncQueryInput
} from '@norbital-ai/bolt-protocol';
import { createBoltClient } from '../src/client.js';
import { createWorkspaceApiProxy } from '../src/client/runtime.js';
import { stableKey } from '../src/client/live-query/stable-key.js';
import { initialClientState, type ClientState } from '../src/client/sync/machine.js';
import type {
	BoltClient,
	MutationSettlement,
	MutationSettlements,
	WorkspaceClientRuntime
} from '../src/client/contracts.js';
import type { SyncClient } from '../src/client/sync/client.js';

const scope = {
	tenantId: TenantId.make('tenant'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release')
};

/**
 * A SyncClient double that answers reads the way the Machine does.
 *
 * `publish` paints one query's prefix with the phase the caller names; `detached` counts unmounts.
 */
const fakeSyncClient = () => {
	let state = initialClientState();
	const listeners = new Set<(state: ClientState) => void>();
	const mounted: Array<{ readonly key: string; readonly input: unknown }> = [];
	let detached = 0;
	const client = {
		start: () => undefined,
		attach: () => () => undefined,
		shutdown: () => undefined,
		wake: () => undefined,
		current: () => state,
		subscribe: (listener: (state: ClientState) => void) => {
			listeners.add(listener);
			listener(state);
			return () => listeners.delete(listener);
		},
		mount: (input: SyncQueryInput) => {
			const key = stableKey(input);
			mounted.push({ key, input });
			return {
				key,
				extend: () => undefined,
				detach: () => {
					detached += 1;
				}
			};
		},
		enqueue: () => undefined,
		answer: () => undefined,
		publish: (
			key: string,
			rows: ReadonlyArray<StoredRecord>,
			phase: 'fresh' | 'pending' = 'fresh'
		) => {
			const input = mounted.find((entry) => entry.key === key)?.input as SyncQueryInput | undefined;
			if (input === undefined) throw new Error(`Unknown mounted query ${key}`);
			state = {
				...state,
				queries: new Map([...state.queries]).set(key, {
					input,
					prefix: { version: 1, rows, retainedBytes: syncRetainedPrefixBytes(rows) },
					requestedPrefix: input.kind === 'findFirst' ? 1 : (input.limit ?? 100),
					phase,
					validating: phase === 'pending',
					extending: false,
					subscribers: 1
				})
			};
			for (const listener of listeners) listener(state);
		}
	};
	return { client, mounted, detached: () => detached };
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
	mutation: { partitionKey: 'test-partition', schemaFingerprint: 'sha256:test' },
	syncStatus: initialClientState(),
	settlements: inertSettlements
});

const proxyWith = (sync: ReturnType<typeof fakeSyncClient>) => {
	const bolt = createBoltClient(scope, { command: async () => null });
	return createWorkspaceApiProxy(runtimeOf(bolt, sync.client));
};

describe('collection search handoff', () => {
	it('carries the search string unchanged', () => {
		const sync = fakeSyncClient();
		const bolt = createBoltClient(scope, { command: async () => null });
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt, sync.client));
		const employees = Reflect.get(proxy.db, 'employees') as {
			findMany: (input?: object) => { readonly current: unknown };
		};
		employees.findMany({ search: '/semantic similar contracts' });
		employees.findMany({ search: 'similar contracts' });
		employees.findMany({ search: '>' });
		// The browser carries the string unchanged; the server's one parser reads the grammar.
		expect(sync.mounted.map((mounted) => mounted.input)).toEqual(
			['/semantic similar contracts', 'similar contracts', '>'].map((search) => ({
				kind: 'findMany',
				collection: 'employees',
				search
			}))
		);
	});

	it('carries semantic search unchanged through a one-shot count command', async () => {
		const commands: Array<{ readonly command: string; readonly input: unknown }> = [];
		const bolt = createBoltClient(scope, {
			command: (command, input) => {
				commands.push({ command, input });
				return Promise.resolve(7);
			}
		});
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt, fakeSyncClient().client));
		const employees = Reflect.get(proxy.db, 'employees') as {
			count: (input?: object) => PromiseLike<number>;
		};

		await expect(employees.count({ search: '/semantic similar contracts' })).resolves.toBe(7);
		expect(commands).toEqual([
			{
				command: 'collections.count',
				input: {
					collection: 'employees',
					search: '/semantic similar contracts'
				}
			}
		]);
	});

	it('refuses the retired structured search commands', () => {
		const sync = fakeSyncClient();
		const bolt = createBoltClient(scope, { command: async () => null });
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt, sync.client));
		const employees = Reflect.get(proxy.db, 'employees') as {
			findMany: (input?: object) => { readonly current: unknown };
		};
		expect(() => employees.findMany({ search: { mode: 'lexical', term: 'retired' } })).toThrow();
		expect(sync.mounted).toHaveLength(0);
	});

	it('answers a cursored page once without mounting a live prefix', async () => {
		const sync = fakeSyncClient();
		const commands: Array<{ readonly command: string; readonly input: unknown }> = [];
		const bolt = createBoltClient(scope, {
			command: (command, input) => {
				commands.push({ command, input });
				return Promise.resolve({
					rows: [{ id: 'p1', name: 'Ada' }],
					nextCursor: 'page-2-token'
				});
			}
		});
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt, sync.client));
		const employees = Reflect.get(proxy.db, 'employees') as {
			findMany: (input?: object) => PromiseLike<unknown> & { readonly nextCursor: unknown };
		};
		const query = employees.findMany({ limit: 1, after: 'page-1-token' });
		expect(await query).toEqual([{ id: 'p1', name: 'Ada' }]);
		expect(query.nextCursor).toBe('page-2-token');
		expect(sync.mounted).toHaveLength(0);
		expect(sync.detached()).toBe(0);
		expect(commands).toEqual([
			{
				command: 'collections.findMany',
				input: { collection: 'employees', limit: 1, after: 'page-1-token' }
			}
		]);
		const posted = commands[0]?.command;
		expect(posted).toBeDefined();
		expect(
			FixedCommandCatalogue.some((contract) => contract.name === posted),
			posted
		).toBe(true);
	});

	it('resolves an authoritative empty findFirst instead of waiting forever', async () => {
		const sync = fakeSyncClient();
		const proxy = proxyWith(sync);
		const people = Reflect.get(proxy.db, 'people') as {
			findFirst: (input?: object) => PromiseLike<unknown> & { readonly loading: boolean };
		};
		const query = people.findFirst({ where: { name: { eq: 'Nobody' } } });
		sync.client.publish(sync.mounted[0]?.key ?? '', []);
		// An empty retained prefix is authoritative: the awaited half settles with undefined and
		// `loading` is false, while a pending query without current truth keeps waiting.
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
		sync.client.publish(key, [], 'pending');
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
		sync.client.publish(key, [{ id: 'p1', name: 'Ada' }]);
		expect(await query).toEqual({ id: 'p1', name: 'Ada' });
	});
});
