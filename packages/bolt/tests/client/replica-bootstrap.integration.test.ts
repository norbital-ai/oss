import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect, type Schema } from 'effect';
import { PGlite } from '@electric-sql/pglite';
import { openLocalDatabase, type BootstrapTransport } from '../../src/client/replica/bootstrap.js';
import { adaptPGlite } from '../../src/client/replica/pglite-loader.js';
import {
	readDurableReplicaSchema,
	readReplicaState
} from '../../src/client/replica/pglite-sql.js';

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
		id: 'collection:jobs',
		sql: `create table jobs (
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

const PROVISIONING: Schema.Json = {
	steps: REPLICA_STEPS,
	fingerprint: 'window-base-v1',
	collections: [
		{
			name: 'jobs',
			fields: { title: { type: 'string', required: false, indexed: false } },
			readableFields: null
		}
	],
	relations: []
};

const databases: Array<PGlite> = [];
afterEach(async () => {
	for (const database of databases.splice(0)) if (!database.closed) await database.close();
});
vi.setConfig({ testTimeout: 30_000 });

const transport = () => {
	const commands: Array<string> = [];
	const value: BootstrapTransport = {
		command: (command) =>
			Effect.sync((): Schema.Json => {
				commands.push(command);
				if (command === 'sync.provisioning') return PROVISIONING;
				if (command === 'sync.shape') return ['jobs'];
				throw new Error(`Unexpected bootstrap command ${command}`);
			})
	};
	return { value, commands };
};

describe('base/window replica bootstrap', () => {
	it('provisions the single base/window ledger without collection snapshots', async () => {
		const database = await PGlite.create('memory://');
		databases.push(database);
		const scripted = transport();
		const replica = await Effect.runPromise(
			openLocalDatabase(scripted.value, () => Effect.succeed(adaptPGlite(database)))
		);

		expect(replica.rows).toBe(0);
		expect(replica.resumed).toBe(false);
		expect(scripted.commands).toEqual(['sync.provisioning', 'sync.shape']);
		expect(await database.query('select * from jobs')).toMatchObject({ rows: [] });
		expect(await Effect.runPromise(readReplicaState(adaptPGlite(database)))).toMatchObject({
			fingerprint: 'window-base-v1',
			cursor: { xid: 0, sequence: 0 }
		});
		expect(await Effect.runPromise(readDurableReplicaSchema(adaptPGlite(database)))).toMatchObject({
			authorityGeneration: 0,
			fingerprint: 'window-base-v1'
		});
		expect(
			await database.query(
				`select tablename from pg_tables
				 where schemaname = 'public'
				 and tablename in (
					'bolt_replica_base_row',
					'bolt_replica_window',
					'bolt_replica_window_row',
					'bolt_replica_window_relationship',
					'bolt_replica_position'
				 ) order by tablename`
			)
		).toMatchObject({
			rows: [
				{ tablename: 'bolt_replica_base_row' },
				{ tablename: 'bolt_replica_position' },
				{ tablename: 'bolt_replica_window' },
				{ tablename: 'bolt_replica_window_relationship' },
				{ tablename: 'bolt_replica_window_row' }
			]
		});
	});

	it('resumes a stamped base/window database without rebuilding or scanning it', async () => {
		const database = await PGlite.create('memory://');
		databases.push(database);
		const first = transport();
		await Effect.runPromise(
			openLocalDatabase(first.value, () => Effect.succeed(adaptPGlite(database)))
		);
		const second = transport();
		const resumed = await Effect.runPromise(
			openLocalDatabase(second.value, () => Effect.succeed(adaptPGlite(database)))
		);
		expect(resumed.resumed).toBe(true);
		expect(second.commands).toEqual(['sync.provisioning', 'sync.shape']);
	});

});
