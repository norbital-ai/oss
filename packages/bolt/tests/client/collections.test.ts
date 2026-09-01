import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import {
	EnvironmentName,
	ReleaseId,
	syncJsonByteLength,
	TenantId,
	type CollectionMutateRequest,
	type StoredRecord,
	type SyncQueryInput
} from '@norbital-ai/bolt-protocol';
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

const scope = {
	tenantId: TenantId.make('tenant'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('release')
};

/**
 * A SyncClient double that answers reads the way the Machine does.
 *
 * Collection reads are Machine-backed now: the proxy mounts one live question and the Machine
 * publishes its prefix, so a fake has to hold query state and notify subscribers rather than
 * transport a command. `publish` paints one query's prefix with the phase the caller names, which
 * is what lets a test drive both the fresh and the revalidating paints.
 */
const fakeSyncClient = () => {
	let state = initialClientState();
	const listeners = new Set<(state: ClientState) => void>();
	const mounted: Array<{ readonly key: string; readonly input: unknown }> = [];
	const enqueued: Array<CollectionMutateRequest> = [];
	const client = {
		start: () => undefined,
		attach: () => () => undefined,
		shutdown: () => undefined,
		current: () => state,
		subscribe: (listener: (state: ClientState) => void) => {
			listeners.add(listener);
			listener(state);
			return () => listeners.delete(listener);
		},
		mount: (input: Schema.Json) => {
			const key = stableKey(input);
			mounted.push({ key, input });
			return { key, extend: () => undefined, detach: () => undefined };
		},
		enqueue: (request: CollectionMutateRequest) => enqueued.push(request),
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
					prefix: { version: 1, rows, retainedBytes: syncJsonByteLength(rows) },
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
	return { client, mounted, enqueued };
};

/**
 * The runtime members these tests never drive: no live mount runs outside the fake Machine above,
 * and no write is ever settled, so the stubs stay inert while satisfying the runtime contract.
 */
const inertSync: SyncClient = {
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

const inertSettlements: MutationSettlements = {
	create: (idempotencyKey) => ({
		idempotencyKey,
		settled: new Promise<MutationSettlement>(() => undefined),
		status: async () => 'unknown',
		wait: () => new Promise<MutationSettlement>(() => undefined)
	}),
	accept: () => undefined
};

const runtimeOf = (bolt: BoltClient, sync: SyncClient = inertSync): WorkspaceClientRuntime => ({
	bolt,
	db: {},
	sync,
	mutation: { partitionKey: 'test-partition', schemaFingerprint: 'sha256:test' },
	syncStatus: initialClientState(),
	settlements: inertSettlements
});

describe('typed browser client', () => {
	it('preserves actionable transport failures at the command boundary', async () => {
		const failure = new Error('invalid_input: employees.created_at is managed by Bolt');
		const bolt = createBoltClient(scope, { command: () => Promise.reject(failure) });

		await expect(bolt.command('collections.mutate', {}, Schema.Json)).rejects.toBe(failure);
	});

	it('makes reactive remote invocations awaitable while preserving the live handle', async () => {
		const commands: Array<string> = [];
		const bolt = createBoltClient(scope, {
			command: (command) => {
				commands.push(command);
				return Promise.resolve({ answer: 42 });
			}
		});
		const runtime = runtimeOf(bolt);
		const proxy = createWorkspaceApiProxy(runtime);
		const query = proxy.invoke['forecast']?.({});
		expect(query?.loading).toBe(true);
		expect(await query).toEqual({ answer: 42 });
		expect(commands).toEqual(['invoke.forecast']);
	});

	it('answers collection pages from the machine instead of a transport command', async () => {
		const commands: Array<{ readonly command: string; readonly input: unknown }> = [];
		const bolt = createBoltClient(scope, {
			command: (command, input) => {
				commands.push({ command, input });
				return Promise.resolve(null);
			}
		});
		const sync = fakeSyncClient();
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt, sync.client));
		const employees = Reflect.get(proxy.db, 'employees') as
			| {
					findMany: (input?: object) => PromiseLike<unknown> & { readonly nextCursor: unknown };
			  }
			| undefined;
		const query = employees?.findMany({ limit: 20, after: undefined });
		expect(sync.mounted).toHaveLength(1);
		// The mounted question is the whole read: `after: undefined` has no JSON representation and is
		// stripped before it reaches the wire, exactly as omission would be.
		expect(sync.mounted[0]?.input).toEqual({
			kind: 'findMany',
			collection: 'employees',
			limit: 20
		});
		sync.client.publish(sync.mounted[0]?.key ?? '', [{ id: 'e1', name: 'Ada' }]);
		expect(proxy.collections['employees']?.name).toBe('employees');
		expect(await query).toEqual([{ id: 'e1', name: 'Ada' }]);
		// A cursored read is one-shot and never live: no page walk is registered, so there is no next
		// cursor to walk and no read command ever crossed the transport.
		expect(query?.nextCursor).toBeNull();
		expect(commands).toEqual([]);
	});

	it('enqueues the complete protocol-v2 mutation envelope with authoritative base versions', async () => {
		const sync = fakeSyncClient();
		const bolt = createBoltClient(scope, { command: async () => null });
		const runtime = runtimeOf(bolt, sync.client);
		const proxy = createWorkspaceApiProxy(runtime, {
			employees: { name: 'employees', fields: [], relationships: [] }
		});
		const employees = Reflect.get(proxy.db, 'employees') as {
			findMany: () => { readonly current: unknown };
			mutate: (values: Schema.Json) => Promise<{ readonly row: unknown }>;
		};
		employees.findMany();
		sync.client.publish(sync.mounted[0]?.key ?? '', [
			{ id: 'employee-1', name: 'Ada', row_version: 7 }
		]);

		await employees.mutate({ id: 'employee-1', name: 'Grace' });
		await employees.mutate({ name: 'Lin' });

		expect(sync.enqueued).toHaveLength(2);
		expect(sync.enqueued[0]).toMatchObject({
			protocolVersion: 2,
			partitionKey: 'test-partition',
			schemaFingerprint: 'sha256:test',
			graph: {
				action: 'update',
				collection: 'employees',
				values: { id: 'employee-1', name: 'Grace' }
			},
			baseVersions: [
				{
					row: { collection: 'employees', recordId: 'employee-1' },
					rowVersion: 7
				}
			]
		});
		expect(sync.enqueued[0]?.issuedAtEpochMs).toBeGreaterThan(0);
		expect(sync.enqueued[0]?.idempotencyKey).toBeTypeOf('string');
		expect(sync.enqueued[1]).toMatchObject({
			protocolVersion: 2,
			graph: { action: 'create', collection: 'employees', values: { name: 'Lin' } },
			baseVersions: []
		});
	});

	it('includes known nested relationship rows in the whole-row base vector', async () => {
		const sync = fakeSyncClient();
		const bolt = createBoltClient(scope, { command: async () => null });
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt, sync.client), {
			orders: {
				name: 'orders',
				fields: [],
				relationships: [{ name: 'lines', target: 'order_lines', cardinality: 'many' }]
			},
			order_lines: { name: 'order_lines', fields: [], relationships: [] }
		});
		const orders = Reflect.get(proxy.db, 'orders') as {
			findMany: () => unknown;
			mutate: (values: Schema.Json) => Promise<unknown>;
		};
		const lines = Reflect.get(proxy.db, 'order_lines') as { findMany: () => unknown };
		orders.findMany();
		lines.findMany();
		sync.client.publish(sync.mounted[0]?.key ?? '', [
			{ id: 'order-1', reference: 'A', row_version: 3 }
		]);
		sync.client.publish(sync.mounted[1]?.key ?? '', [
			{ id: 'line-1', sku: 'OLD', row_version: '9' }
		]);

		await orders.mutate({
			id: 'order-1',
			reference: 'B',
			lines: [
				{ id: 'line-1', sku: 'NEW' },
				{ id: 'line-new', sku: 'NEW-ROW' }
			]
		});

		expect(sync.enqueued[0]?.baseVersions).toEqual([
			{ row: { collection: 'orders', recordId: 'order-1' }, rowVersion: 3 },
			{ row: { collection: 'order_lines', recordId: 'line-1' }, rowVersion: 9 }
		]);
	});

	it('seals private platform collections out of the authored browser proxy', () => {
		const bolt = createBoltClient(scope, { command: async () => null });
		const proxy = createWorkspaceApiProxy(
			runtimeOf(bolt),
			{
				employees: { name: 'employees', fields: [], relationships: [] },
				approval_request: { name: 'approval_request', fields: [], relationships: [] },
				user: { name: 'user', fields: [], relationships: [] }
			},
			{
				allowedCollections: ['employees', 'approval_request'],
				readOnlyCollections: ['approval_request'],
				system: false
			}
		);

		expect(Reflect.get(proxy, 'system')).toBeUndefined();
		expect(Reflect.get(proxy.db, 'user')).toBeUndefined();
		expect(proxy.collections['user']).toBeUndefined();
		expect(() => proxy.records.findMany('user')).toThrow(/private to the Bolt runtime/);
		expect(() => proxy.history.findMany('agent_task', 'task-1')).toThrow(
			/private to the Bolt runtime/
		);
		expect(Reflect.get(proxy.db, 'employees')).toBeDefined();
		const approval = Reflect.get(proxy.db, 'approval_request');
		expect(approval).toBeDefined();
		if (approval === null || typeof approval !== 'object')
			throw new Error('approval_request did not resolve to a collection surface');
		expect(Reflect.get(approval, 'findMany')).toBeTypeOf('function');
		expect(Reflect.get(approval, 'mutate')).toBeUndefined();
		expect(Reflect.get(approval, 'pending')).toBeUndefined();
	});

	it('answers a grouped aggregate as a one-shot command without mounting a live prefix', async () => {
		const sync = fakeSyncClient();
		const commands: Array<{ readonly command: string; readonly input: unknown }> = [];
		const grouped = {
			active: [
				{ id: 'e1', status: 'active' },
				{ id: 'e2', status: 'active' }
			],
			pending: [],
			closed: [{ id: 'e3', status: 'closed' }]
		};
		const bolt = createBoltClient(scope, {
			command: (command, input) => {
				commands.push({ command, input });
				return Promise.resolve(grouped);
			}
		});
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt, sync.client));
		const employees = Reflect.get(proxy.db, 'employees') as {
			findGrouped: (input: object) => PromiseLike<unknown>;
		};

		const query = employees.findGrouped({
			where: { archived: { eq: false } },
			group: { by: 'status', lanes: ['active', 'pending', 'closed'] }
		});
		expect(sync.mounted).toHaveLength(0);
		await expect(query).resolves.toEqual(grouped);
		expect(commands).toEqual([
			{
				command: 'collections.findGrouped',
				input: {
					collection: 'employees',
					where: { archived: { eq: false } },
					group: { by: 'status', lanes: ['active', 'pending', 'closed'] }
				}
			}
		]);
	});

	it('loads an approval request by id instead of mistaking timeline events for request rows', async () => {
		const commands: Array<{ readonly command: string; readonly input: unknown }> = [];
		const bolt = createBoltClient(scope, {
			command: (command, input) => {
				commands.push({ command, input });
				return Promise.resolve([
					{
						id: 'request-1',
						status: 'ONGOING',
						canDecide: false,
						canSupersede: false,
						canWithdraw: true
					}
				]);
			}
		});
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt));

		expect(await proxy.approvals.findMany('request-1')).toEqual([
			{
				id: 'request-1',
				status: 'ONGOING',
				canDecide: false,
				canSupersede: false,
				canWithdraw: true
			}
		]);
		expect(commands).toEqual([
			{
				command: 'approvals.capabilities',
				input: { requestId: 'request-1' }
			}
		]);
	});

	it('sends request-for-change as a distinct approval decision', async () => {
		const commands: Array<{ readonly command: string; readonly input: unknown }> = [];
		const bolt = createBoltClient(scope, {
			command: (command, input) => {
				commands.push({ command, input });
				if (command === 'approvals.status') {
					return Promise.resolve({
						_tag: 'Pending',
						requestId: 'request-1',
						step: 0,
						operation: { collection: 'orders' }
					});
				}
				return Promise.resolve({});
			}
		});
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt));

		await proxy.approvals.process({
			approvalRequestId: 'request-1',
			action: 'REQUEST_FOR_CHANGE',
			comments: 'Attach the supporting document.'
		});

		expect(commands).toEqual([
			{ command: 'approvals.status', input: { requestId: 'request-1' } },
			{
				command: 'approvals.decide',
				input: {
					state: {
						_tag: 'Pending',
						requestId: 'request-1',
						step: 0,
						operation: { collection: 'orders' }
					},
					decision: 'request_changes',
					reason: 'Attach the supporting document.'
				}
			}
		]);
	});
});
