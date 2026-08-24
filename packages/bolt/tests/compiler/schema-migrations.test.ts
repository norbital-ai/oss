import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { sql } from 'drizzle-orm';
import type { AnyPgColumnBuilder } from 'drizzle-orm/pg-core';
import {
	bytea,
	defineModel,
	instant,
	integer,
	numeric,
	reference,
	text,
	uuid
} from '../../src/authoring/index.js';
import { collection, workspace } from '../../src/authoring/workspace-schema.js';
import { describeModelColumns } from '../../src/authoring/model-introspection.js';
import type { ModelDeclaration } from '../../src/authoring/models-schema.js';
import { buildSchemaPlan } from '../../src/compiler/schema-plan.js';
import {
	compileHostModelSchema,
	orderGeneratedColumnDependencies,
	planWorkspaceMigration,
	type WorkspaceSnapshot
} from '../../src/compiler/schema-migrations.js';

/**
 * Bolt's schema plan can only say `create table if not exists`, so anything removed from a model
 * stayed in the database forever. These fix the diffing half: that a removed column and a removed
 * collection both reach the DDL, and that an unchanged model produces no lineage entry at all — the
 * last being the one an additive planner can never get wrong and a differ can.
 */

const withColumn = (
	extra: Readonly<Record<string, AnyPgColumnBuilder>>
): Readonly<Record<string, ModelDeclaration>> => ({
	jurisdictions: defineModel(
		{ code: text(), name: text(), ordinary_rate_divisor: numeric(), ...extra },
		{ recordLabel: 'name' }
	)
});

const snapshotOf = async (
	models: Readonly<Record<string, ModelDeclaration>>
): Promise<WorkspaceSnapshot> => {
	const migration = await Effect.runPromise(
		planWorkspaceMigration({ models, relations: [], previous: undefined })
	);
	if (migration === undefined)
		throw new Error('a schema built from nothing must produce a migration');
	return migration.snapshot;
};

describe('host-owned model schema', () => {
	it('uses the same compiled system columns and Drizzle DDL as workspace models', async () => {
		const statements = await Effect.runPromise(
			compileHostModelSchema(
				'colony_control_store',
				defineModel({ key: text().notNull().unique(), value: bytea().notNull() })
			)
		);
		const ddl = statements.join('\n');
		expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "colony_control_store"');
		expect(ddl).toContain('"id" uuid PRIMARY KEY');
		expect(ddl).toContain('"updated_at" timestamp with time zone');
		expect(ddl).toContain('"key" text NOT NULL UNIQUE');
		expect(ddl).toContain('"value" bytea NOT NULL');
		expect(ddl).not.toContain('colony_control_store_key_idx');
	});
});

/**
 * The plan no longer renders workspace collection DDL at all, so the drift it used to be checked for
 * is not merely absent but unrepresentable.
 *
 * Two renderings of every table used to exist — `buildSchemaPlan`'s `create table if not exists` and
 * the lineage's `CREATE TABLE` — and they were free to disagree. They did, three times, always the
 * same root cause: the plan went through `ScalarType`, where `integer`, `numeric` and
 * `double precision` are all `number`. `component_entries.amount`, payroll money, was created as
 * binary floating point by the plan and `numeric` by the lineage; `uuid` collapsed to `text`; and a
 * column's DEFAULT was dropped entirely, which refused all 2756 roster rows. Whichever renderer ran
 * first won, and on a database provisioned from nothing that was always the plan. `verify` compares
 * column *names*, so nothing caught any of it.
 *
 * Guarding agreement between two generators was the wrong fix. There is now one generator, and this
 * pins that: the plan may create Bolt's own tables and the constraints Drizzle cannot express, and
 * nothing else.
 */
describe('schema plan scope', () => {
	const planStepIds = (collectionName: string): ReadonlyArray<string> => {
		const definition = workspace({
			name: 'money',
			version: '1',
			collections: [
				collection({
					name: collectionName,
					fields: describeModelColumns(
						defineModel(
							{
								amount: numeric(),
								sequence: integer(),
								effective_on: instant({ precision: 'day' }),
								note: text()
							},
							{ recordLabel: 'note' }
						).columns
					)
				})
			],
			apps: [],
			policies: [],
			automations: [],
			integrations: [],
			prompt: 'You are the test workspace agent.',
			tools: [],
			skills: [],
			envoys: [],
			requiredFacilities: []
		});
		return buildSchemaPlan(definition).steps.map(({ id }) => id);
	};

	it('renders no table, column or index for an authored collection', () => {
		const ids = planStepIds('component_entries');
		expect(ids).not.toContain('collection:component_entries');
		expect(ids.filter((id) => id.startsWith('collection:component_entries'))).toEqual([]);
	});

	it('still renders Bolt own system collections, which appear in no workspace lineage', () => {
		// They are `CollectionDefinition`s rather than Drizzle models, so the lineage cannot create them.
		expect(planStepIds('component_entries')).toContain('collection:approval_request');
	});

	it('still renders the foundation every lineage depends on', () => {
		const ids = planStepIds('component_entries');
		// The lineage calls `bolt_instant` in generated columns and indexes with `gin_trgm_ops`; both
		// come from here, and `bolt:` ids sort before `collection:` ids so they exist first.
		expect(ids.some((id) => id.startsWith('bolt:extension-'))).toBe(true);
		expect(ids).toContain('collection:bolt_sync_outbox');
	});
});

describe('Bolt Drizzle-driven schema migration', () => {
	it('refuses a model that redeclares a platform column', async () => {
		await expect(
			Effect.runPromise(
				planWorkspaceMigration({
					models: { invalid: defineModel({ id: text(), name: text() }) },
					relations: [],
					previous: undefined
				})
			)
		).rejects.toThrow('A model cannot redeclare platform columns: id');
	});

	it('drops a removed column', async () => {
		const previous = await snapshotOf(withColumn({ leave_year_start_month: numeric() }));
		const migration = await Effect.runPromise(
			planWorkspaceMigration({
				models: withColumn({}),
				relations: [],
				previous
			})
		);
		expect(migration?.statements).toEqual([
			'ALTER TABLE "jurisdictions" DROP COLUMN "leave_year_start_month";'
		]);
	});

	it('adds a new column', async () => {
		const previous = await snapshotOf(withColumn({}));
		const migration = await Effect.runPromise(
			planWorkspaceMigration({
				models: withColumn({ leave_year_start_month: numeric() }),
				relations: [],
				previous
			})
		);
		expect(migration?.statements).toEqual([
			'ALTER TABLE "jurisdictions" ADD COLUMN "leave_year_start_month" numeric;'
		]);
	});

	/**
	 * The previous snapshot used to be filtered to the tables the *current* models declare, so that a
	 * Pod-written lineage did not diff its platform tables into a `DROP TABLE` each. A collection
	 * removed from the workspace is also absent from the current models, so it was stripped from both
	 * sides of the diff and nothing was ever generated for it — `planWorkspaceMigration` returned
	 * `undefined` and the table stayed in the database forever.
	 */
	it('drops a collection removed from the workspace', async () => {
		const previous = await snapshotOf({
			jurisdictions: defineModel(
				{ code: text(), name: text(), ordinary_rate_divisor: numeric() },
				{ recordLabel: 'name' }
			),
			retired: defineModel({ name: text() }, { recordLabel: 'name' })
		});
		const migration = await Effect.runPromise(
			planWorkspaceMigration({
				models: withColumn({}),
				relations: [],
				previous
			})
		);
		expect(migration?.statements.join('\n')).toContain('DROP TABLE "retired"');
	});

	it('writes no migration when the models and the lineage already agree', async () => {
		const models = withColumn({ leave_year_start_month: numeric() });
		expect(
			await Effect.runPromise(
				planWorkspaceMigration({ models, relations: [], previous: await snapshotOf(models) })
			)
		).toBeUndefined();
	});

	/**
	 * A column the database computes is not a column anything writes, and `generatedAlwaysAs` inside a
	 * model previously broke migration outright. It has to survive into the DDL as a generated column
	 * rather than an ordinary one that every row would read as NULL.
	 */
	it('carries a generated column into the DDL as generated', async () => {
		const previous = await snapshotOf(withColumn({}));
		const migration = await Effect.runPromise(
			planWorkspaceMigration({
				models: withColumn({ label: text().generatedAlwaysAs(sql`upper("code")`) }),
				relations: [],
				previous
			})
		);
		expect(migration?.statements[0]).toContain('GENERATED ALWAYS AS');
		expect(migration?.statements[0]).toContain('STORED');
	});

	it('adds ordinary dependencies before a generated column declared ahead of them', async () => {
		const previous = await snapshotOf(withColumn({}));
		const migration = await Effect.runPromise(
			planWorkspaceMigration({
				models: withColumn({
					label: text()
						.notNull()
						.generatedAlwaysAs(sql`upper("origin")`),
					origin: text().notNull().default('human')
				}),
				relations: [],
				previous
			})
		);
		const statements = migration?.statements ?? [];
		const origin = statements.findIndex((statement) => statement.includes('ADD COLUMN "origin"'));
		const label = statements.findIndex((statement) => statement.includes('ADD COLUMN "label"'));
		const labelNotNull = statements.findIndex((statement) =>
			statement.includes('ALTER COLUMN "label" SET NOT NULL')
		);
		expect(origin).toBeGreaterThanOrEqual(0);
		expect(label).toBeGreaterThan(origin);
		expect(labelNotNull).toBe(label + 1);
	});

	it('reorders only add-column slots for the same table', () => {
		expect(
			orderGeneratedColumnDependencies([
				'ALTER TABLE "left" ADD COLUMN "derived" text GENERATED ALWAYS AS ("origin") STORED;',
				'DROP INDEX "unrelated";',
				'ALTER TABLE "right" ADD COLUMN "derived" text GENERATED ALWAYS AS ("origin") STORED;',
				'ALTER TABLE "left" ADD COLUMN "origin" text;',
				'ALTER TABLE "right" ADD COLUMN "origin" text;'
			])
		).toEqual([
			'ALTER TABLE "left" ADD COLUMN "origin" text;',
			'DROP INDEX "unrelated";',
			'ALTER TABLE "right" ADD COLUMN "origin" text;',
			'ALTER TABLE "left" ADD COLUMN "derived" text GENERATED ALWAYS AS ("origin") STORED;',
			'ALTER TABLE "right" ADD COLUMN "derived" text GENERATED ALWAYS AS ("origin") STORED;'
		]);
	});

	/**
	 * A database that already exists only ever changes through this lineage, so a trigram index that
	 * lived only in the schema plan would never reach the collections whose size is the reason it
	 * exists.
	 */
	it('carries a searchable column into the lineage as a GIN trigram index', async () => {
		const previous = await snapshotOf(withColumn({}));
		const migration = await Effect.runPromise(
			planWorkspaceMigration({
				models: {
					jurisdictions: defineModel(
						{ code: text(), name: text({ search: true }), ordinary_rate_divisor: numeric() },
						{ recordLabel: 'name' }
					)
				},
				relations: [],
				previous
			})
		);

		expect(migration?.statements).toEqual([
			'CREATE INDEX "jurisdictions_name_search_trgm_idx" ON "jurisdictions" USING gin ("name" gin_trgm_ops);'
		]);
	});

	/**
	 * The index has to converge, or `bolt migrate` proposes the same `CREATE INDEX` forever. It also
	 * has to be absent for a column that did not opt in — the control that makes the assertion above
	 * mean the opt-in and not just "any text column".
	 */
	it('proposes the trigram index once and an un-opted column never', async () => {
		const models = { jurisdictions: defineModel({ code: text(), name: text({ search: true }) }) };
		expect(
			await Effect.runPromise(
				planWorkspaceMigration({ models, relations: [], previous: await snapshotOf(models) })
			)
		).toBeUndefined();

		const unopted = { jurisdictions: defineModel({ code: text(), name: text() }) };
		const created = await Effect.runPromise(
			planWorkspaceMigration({
				models: unopted,
				relations: [],
				previous: undefined
			})
		);
		expect(created?.statements.join('\n')).not.toContain('gin_trgm_ops');
	});

	it('renders a polymorphic reference as an exclusive arc with direct foreign keys', async () => {
		const migration = await Effect.runPromise(
			planWorkspaceMigration({
				models: {
					time_entries: defineModel({ note: text() }),
					leave_requests: defineModel({ note: text() }),
					payslip_sources: defineModel(
						{
							payslip_id: uuid().notNull(),
							source: reference({
								TIME_ENTRY: 'time_entries',
								LEAVE_REQUEST: 'leave_requests'
							})
								.notNull()
								.unique()
						},
						{ indexes: [{ columns: ['payslip_id', 'source'], unique: true }] }
					)
				},
				relations: [],
				previous: undefined
			})
		);
		const ddl = migration?.statements.join('\n') ?? '';
		expect(ddl).toContain('"source__time_entry_id" uuid');
		expect(ddl).toContain('"source__leave_request_id" uuid');
		expect(ddl).not.toContain('"source" jsonb');
		expect(ddl).toContain('num_nonnulls("source__time_entry_id", "source__leave_request_id") = 1');
		expect(ddl).toContain('REFERENCES "time_entries"("id")');
		expect(ddl).toContain('REFERENCES "leave_requests"("id")');
		expect(ddl).toContain('WHERE "source__time_entry_id" is not null');
		expect(ddl).toContain(
			'("payslip_id","source__time_entry_id") WHERE "source__time_entry_id" is not null'
		);
		expect(ddl).toContain(
			'("payslip_id","source__leave_request_id") WHERE "source__leave_request_id" is not null'
		);
	});

	it('renders optional self-references and delete behavior without redundant indexes', async () => {
		const migration = await Effect.runPromise(
			planWorkspaceMigration({
				models: {
					groups: defineModel({ name: text() }),
					nodes: defineModel({
						owner: reference({ NODE: 'nodes', GROUP: 'groups' }).onDelete('cascade')
					})
				},
				relations: [],
				previous: undefined
			})
		);
		const ddl = migration?.statements.join('\n') ?? '';
		expect(ddl).toContain('num_nonnulls("owner__node_id", "owner__group_id") <= 1');
		expect(ddl).toContain(
			'FOREIGN KEY ("owner__node_id") REFERENCES "nodes"("id") ON DELETE CASCADE'
		);
		expect(ddl).toContain(
			'CREATE INDEX "nodes_owner_node_ref_idx" ON "nodes" ("owner__node_id") WHERE "owner__node_id" is not null'
		);
		expect(ddl).not.toContain('CREATE UNIQUE INDEX "nodes_owner_node_ref_idx"');
	});

	it('rejects impossible delete semantics and undeclared targets', async () => {
		await expect(
			Effect.runPromise(
				planWorkspaceMigration({
					models: {
						time_entries: defineModel({}),
						leave_requests: defineModel({}),
						claims: defineModel({
							source: reference({
								TIME_ENTRY: 'time_entries',
								LEAVE_REQUEST: 'leave_requests'
							})
								.notNull()
								.onDelete('set null')
						})
					},
					relations: [],
					previous: undefined
				})
			)
		).rejects.toThrow('cannot use ON DELETE SET NULL');

		await expect(
			Effect.runPromise(
				planWorkspaceMigration({
					models: {
						claims: defineModel({
							source: reference({
								TIME_ENTRY: 'time_entries',
								LEAVE_REQUEST: 'leave_requests'
							})
						})
					},
					relations: [],
					previous: undefined
				})
			)
		).rejects.toThrow('targets undeclared collection');
	});

	it('diffs a changed closed target set through ordinary lineage DDL', async () => {
		const base = {
			time_entries: defineModel({}),
			leave_requests: defineModel({}),
			adjustments: defineModel({})
		};
		const previousModels = {
			...base,
			claims: defineModel({
				source: reference({ TIME_ENTRY: 'time_entries', LEAVE_REQUEST: 'leave_requests' })
			})
		};
		const previous = await snapshotOf(previousModels);
		const migration = await Effect.runPromise(
			planWorkspaceMigration({
				models: {
					...base,
					claims: defineModel({
						source: reference({
							TIME_ENTRY: 'time_entries',
							LEAVE_REQUEST: 'leave_requests',
							ADJUSTMENT: 'adjustments'
						})
					})
				},
				relations: [],
				previous
			})
		);
		const ddl = migration?.statements.join('\n') ?? '';
		expect(ddl).toContain('ADD COLUMN "source__adjustment_id" uuid');
		expect(ddl).toContain('REFERENCES "adjustments"("id")');
		expect(ddl).toContain(
			'num_nonnulls("source__time_entry_id", "source__leave_request_id", "source__adjustment_id") <= 1'
		);
		if (migration === undefined)
			throw new Error('adding a reference target must produce a migration');
		const removed = await Effect.runPromise(
			planWorkspaceMigration({
				models: previousModels,
				relations: [],
				previous: migration.snapshot
			})
		);
		const removalDdl = removed?.statements.join('\n') ?? '';
		expect(removalDdl).toContain('DROP COLUMN "source__adjustment_id"');
		expect(removalDdl).toContain(
			'num_nonnulls("source__time_entry_id", "source__leave_request_id") <= 1'
		);
	});
});
