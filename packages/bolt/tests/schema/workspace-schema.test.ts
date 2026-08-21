import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { collection, field, workspace } from '../../src/authoring/index.js';
import { buildSchemaPlan } from '../../src/compiler/schema-plan.js';
import { WorkspaceSchema } from '../../src/runtime/schema/workspace-schema.js';
import {
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

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
		// Only Bolt's own collections remain: `a` and `z records` are authored, so their tables, columns
		// and indexes come from the drizzle lineage and the plan renders nothing for them. What is left
		// is what no workspace lineage can carry, and every index still sorts after the table it needs.
		expect(collectionSteps).toEqual([
			'collection:approval_request',
			'collection:approval_request:index:collection_name',
			'collection:approval_request:index:record_id',
			'collection:approval_request:index:status',
			// Identity is runtime-owned too, and for the same reason: it exists in every workspace,
			// including one that authors no collections, so no workspace lineage carries it.
			'collection:bolt_auth_account',
			'collection:bolt_auth_account:index:userId',
			'collection:bolt_auth_config',
			'collection:bolt_auth_config:index:key',
			'collection:bolt_auth_session',
			'collection:bolt_auth_session:index:token',
			'collection:bolt_auth_session:index:userId',
			'collection:bolt_auth_user',
			// Sorts between the table and its indexes, which is the whole reason its id is
			// `collection:…` rather than `bolt:…`: a `bolt:` prefix would sort ahead of the
			// `create table` and a fresh provision would fail on a relation that does not exist yet.
			'collection:bolt_auth_user:column:channels',
			'collection:bolt_auth_user:column:kind:drop',
			'collection:bolt_auth_user:index:email',
			'collection:bolt_auth_user:index:team_id',
			'collection:bolt_auth_user:index:tenantId',
			'collection:bolt_auth_verification',
			'collection:bolt_auth_verification:index:identifier',
			// A team is runtime-owned for the same reason identity is, and it is *part* of identity:
			// resolving a subject joins it, so a host that created the auth tables without this one
			// would authenticate nobody.
			'collection:bolt_team',
			'collection:bolt_team:column:inherits:drop',
			'collection:bolt_team:index:name',
			'collection:requestor',
			'collection:requestor:index:approval_request_id',
			'collection:requestor:index:user_id'
		]);
		// Authored collections reach the plan only if they declare something Drizzle cannot render.
		expect(collectionSteps.some((id) => id.includes('z records'))).toBe(false);
		expect(plan.steps.map(({ id }) => id)).toEqual([...plan.steps.map(({ id }) => id)].toSorted());
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
			await harness.database.query('alter table "people" add column "legacy_id" text');

			const divergences = await harness.runtime.runPromise(
				Effect.flatMap(WorkspaceSchema.Service, (schema) =>
					schema.verify(harness.effectId('verify'))
				)
			);
			expect(divergences).toEqual([
				'people: missing column team',
				'people: unexpected column legacy_id'
			]);

			const failure = await harness.runtime.runPromise(
				Effect.flip(
					Effect.flatMap(WorkspaceSchema.Service, (schema) =>
						schema.migrate(harness.effectId('migrate'))
					)
				)
			);
			expect(failure.message).toContain('people: missing column team');
			expect(failure.message).toContain('people: unexpected column legacy_id');
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
			expect(await harness.database.query('select norbital_id from people')).toEqual([]);
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
	 * Baselining survives for exactly one case, and it is no longer inferable from "has tables".
	 *
	 * A database the older plan provisioned has the tables and has never recorded a lineage tag.
	 * Running the lineage there fails on `CREATE TABLE "people"`; skipping the record leaves its
	 * position unknown, so the next authored entry queues behind entries that can never run. The
	 * discriminator is a plan fingerprint written by a previous migrate, which only such a database has.
	 */
	it('records without running when a previous plan provisioned the tables', async () => {
		const harness = await makeBoltTestRuntime(
			probeWorkspace([
				{ tag: '20260101000000_unreplayable', statements: ['create table "people" (x int)'] }
			])
		);
		try {
			// Tables present, ledger empty, and a fingerprint from a migrate that predates the lineage.
			await harness.database.query('drop table if exists __drizzle_migrations');
			await harness.database.query(
				'create table if not exists __drizzle_migrations (id serial primary key, tag text not null unique, created_at timestamptz not null default now())'
			);
			await harness.database.query("insert into bolt_schema_state (fingerprint) values ('legacy')");

			await harness.runtime.runPromise(
				Effect.flatMap(WorkspaceSchema.Service, (schema) =>
					schema.migrate(harness.effectId('migrate'))
				)
			);
			// Recorded, and not run: `people` still has its real columns rather than the entry's `x`.
			expect(await ledgerTags(harness)).toEqual(['20260101000000_unreplayable']);
			expect(await harness.database.query('select name from people')).toEqual([]);
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
	 * table whose columns no longer matched, which is how a collection without `norbital_sys_period`
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
