import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { collection, field, workspace } from '../src/authoring/workspace-schema.js';
import { buildSchemaPlan } from '../src/runtime/schema/schema-plan.js';
import { SYSTEM_MODELS } from '../src/authoring/system-models.js';
import * as WorkspaceSchema from '../src/runtime/schema/workspace-schema.js';
import {
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

describe('WorkspaceSchema owner', () => {
	it('orders its steps deterministically and renders nothing for an authored collection', () => {
		const definition = workspace({
			name: 'x',
			version: '1',
			collections: [
				collection({ name: 'z records', fields: { active: field.boolean() } }),
				collection({ name: 'a', fields: {} })
			],
			apps: [],
			policies: [],
			automations: [],
			envoys: [],
			integrations: [],
			prompt: 'You are the test workspace agent.',
			tools: [],
			skills: [],
			requiredFacilities: []
		});
		const plan = buildSchemaPlan(definition);
		const collectionSteps = plan.steps
			.filter(({ id }) => id.startsWith('collection:'))
			.map(({ id }) => id);
		const tables = collectionSteps.filter((id) => id.split(':').length === 2);
		expect(tables).toEqual(
			Object.keys(SYSTEM_MODELS)
				.map((name) => `collection:${name}`)
				.toSorted()
		);
		// Authored collections reach the plan only if they declare something Drizzle cannot render.
		expect(collectionSteps.some((id) => id.includes('z records'))).toBe(false);
		expect(plan.steps.map(({ id }) => id)).toEqual(
			[...plan.steps.map(({ id }) => id)].toSorted((left, right) => left.localeCompare(right))
		);
	});

	it('verifies a database the plan has just provisioned', async () => {
		const harness = await makeBoltTestRuntime();
		try {
			const divergences = await harness.runtime.runPromise(
				Effect.flatMap(WorkspaceSchema.Service, (schema) =>
					schema.verify(harness.effectId('verify'))
				)
			);
			expect(divergences).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it('verifies polymorphic references against their physical storage columns', async () => {
		const harness = await makeBoltTestRuntime(
			testWorkspace({
				collections: [
					{
						name: 'payslip_sources',
						fields: {
							source: {
								type: 'reference',
								required: true,
								indexed: false,
								reference: {
									onDelete: 'restrict',
									targets: [
										{
											tag: 'TIME_ENTRY',
											collection: 'time_entries',
											storageColumn: 'source__time_entry_id'
										},
										{
											tag: 'LEAVE_REQUEST',
											collection: 'leave_requests',
											storageColumn: 'source__leave_request_id'
										}
									]
								}
							}
						}
					}
				]
			})
		);
		try {
			expect(
				await harness.runtime.runPromise(
					Effect.flatMap(WorkspaceSchema.Service, (schema) =>
						schema.verify(harness.effectId('verify'))
					)
				)
			).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it('raises retryable SQLSTATE 40001 when a snapshot assertion fails', async () => {
		const harness = await makeBoltTestRuntime();
		try {
			await expect(
				harness.database.query("select bolt_assert(true, 'unchanged')")
			).resolves.toHaveLength(1);
			await expect(
				harness.database.query("select bolt_assert(false, 'mutation snapshot changed')")
			).rejects.toMatchObject({ code: '40001', message: 'mutation snapshot changed' });
		} finally {
			await harness.dispose();
		}
	});

	/**
	 * The defect this command exists to catch, and could not: the plan is `create table if not exists`
	 * throughout, so a table that already exists in an older shape is skipped in silence. Verifying the
	 * fingerprint `migrate` had itself just written reported that database as green.
	 */
	it('names a column the plan cannot restore, and refuses to report the migration as applied', async () => {
		const harness = await makeBoltTestRuntime(
			testWorkspace({
				collections: [
					{
						name: 'people',
						fields: { name: field.string({ required: true }), team: field.string() }
					}
				]
			})
		);
		try {
			await harness.database.query('alter table "people" drop column "team"');
			await harness.database.query('alter table "people" add column "stray_id" text');

			const divergences = await harness.runtime.runPromise(
				Effect.flatMap(WorkspaceSchema.Service, (schema) =>
					schema.verify(harness.effectId('verify'))
				)
			);
			expect(divergences).toEqual([
				'people: missing column team',
				'people: unexpected column stray_id'
			]);

			const failure = await harness.runtime.runPromise(
				Effect.flip(
					Effect.flatMap(WorkspaceSchema.Service, (schema) =>
						schema.migrate(harness.effectId('migrate'))
					)
				)
			);
			expect(failure.message).toContain('people: missing column team');
			expect(failure.message).toContain('people: unexpected column stray_id');
		} finally {
			await harness.dispose();
		}
	});

	/**
	 * The lineage applier.
	 *
	 * `bolt migrate` has always written `.norbital/migrations/<tag>/migration.sql`, and until now no
	 * code path in the realm read one back: `sync` embedded `.norbital/dist` and `assets` and nothing
	 * else, so a promoted artifact could not carry its own schema history and every `ALTER TABLE` the
	 * lineage held stayed on the authoring machine. These cover the four properties that make applying
	 * one safe — once, in order, transactionally, and stopping rather than skipping ahead.
	 *
	 * The entries write into a probe table of their own rather than altering `people`, because the
	 * subject here is the applier and not the DDL: a lineage that changed a declared collection would
	 * have `verify` failing the migration for reasons that say nothing about ordering or the ledger.
	 */
	const probeWorkspace = (
		migrations: ReadonlyArray<{ readonly tag: string; readonly statements: ReadonlyArray<string> }>
	) => testWorkspace({ migrations });
	const probeSteps = async (harness: BoltTestRuntime): Promise<ReadonlyArray<unknown>> =>
		(await harness.database.query('select step from migration_probe order by sequence')).map(
			(row) => row['step']
		);
	/**
	 * The lineage entries this test wrote, without the harness's own baseline.
	 *
	 * The harness provisions collection tables from a generated baseline entry and records it, because
	 * that is the state a provisioned tenant is in. It is setup, not subject: these assertions are
	 * about the applier's ordering and exactly-once behaviour.
	 */
	const ledgerTags = async (harness: BoltTestRuntime): Promise<ReadonlyArray<unknown>> =>
		(await harness.database.query('select tag from __drizzle_migrations order by tag'))
			.map((row) => row['tag'])
			.filter((tag) => tag !== '00000000000000_baseline');
	const createProbe =
		'create table migration_probe (sequence bigint generated always as identity primary key, step text not null)';

	it('applies a pending lineage entry once, and leaves it alone on the next migrate', async () => {
		const harness = await makeBoltTestRuntime(
			probeWorkspace([
				{
					tag: '20260101000000_probe',
					statements: [createProbe, "insert into migration_probe (step) values ('first')"]
				}
			])
		);
		try {
			const migrate = Effect.flatMap(WorkspaceSchema.Service, (schema) =>
				schema.migrate(harness.effectId('migrate'))
			);
			await harness.runtime.runPromise(migrate);
			expect(await probeSteps(harness)).toEqual(['first']);
			expect(await ledgerTags(harness)).toEqual(['20260101000000_probe']);

			// A second boot is the ordinary case, not an edge one: every restart runs `schema.migrate`.
			// Re-running `create table migration_probe` would fail outright, so a green second pass is
			// itself evidence the ledger was read rather than the entry replayed.
			await harness.runtime.runPromise(migrate);
			expect(await probeSteps(harness)).toEqual(['first']);
			expect(await ledgerTags(harness)).toEqual(['20260101000000_probe']);
		} finally {
			await harness.dispose();
		}
	});

	/**
	 * Order is the whole meaning of a lineage: entry N+1 is a diff against the shape N leaves behind.
	 * The entries are handed over deliberately out of order so a run that merely iterates the array
	 * cannot pass.
	 */
	it('applies lineage entries oldest first, whatever order they arrive in', async () => {
		const harness = await makeBoltTestRuntime(
			probeWorkspace([
				{
					tag: '20260103000000_third',
					statements: ["insert into migration_probe (step) values ('third')"]
				},
				{
					tag: '20260101000000_first',
					statements: [createProbe, "insert into migration_probe (step) values ('first')"]
				},
				{
					tag: '20260102000000_second',
					statements: ["insert into migration_probe (step) values ('second')"]
				}
			])
		);
		try {
			await harness.runtime.runPromise(
				Effect.flatMap(WorkspaceSchema.Service, (schema) =>
					schema.migrate(harness.effectId('migrate'))
				)
			);
			expect(await probeSteps(harness)).toEqual(['first', 'second', 'third']);
			expect(await ledgerTags(harness)).toEqual([
				'20260101000000_first',
				'20260102000000_second',
				'20260103000000_third'
			]);
		} finally {
			await harness.dispose();
		}
	});

	/**
	 * The failure that matters most. A migration half-applied and recorded as done is unrecoverable by
	 * anything except hand-written SQL, and an entry skipped so a later one can run leaves a database
	 * in a shape no snapshot describes.
	 */
	it('rolls a failing entry back, does not record it, and does not run the entries after it', async () => {
		const harness = await makeBoltTestRuntime(
			probeWorkspace([
				{
					tag: '20260101000000_first',
					statements: [createProbe, "insert into migration_probe (step) values ('first')"]
				},
				{
					tag: '20260102000000_broken',
					statements: [
						"insert into migration_probe (step) values ('should not survive')",
						'alter table "no_such_table" add column "x" text'
					]
				},
				{
					tag: '20260103000000_third',
					statements: ["insert into migration_probe (step) values ('third')"]
				}
			])
		);
		try {
			const failure = await harness.runtime.runPromise(
				Effect.flip(
					Effect.flatMap(WorkspaceSchema.Service, (schema) =>
						schema.migrate(harness.effectId('migrate'))
					)
				)
			);
			expect(failure.message).toContain('no_such_table');
			// The good half of the broken entry is gone with it, and `third` never ran.
			expect(await probeSteps(harness)).toEqual(['first']);
			expect(await ledgerTags(harness)).toEqual(['20260101000000_first']);
		} finally {
			await harness.dispose();
		}
	});

	/**
	 * A virgin database now provisions *from the lineage*, because the plan no longer renders
	 * collection tables at all.
	 *
	 * This is the inverse of what it used to do. The plan built every table, so the lineage was
	 * recorded as reached without being run — replaying entries describing how earlier shapes became
	 * this one would have failed on the first `CREATE TABLE`. With one generator there is nothing to
	 * skip: the lineage is the schema, and on an empty database it is the only thing that creates it.
	 */
	it('runs the lineage on a virgin database rather than recording it as already reached', async () => {
		const harness = await makeBoltTestRuntime();
		try {
			// Back to the state a first boot against an empty Neon database is actually in.
			await harness.database.query('drop table "people"');
			await harness.database.query('drop table "approval_request"');
			await harness.database.query('drop table "requestor"');
			await harness.database.query('drop table if exists bolt_schema_state');
			await harness.database.query('drop table if exists __drizzle_migrations');

			await harness.runtime.runPromise(
				Effect.flatMap(WorkspaceSchema.Service, (schema) =>
					schema.migrate(harness.effectId('migrate'))
				)
			);
			// The table is back, and it is back because the lineage ran.
			expect(await harness.database.query('select id from people')).toEqual([]);
			expect(
				await harness.runtime.runPromise(
					Effect.flatMap(WorkspaceSchema.Service, (schema) =>
						schema.verify(harness.effectId('verify'))
					)
				)
			).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	/**
	 * A first lineage may fail after the plan's foundation commits but before its CREATE TABLE
	 * transaction does. That leaves a fingerprint and Bolt-owned tables, but no authored table and no
	 * lineage tag. It is a retryable partial provision, not an old plan-provisioned database to baseline.
	 */
	it('retries the lineage when a prior attempt left only the plan foundation', async () => {
		const harness = await makeBoltTestRuntime();
		try {
			await harness.database.query('drop table "people"');
			await harness.database.query('drop table if exists __drizzle_migrations');
			await harness.database.query(
				'create table __drizzle_migrations (id serial primary key, tag text not null unique, created_at timestamptz not null default now())'
			);
			await harness.database.query(
				"insert into bolt_schema_state (fingerprint) values ('partial')"
			);

			await harness.runtime.runPromise(
				Effect.flatMap(WorkspaceSchema.Service, (schema) =>
					schema.migrate(harness.effectId('migrate'))
				)
			);

			expect(await harness.database.query('select id from people')).toEqual([]);
			expect(
				await harness.runtime.runPromise(
					Effect.flatMap(WorkspaceSchema.Service, (schema) =>
						schema.verify(harness.effectId('verify'))
					)
				)
			).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	/**
	 * A dropped table is now named and refused, not silently recreated.
	 *
	 * The plan's `create table if not exists` used to run on every migrate, so a table dropped out from
	 * under the workspace quietly reappeared — empty, and indistinguishable from one that had always
	 * been there. That is drift repair by coincidence: the same statement equally silently accepted a
	 * table whose columns no longer matched, which is how a collection without `sys_period`
	 * survived a green verify. A forward-only lineage cannot re-create a table it has already been
	 * recorded as having created, and `verify` is the arbiter that says so out loud.
	 */
	it('names a collection whose table is missing and refuses to migrate around it', async () => {
		const harness = await makeBoltTestRuntime();
		try {
			await harness.database.query('drop table "people"');
			const before = await harness.runtime.runPromise(
				Effect.flatMap(WorkspaceSchema.Service, (schema) =>
					schema.verify(harness.effectId('verify-before'))
				)
			);
			expect(before).toEqual(['people: table is missing']);

			const outcome = await harness.runtime.runPromise(
				Effect.flatMap(WorkspaceSchema.Service, (schema) =>
					schema.migrate(harness.effectId('migrate'))
				).pipe(Effect.result)
			);
			expect(outcome._tag).toBe('Failure');
		} finally {
			await harness.dispose();
		}
	});
});
