import { describe, expect, it } from 'vitest';
import { Effect, Schema } from 'effect';
import {
	EnvironmentName,
	ReleaseId,
	syncRetainedPrefixBytes,
	TenantId,
	type CollectionMutationPush,
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
import type { ErasedAutomationClientApi } from '../src/client/automation-client.svelte.js';

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
	const enqueued: Array<CollectionMutationPush> = [];
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
		mount: (input: Schema.Json) => {
			const key = stableKey(input);
			mounted.push({ key, input });
			return { key, extend: () => undefined, detach: () => undefined };
		},
		enqueue: (request: CollectionMutationPush) => enqueued.push(request),
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
	wake: () => undefined,
	current: () => initialClientState(),
	subscribe: () => () => undefined,
	mount: (input) => ({
		key: stableKey(input),
		extend: () => undefined,
		detach: () => undefined
	}),
	enqueue: () => undefined,
	answer: () => undefined
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

type WriteSurface = {
	create(input: Schema.Json): Promise<{ readonly row: unknown }>;
	createMany(inputs: ReadonlyArray<Schema.Json>): Promise<{ readonly row: unknown }>;
	update(id: string, input: Schema.Json): Promise<{ readonly row: unknown }>;
	updateMany(inputs: ReadonlyArray<Schema.Json>): Promise<{ readonly row: unknown }>;
	delete(id: string): Promise<{ readonly row: unknown }>;
	deleteMany(ids: readonly string[]): Promise<{ readonly row: unknown }>;
	readonly pending: number;
};
const writesOf = (proxy: { readonly collection: object }, collection: string): WriteSurface => {
	const surface = Reflect.get(proxy.collection, collection) as WriteSurface | undefined;
	if (surface === undefined) throw new Error(`${collection} declares no write`);
	return surface;
};
const writable = { create: { columns: {} }, update: { columns: {} }, delete: true } as const;

const runtimeOf = (bolt: BoltClient, sync: SyncClient = inertSync): WorkspaceClientRuntime => ({
	bolt,
	db: {},
	sync,
	mutation: { partitionKey: 'test-partition', schemaFingerprint: 'sha256:test' },
	syncStatus: initialClientState(),
	settlements: inertSettlements
});

describe('typed browser client', () => {
	it('writes through the declared collection surface as one graph per call', async () => {
		const sync = fakeSyncClient();
		const bolt = createBoltClient(scope, { command: async () => null });
		const proxy = createWorkspaceApiProxy(
			runtimeOf(bolt, sync.client),
			{
				notes: { name: 'notes', fields: [], write: writable },
				drafts: { name: 'drafts', fields: [] }
			},
			{ allowedCollections: ['notes', 'drafts'] }
		);
		const notes = writesOf(proxy, 'notes');
		await notes.create({ body: 'hello' });
		await notes.createMany([{ body: 'a' }, { body: 'b' }]);
		await notes.update('n1', { body: 'edited' });
		await notes.updateMany([
			{ id: 'n1', body: 'x' },
			{ id: 'n2', body: 'y' }
		]);
		await notes.delete('n1');
		await notes.deleteMany(['n1', 'n2']);
		expect(sync.enqueued.map((request) => request.graph)).toEqual([
			{ collection: 'notes', action: 'create', inputs: [{ body: 'hello' }] },
			{ collection: 'notes', action: 'create', inputs: [{ body: 'a' }, { body: 'b' }] },
			{ collection: 'notes', action: 'update', inputs: [{ body: 'edited', id: 'n1' }] },
			{
				collection: 'notes',
				action: 'update',
				inputs: [
					{ id: 'n1', body: 'x' },
					{ id: 'n2', body: 'y' }
				]
			},
			{ collection: 'notes', action: 'delete', inputs: [{ id: 'n1' }] },
			{ collection: 'notes', action: 'delete', inputs: [{ id: 'n1' }, { id: 'n2' }] }
		]);
		expect(new Set(sync.enqueued.map((request) => request.idempotencyKey)).size).toBe(6);
		// A collection with no declared write, or one the shell never published, has no surface.
		expect(Reflect.get(proxy.collection, 'drafts')).toBeUndefined();
		expect(Reflect.get(proxy.collection, 'bolt_approvals')).toBeUndefined();
		await expect(notes.updateMany([{ body: 'no id' }])).rejects.toThrow(/names no record id/);
		await expect(notes.deleteMany(['n1', 'n1'])).rejects.toThrow(/more than once/);
		await expect(notes.createMany([])).rejects.toThrow(/at least one input/);
	});
	it('attaches the observed row version of every row the declared input names', async () => {
		const bolt = createBoltClient(scope, { command: async () => null });
		const sync = fakeSyncClient();
		const mounted = sync.client.mount({ kind: 'findMany', collection: 'notes' });
		sync.client.publish(mounted.key, [{ id: 'n1', row_version: 3, body: 'hello' }]);
		const proxy = createWorkspaceApiProxy(
			runtimeOf(bolt, sync.client),
			{ notes: { name: 'notes', fields: [], write: writable } },
			{ allowedCollections: ['notes'] }
		);
		await writesOf(proxy, 'notes').update('n1', { body: 'edited' });
		expect(sync.enqueued[0]).toMatchObject({
			graph: { collection: 'notes', action: 'update', inputs: [{ body: 'edited', id: 'n1' }] },
			baseVersions: [{ row: { collection: 'notes', recordId: 'n1' }, rowVersion: 3 }]
		});
	});
	it('sends compact approval decisions without echoing the review snapshot', async () => {
		const commands: Array<{ readonly command: string; readonly input: unknown }> = [];
		const bolt = createBoltClient(scope, {
			command: async (command, input) => {
				commands.push({ command, input });
				return null;
			}
		});
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt));
		await proxy.approvals.process({ approvalRequestId: 'request-1', action: 'APPROVED' });
		await proxy.approvals.withdraw('request-2');
		expect(commands).toEqual([
			{
				command: 'approvals.decide',
				input: { state: { requestId: 'request-1' }, decision: 'approve' }
			},
			{ command: 'approvals.withdraw', input: { state: { requestId: 'request-2' } } }
		]);
	});
	it('settles the automation UI from the actual automation_run projection', async () => {
		const sync = fakeSyncClient();
		const bolt = createBoltClient(scope, {
			command: async () => ({ taskId: 'review-1', result: null })
		});
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt, sync.client));
		const automation = Reflect.get(
			proxy.automations,
			'review'
		) as ErasedAutomationClientApi[string];
		const run = await automation.run({});
		const row = {
			id: 'run-1',
			task_id: 'review-1',
			name: 'review',
			status: 'running',
			progress: { progress: 0.5, text: 'Reviewing' },
			progress_sequence: 1,
			progress_updated_at: '2026-09-05T00:00:00Z',
			error: null,
			result: null
		};
		sync.client.publish(sync.mounted[0]?.key ?? '', [row]);
		expect(run.current?.status).toBe('running');
		expect(automation.pending).toBe(1);
		sync.client.publish(sync.mounted[0]?.key ?? '', [
			{ ...row, status: 'done', result: { checked: 4 } }
		]);
		expect(run.current?.result).toEqual({ checked: 4 });
		expect(automation.pending).toBe(0);
		sync.client.publish(sync.mounted[0]?.key ?? '', [{ ...row, status: 'stopped' }]);
		expect(run.current?.status).toBe('stopped');
		expect(automation.pending).toBe(0);
	});

	it('retains identity and whole-row versions for projected records and nested edits', async () => {
		const sync = fakeSyncClient();
		const bolt = createBoltClient(scope, { command: async () => null });
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt, sync.client), {
			orders: {
				name: 'orders',
				fields: [],
				relationships: [{ name: 'lines', target: 'order_lines', cardinality: 'many' }],
				write: writable
			},
			order_lines: { name: 'order_lines', fields: [], relationships: [] }
		});
		const orders = Reflect.get(proxy.db, 'orders') as {
			findMany: (input: Schema.Json) => unknown;
			findFirst: (input: Schema.Json) => unknown;
		};
		orders.findMany({ columns: { reference: true }, with: { lines: { columns: { sku: true } } } });
		expect(sync.mounted[0]?.input).toMatchObject({
			columns: { reference: true, id: true, row_version: true },
			with: { lines: { columns: { sku: true, id: true, row_version: true } } }
		});
		sync.client.publish(sync.mounted[0]?.key ?? '', [
			{
				id: 'order-1',
				reference: 'A',
				row_version: 3,
				lines: [{ id: 'line-1', sku: 'OLD', row_version: 9 }]
			}
		]);
		await writesOf(proxy, 'orders').update('order-1', { lines: [{ id: 'line-1', sku: 'NEW' }] });
		expect(sync.enqueued[0]?.graph.inputs).toEqual([
			{ id: 'order-1', lines: { update: [{ id: 'line-1', set: { sku: 'NEW' } }] } }
		]);
		expect(sync.enqueued[0]?.baseVersions).toEqual([
			{ row: { collection: 'orders', recordId: 'order-1' }, rowVersion: 3 },
			{ row: { collection: 'order_lines', recordId: 'line-1' }, rowVersion: 9 }
		]);
		orders.findFirst({ columns: { secret: false, id: false, row_version: false } });
		expect(sync.mounted[1]?.input).toMatchObject({ columns: { secret: false } });
	});

	it('preserves actionable transport failures at the command boundary', async () => {
		const failure = new Error('invalid_input: employees.created_at is managed by Bolt');
		const bolt = createBoltClient(scope, { command: () => Promise.reject(failure) });

		await expect(bolt.command('collections.write', {}, Schema.Json)).rejects.toBe(failure);
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
			employees: { name: 'employees', fields: [], relationships: [], write: writable }
		});
		const employees = Reflect.get(proxy.db, 'employees') as {
			findMany: () => { readonly current: unknown };
		};
		employees.findMany();
		sync.client.publish(sync.mounted[0]?.key ?? '', [
			{ id: 'employee-1', name: 'Ada', row_version: 7 }
		]);

		const writes = writesOf(proxy, 'employees');
		expect(await writes.update('employee-1', { name: 'Grace' })).toMatchObject({
			row: { id: 'employee-1', name: 'Grace' }
		});
		await writes.create({ name: 'Lin' });

		expect(sync.enqueued).toHaveLength(2);
		expect(sync.enqueued[0]).toMatchObject({
			protocolVersion: 2,
			partitionKey: 'test-partition',
			schemaFingerprint: 'sha256:test',
			graph: {
				action: 'update',
				collection: 'employees',
				inputs: [{ id: 'employee-1', name: 'Grace' }]
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
			graph: { action: 'create', collection: 'employees', inputs: [{ name: 'Lin' }] },
			baseVersions: []
		});
	});

	it('enqueues one delete request with ids, never a single-id graph', async () => {
		const sync = fakeSyncClient();
		const bolt = createBoltClient(scope, { command: async () => null });
		const runtime = runtimeOf(bolt, sync.client);
		const proxy = createWorkspaceApiProxy(runtime, {
			employees: { name: 'employees', fields: [], relationships: [], write: writable }
		});
		const employees = Reflect.get(proxy.db, 'employees') as {
			findMany: () => { readonly current: unknown };
		};
		employees.findMany();
		sync.client.publish(sync.mounted[0]?.key ?? '', [
			{ id: 'employee-1', name: 'Ada', row_version: 7 },
			{ id: 'employee-2', name: 'Lin', row_version: 3 }
		]);

		expect(
			await writesOf(proxy, 'employees').deleteMany(['employee-1', 'employee-2'])
		).toMatchObject({ row: null });

		expect(sync.enqueued).toHaveLength(1);
		expect(sync.enqueued[0]).toMatchObject({
			protocolVersion: 2,
			partitionKey: 'test-partition',
			schemaFingerprint: 'sha256:test',
			graph: {
				action: 'delete',
				collection: 'employees',
				inputs: [{ id: 'employee-1' }, { id: 'employee-2' }]
			},
			baseVersions: [
				{ row: { collection: 'employees', recordId: 'employee-1' }, rowVersion: 7 },
				{ row: { collection: 'employees', recordId: 'employee-2' }, rowVersion: 3 }
			]
		});
		expect(sync.enqueued[0]?.graph).not.toHaveProperty('id');
	});

	it('diffs a relation matrix against the loaded children into explicit actions', async () => {
		const sync = fakeSyncClient();
		const bolt = createBoltClient(scope, { command: async () => null });
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt, sync.client), {
			orders: {
				name: 'orders',
				fields: [],
				relationships: [
					{ name: 'lines', target: 'order_lines', cardinality: 'many' },
					{ name: 'notes', target: 'order_notes', cardinality: 'many' }
				],
				write: writable
			},
			order_lines: { name: 'order_lines', fields: [], relationships: [] }
		});
		const orders = Reflect.get(proxy.db, 'orders') as { findMany: () => unknown };
		orders.findMany();
		sync.client.publish(sync.mounted[0]?.key ?? '', [
			{
				id: 'order-1',
				reference: 'A',
				row_version: 3,
				lines: [
					{ id: 'line-1', sku: 'OLD', row_version: '9' },
					{ id: 'line-2', sku: 'GONE', row_version: 4 }
				]
			}
		]);

		const writes = writesOf(proxy, 'orders');
		await writes.update('order-1', {
			reference: 'B',
			lines: [{ id: 'line-1', sku: 'NEW' }, { sku: 'NEW-ROW' }]
		});
		expect(sync.enqueued[0]?.graph.inputs).toEqual([
			{
				id: 'order-1',
				reference: 'B',
				lines: {
					create: [{ sku: 'NEW-ROW' }],
					update: [{ id: 'line-1', set: { sku: 'NEW' } }],
					delete: [{ id: 'line-2' }]
				}
			}
		]);
		expect(sync.enqueued[0]?.baseVersions).toEqual([
			{ row: { collection: 'orders', recordId: 'order-1' }, rowVersion: 3 },
			{ row: { collection: 'order_lines', recordId: 'line-1' }, rowVersion: 9 },
			{ row: { collection: 'order_lines', recordId: 'line-2' }, rowVersion: 4 }
		]);

		// Children this tab never loaded cannot be deleted by their absence; an actions object and
		// a non-relation key pass through untouched.
		await writes.update('order-2', {
			lines: [{ id: 'line-9', sku: 'X' }],
			tags: ['a'],
			notes: { create: [{ body: 'n' }] }
		});
		expect(sync.enqueued[1]?.graph.inputs).toEqual([
			{
				id: 'order-2',
				lines: { update: [{ id: 'line-9', set: { sku: 'X' } }] },
				tags: ['a'],
				notes: { create: [{ body: 'n' }] }
			}
		]);
		await writes.create({ reference: 'C', lines: [{ sku: 'FIRST' }] });
		expect(sync.enqueued[2]?.graph.inputs).toEqual([
			{ reference: 'C', lines: { create: [{ sku: 'FIRST' }] } }
		]);
	});

	it('passes a history anchor through the record history command', async () => {
		const commands: Array<{ readonly command: string; readonly input: unknown }> = [];
		const bolt = createBoltClient(scope, {
			command: (command, input) => {
				commands.push({ command, input });
				return Promise.resolve([]);
			}
		});
		const proxy = createWorkspaceApiProxy(runtimeOf(bolt));
		const history = Reflect.get(proxy.collection_history, 'notes') as {
			revisions: (id: string) => PromiseLike<unknown>;
			at: (id: string, anchor: object) => PromiseLike<unknown>;
		};
		await expect(history.at('n1', { revision: 2 })).resolves.toBeUndefined();
		await expect(history.revisions('n1')).resolves.toEqual([]);
		expect(commands).toEqual([
			{
				command: 'collections.history',
				input: { collection: 'notes', id: 'n1', at: { revision: 2 } }
			},
			{ command: 'collections.history', input: { collection: 'notes', id: 'n1' } }
		]);
	});

	it('seals private platform collections out of the authored browser proxy', () => {
		const bolt = createBoltClient(scope, { command: async () => null });
		const proxy = createWorkspaceApiProxy(
			runtimeOf(bolt),
			{
				employees: { name: 'employees', fields: [], relationships: [], write: writable },
				approval_request: {
					name: 'approval_request',
					fields: [],
					relationships: [],
					write: writable
				},
				user: { name: 'user', fields: [], relationships: [], write: writable }
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
		expect(Reflect.get(proxy.collection_history, 'conversation')).toBeUndefined();
		expect(Reflect.get(proxy.db, 'employees')).toBeDefined();
		expect(Reflect.get(proxy.collection, 'employees')).toBeDefined();
		const approval = Reflect.get(proxy.db, 'approval_request');
		expect(approval).toBeDefined();
		if (approval === null || typeof approval !== 'object')
			throw new Error('approval_request did not resolve to a collection surface');
		expect(Reflect.get(approval, 'findMany')).toBeTypeOf('function');
		// Published read-only: the catalog's write contract does not reach the browser surface.
		expect(Reflect.get(proxy.collection, 'approval_request')).toBeUndefined();
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
			{
				command: 'approvals.decide',
				input: {
					state: { requestId: 'request-1' },
					decision: 'request_changes',
					reason: 'Attach the supporting document.'
				}
			}
		]);
	});
});
