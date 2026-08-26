import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect, type Schema } from 'effect';
import { PGlite } from '@electric-sql/pglite';
import {
	createBrowserWorkspaceRuntime,
	createWorkspaceApiProxy,
	startLocalReplica,
	type CollectionPageQuery,
	type LocalReplica
} from '../../src/client/runtime.js';
import { adaptPGlite } from '../../src/client/replica/pglite-loader.js';
import type { PGliteLike } from '../../src/client/replica/pglite-sql.js';
import {
	openReplicaInvalidationBus,
	type ReplicaInvalidationChannel
} from '../../src/client/replica/cross-tab-invalidation.js';
import type { BoltTransport } from '../../src/client.js';
import { setWorkspaceSession } from '#lib/client/session.js';

const REPLICA_STEPS = [
	{
		id: 'bolt:schema-state',
		sql: `create table bolt_schema_state (
			id uuid not null default '00000000-0000-0000-0000-000000000001',
			created_at timestamptz not null default current_timestamp,
			updated_at timestamptz not null default current_timestamp,
			sys_period tstzrange not null default tstzrange(current_timestamp, null, '[)'),
			row_version integer not null default 1,
			approval_id uuid,
			fingerprint text not null,
			applied_at timestamptz not null default current_timestamp
		)`
	},
	{
		id: 'bolt:sync-horizon',
		sql: `create table bolt_sync_horizon (
			id uuid not null default '00000000-0000-0000-0000-000000000002',
			created_at timestamptz not null default current_timestamp,
			updated_at timestamptz not null default current_timestamp,
			sys_period tstzrange not null default tstzrange(current_timestamp, null, '[)'),
			row_version integer not null default 1,
			approval_id uuid,
			singleton boolean primary key,
			xid bigint not null default 0,
			sequence bigint not null default 0
		)`
	},
	{
		id: 'collection:job-assignments',
		sql: `create table job_assignments (
			id uuid primary key,
			created_at timestamptz not null default current_timestamp,
			updated_at timestamptz not null default current_timestamp,
			sys_period tstzrange not null default tstzrange(current_timestamp, null, '[)'),
			row_version integer not null default 1,
			approval_id uuid,
			title text
		)`
	}
];

const opened: Array<PGlite> = [];
const replicas: Array<LocalReplica> = [];

beforeEach(() => {
	setWorkspaceSession({
		tenantId: 'cross-tab-test',
		environment: 'development',
		releaseId: 'local',
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

afterEach(async () => {
	for (const replica of replicas.splice(0)) replica.stop();
	await new Promise((resolve) => setTimeout(resolve, 50));
	for (const database of opened.splice(0)) if (!database.closed) await database.close();
});

describe('cross-tab replica invalidation', () => {
	it('falls back to full invalidation for malformed messages and releases its channel', () => {
		let channelName = '';
		let closed = 0;
		const channel: ReplicaInvalidationChannel = {
			postMessage: () => undefined,
			close: () => {
				closed += 1;
			},
			onmessage: null
		};
		const invalidated: Array<ReadonlyArray<string>> = [];
		const bus = openReplicaInvalidationBus(
			'tenant::development::team:controller',
			(collections) => invalidated.push(collections),
			(name) => {
				channelName = name;
				return channel;
			}
		);

		expect(channelName).toBe('bolt-replica-changed:tenant::development::team:controller');
		channel.onmessage?.({ data: { not: 'a valid message' } });
		expect(invalidated).toEqual([['*']]);

		bus.close();
		expect(channel.onmessage).toBeNull();
		expect(closed).toBe(1);
	});

	it('does not fail replica startup when the browser refuses the channel', () => {
		const bus = openReplicaInvalidationBus(
			'tenant::development::operator',
			() => undefined,
			() => {
				throw new Error('BroadcastChannel is blocked');
			}
		);
		expect(() => bus.announce(['job_assignments'])).not.toThrow();
		expect(() => bus.close()).not.toThrow();
	});

	it('updates a follower runtime after the leader applies a shared change', async () => {
		const streams: Array<{ readonly emit: (type: string, data?: string) => void }> = [];
		class SyncEventSource {
			onerror: ((event: unknown) => void) | null = null;
			readonly #listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

			constructor(_url: string, _options?: EventSourceInit) {
				streams.push(this);
			}

			addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
				const listeners = this.#listeners.get(type) ?? [];
				listeners.push(listener);
				this.#listeners.set(type, listeners);
			}

			close(): void {
				this.#listeners.clear();
			}

			emit(type: string, data = ''): void {
				for (const listener of this.#listeners.get(type) ?? []) {
					listener(new MessageEvent(type, { data }));
				}
			}
		}
		vi.stubGlobal('EventSource', SyncEventSource);

		let version = 0;
		let title = 'Original title';
		let collectionReads = 0;
		const commands: Array<string> = [];
		const transport: BoltTransport = {
			command: async (command, input): Promise<Schema.Json> => {
				commands.push(command);
				switch (command) {
					case 'sync.provisioning':
						return {
							steps: REPLICA_STEPS,
							fingerprint: 'cross-tab-v1',
							collections: [
								{
									name: 'job_assignments',
									fields: { title: { type: 'string', required: false, indexed: false } },
									readableFields: null
								}
							],
							relations: []
						};
					case 'sync.shape':
						return ['job_assignments'];
					case 'sync.snapshot':
						return {
							rows: [
								{
									id: '019f7a10-2000-7000-8000-000000000001',
									title
								}
							],
							cursor: { xid: 0, sequence: 0 },
							nextAfter: null
						};
					case 'invoke.field_ops_dashboard':
						return { title };
					case 'collections.mutate': {
						const submitted = input as {
							readonly values?: { readonly title?: string };
						};
						if (submitted.values?.title !== undefined) title = submitted.values.title;
						version += 1;
						return null;
					}
					case 'collections.findMany':
						collectionReads += 1;
						return { rows: [{ title }], nextCursor: null };
					default:
						throw new Error(`Unexpected command ${command}`);
				}
			}
		};

		const database = await PGlite.create('memory://');
		opened.push(database);
		const engine = adaptPGlite(database);
		let opens = 0;
		const open = (leader: boolean) => () =>
			Effect.sync(() => {
				opens += 1;
				return Object.create(engine, {
					isLeader: { enumerable: true, get: () => leader }
				}) as PGliteLike;
			});

		const leaderRuntime = createBrowserWorkspaceRuntime({ transport });
		const followerRuntime = createBrowserWorkspaceRuntime({ transport });
		const leaderClient = createWorkspaceApiProxy(leaderRuntime);
		const leaderAssignments = leaderClient.db.job_assignments as
			| {
					readonly findMany: () => CollectionPageQuery<ReadonlyArray<Schema.Json>>;
					readonly mutate: (values: Schema.Json) => Promise<void>;
			  }
			| undefined;
		if (leaderAssignments === undefined) throw new Error('job assignment client was not generated');
		const leaderRows = leaderAssignments.findMany();
		expect(await leaderRows).toMatchObject([{ title: 'Original title' }]);
		expect(collectionReads).toBe(1);

		let catchUpApplied = false;
		let leaderSettled = false;
		const leaderStarting = startLocalReplica(leaderRuntime, open(true), {
			onChange: () => {
				catchUpApplied = true;
			}
		});
		void leaderStarting.then(() => {
			leaderSettled = true;
		});
		await vi.waitFor(() => expect(streams).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(leaderSettled).toBe(false);
		streams[0]?.emit(
			'sync',
			JSON.stringify([
				{
					cursor: { xid: 0, sequence: 1 },
					collection: 'job_assignments',
					recordId: '019f7a10-2000-7000-8000-000000000001',
					operation: 'update',
					record: { title: 'Caught up before ready' }
				}
			])
		);
		streams[0]?.emit('ready');
		const leaderReplica = await leaderStarting;
		expect(catchUpApplied).toBe(true);
		await expect
			.poll(() => leaderRows.current, { timeout: 2_000 })
			.toMatchObject([{ title: 'Caught up before ready' }]);
		// Neither the streamed invalidation nor the post-ready refresh falls through to the transport.
		expect(collectionReads).toBe(1);

		const followerReplica = await startLocalReplica(followerRuntime, open(false));
		replicas.push(leaderReplica, followerReplica);
		expect(opens).toBe(2);
		expect(leaderReplica.leader()).toBe(true);
		expect(followerReplica.leader()).toBe(false);

		const followerClient = createWorkspaceApiProxy(followerRuntime);
		const invokeDashboard = followerClient.invoke.field_ops_dashboard;
		if (invokeDashboard === undefined) throw new Error('dashboard invoke was not generated');
		const dashboard = invokeDashboard(null);
		expect(await dashboard).toEqual({ title: 'Original title' });
		const followerAssignments = followerClient.db.job_assignments as
			| {
					readonly findMany: () => CollectionPageQuery<ReadonlyArray<Schema.Json>>;
			  }
			| undefined;
		if (followerAssignments === undefined)
			throw new Error('job assignment query was not generated');
		const assignmentRows = followerAssignments.findMany();
		expect(await assignmentRows).toMatchObject([{ title: 'Caught up before ready' }]);
		expect(collectionReads).toBe(1);

		await leaderAssignments.mutate({
			id: '019f7a10-2000-7000-8000-000000000001',
			title: 'Updated in the other tab'
		});

		await expect
			.poll(() => dashboard.current, { timeout: 2_000 })
			.toEqual({ title: 'Updated in the other tab' });
		// The early message intentionally targets arbitrary remote queries only. A named collection read
		// may use the local replica, whose ordered change has not landed yet, so re-executing it here could
		// repaint and cache the old row.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(assignmentRows.current).toMatchObject([{ title: 'Caught up before ready' }]);
		expect(collectionReads).toBe(1);

		// Only the elected leader owns the sync stream. Its frame makes the ordered log catch up, then
		// the cross-tab invalidation makes the follower's mounted local query observe the applied row.
		expect(streams).toHaveLength(1);
		streams[0]?.emit(
			'sync',
			JSON.stringify([
				{
					cursor: { xid: 1, sequence: version },
					collection: 'job_assignments',
					recordId: '019f7a10-2000-7000-8000-000000000001',
					operation: 'update',
					record: { title }
				}
			])
		);
		await expect
			.poll(() => assignmentRows.current, { timeout: 2_000 })
			.toMatchObject([{ title: 'Updated in the other tab' }]);
		expect(commands).not.toContain('sync.diff');
		expect(commands).not.toContain('sync.head');
	});
});
