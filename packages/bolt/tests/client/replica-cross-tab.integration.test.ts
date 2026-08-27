import { afterEach, describe, expect, it } from 'vitest';
import { Effect, type Schema } from 'effect';
import { PGlite } from '@electric-sql/pglite';
import { openLocalDatabase, type BootstrapTransport } from '../../src/client/replica/bootstrap.js';
import {
	openReplicaInvalidationBus,
	type ReplicaInvalidationChannel,
	type ReplicaSchemaControl
} from '../../src/client/replica/cross-tab-invalidation.js';
import { adaptPGlite } from '../../src/client/replica/pglite-loader.js';
import type { PGliteLike } from '../../src/client/replica/pglite-sql.js';

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
afterEach(async () => {
	for (const database of opened.splice(0)) if (!database.closed) await database.close();
});

const channelPair = () => {
	const left: ReplicaInvalidationChannel = {
		postMessage: (message) => right.onmessage?.({ data: message }),
		close: () => undefined,
		onmessage: null
	};
	const right: ReplicaInvalidationChannel = {
		postMessage: (message) => left.onmessage?.({ data: message }),
		close: () => undefined,
		onmessage: null
	};
	return { left, right };
};

describe('cross-tab replica coordination', () => {
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

	it('propagates ephemeral schema maintenance separately from durable invalidation', () => {
		const pair = channelPair();
		const controls: Array<ReplicaSchemaControl> = [];
		const follower = openReplicaInvalidationBus(
			'partition',
			() => undefined,
			() => pair.right,
			(control) => controls.push(control)
		);
		const leader = openReplicaInvalidationBus('partition', () => undefined, () => pair.left);

		leader.announceMaintenance({ generation: 2, affectedCollections: ['jobs'] });
		leader.announceMaintenanceClear({ generation: 2 });
		expect(controls).toEqual([
			{
				_tag: 'maintenance',
				value: { generation: 2, affectedCollections: ['jobs'] }
			},
			{ _tag: 'maintenance-clear', value: { generation: 2 } }
		]);
		leader.close();
		follower.close();
	});

	it('lets only the database leader provision without rebuilding the namespace', async () => {
		const provisioning: Schema.Json = {
			steps: REPLICA_STEPS,
			fingerprint: 'cross-tab-provisioning-v1',
			collections: [
				{
					name: 'job_assignments',
					fields: { title: { type: 'string', required: false, indexed: false } },
					readableFields: null
				}
			],
			relations: []
		};
		const commands: Array<string> = [];
		const transport: BootstrapTransport = {
			command: (command) =>
				Effect.sync((): Schema.Json => {
					commands.push(command);
					if (command === 'sync.provisioning') return provisioning;
					if (command === 'sync.shape') return ['job_assignments'];
					throw new Error(`Unexpected command ${command}`);
				})
		};

		const database = await PGlite.create('memory://');
		opened.push(database);
		const base = adaptPGlite(database);
		const statements: Array<string> = [];
		const engineFor = (leader: boolean): PGliteLike => ({
			...base,
			exec: (sql) => {
				statements.push(sql);
				return base.exec(sql);
			},
			isLeader: leader
		});

		const [leader, follower] = await Promise.all([
			Effect.runPromise(openLocalDatabase(transport, () => Effect.succeed(engineFor(true)))),
			Effect.runPromise(openLocalDatabase(transport, () => Effect.succeed(engineFor(false))))
		]);
		expect(statements.filter((sql) => sql.includes('drop schema'))).toEqual([]);
		expect(statements.filter((sql) => sql.includes('create table job_assignments'))).toHaveLength(1);
		expect(leader.rows).toBe(0);
		expect(leader.resumed).toBe(false);
		expect(follower.resumed).toBe(true);
		expect(await Effect.runPromise(leader.store.recordIds('job_assignments'))).toEqual([]);
	});
});
