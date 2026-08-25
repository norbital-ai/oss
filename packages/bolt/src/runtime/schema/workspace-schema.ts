// repository-health:allow SEM_PARALLEL -- the runtime workspace-schema consumes the compiler
// schema-plan build/plan/identify names over the #lib alias, so the pair is linked, not parallel.
import { Array, Context, Effect, Layer, Result, Schema } from 'effect';
import { count, eq } from 'drizzle-orm';
import { pgSchema, pgTable, text } from 'drizzle-orm/pg-core';
import type { EffectId } from '@norbital-ai/bolt-protocol';
import { buildSchemaPlan, planTableNames, type SchemaPlan } from '#lib/compiler/schema-plan.js';
export { fingerprintSchemaSteps } from '#lib/compiler/schema-plan.js';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as Database from '#lib/runtime/facilities/database.js';
import {
	composer,
	currentSchema,
	executeBuilt,
	transactionBuilt,
	transactionSql
} from '#lib/runtime/persistence.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { withSystemCollections } from '#lib/runtime/schema/system-collections.js';

const { bolt_schema_state: schemaState } = SYSTEM_MODEL_TABLES;
// The lineage ledger predates system-row columns in existing tenants. Keep its runtime descriptor
// to the one column this service owns so a migration can still record itself in that legacy shape.
const migrationLedger = pgTable('__drizzle_migrations', {
	tag: text().notNull().unique()
});
const informationSchemaColumns = pgSchema('information_schema').table('columns', {
	table_name: text().notNull(),
	column_name: text().notNull(),
	table_schema: text().notNull()
});

export interface Interface {
	readonly plan: () => SchemaPlan;
	readonly validate: () => Effect.Effect<void, SchemaValidationError>;
	readonly migrate: (
		effectId: EffectId
	) => Effect.Effect<void, Database.FacilityError | SchemaValidationError>;
	/** The divergences between the authored collections and the live tables; empty means verified. */
	readonly verify: (
		effectId: EffectId
	) => Effect.Effect<ReadonlyArray<string>, Database.FacilityError>;
	readonly fingerprint: () => string;
}
/** Carries schema validation error through the typed schema failure channel without losing diagnostic context. */
class SchemaValidationError extends Schema.TaggedError<SchemaValidationError>()(
	'Bolt.WorkspaceSchema.ValidationError',
	{
		message: Schema.NonEmptyString
	}
) {
	readonly category = 'workspace-schema' as const;
	readonly retryable = false;
	readonly phase = 'validate' as const;
}
/** Identifies the schema service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/WorkspaceSchema');
export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const workspace = yield* Workspace.Service;
		const database = yield* Database.Service;
		const schemaPlan = buildSchemaPlan(workspace.definition);
		/**
		 * The columns each collection is supposed to have, from the same definition the plan renders DDL
		 * from — so "declared" cannot drift from "created" by being restated here.
		 */
		const declaredColumns = new Map<string, ReadonlySet<string>>(
			withSystemCollections(workspace.definition).collections.map((collection) => [
				collection.name,
				new Set([
					...SYSTEM_COLUMN_NAMES,
					...Object.entries(collection.fields).flatMap(([name, field]) =>
						field.reference === undefined
							? [name]
							: field.reference.targets.map(({ storageColumn }) => storageColumn)
					)
				])
			])
		);
		/**
		 * The `bolt_*` tables the plan creates that no collection covers.
		 *
		 * `declaredColumns` is built from collections, so it can only ever speak for collection tables.
		 * The plan creates fifteen more, and until now nothing checked any of them: `migrate` applied the
		 * plan, verified the collections, found no divergence and reported success, whatever became of the
		 * rest of its own steps. Column-level checking stops at the collection boundary on purpose — these
		 * tables are declared as raw DDL rather than from fields, so the only claim the plan makes about
		 * them that is worth verifying is that they are there.
		 */
		const planOnlyTables = planTableNames(schemaPlan).filter((name) => !declaredColumns.has(name));
		/**
		 * Compares the authored collections against the columns the database actually holds.
		 *
		 * This used to read back the plan fingerprint `migrate` had just written, which cannot fail: the
		 * value compared was the value inserted a moment earlier by the same process, so `verified` was
		 * true whatever shape the tables were in. The plan is `create table if not exists` throughout, so a
		 * table that predates the current plan keeps its old columns and is silently accepted — which is
		 * exactly how a collection table with no `sys_period` survived a green verify. Reading
		 * `information_schema` is the only answer that can be wrong, so it is the only one worth asking.
		 */
		const verify = Effect.fn('WorkspaceSchema.verify')(function* (effectId: EffectId) {
			const result = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({
						table_name: informationSchemaColumns.table_name,
						column_name: informationSchemaColumns.column_name
					})
					.from(informationSchemaColumns)
					.where(eq(informationSchemaColumns.table_schema, currentSchema()))
			);
			const live = new Map<string, Set<string>>();
			for (const row of result.rows) {
				if (typeof row !== 'object' || row === null) continue;
				const table = Reflect.get(row, 'table_name');
				const column = Reflect.get(row, 'column_name');
				if (typeof table !== 'string' || typeof column !== 'string') continue;
				const columns = live.get(table);
				if (columns === undefined) live.set(table, new Set([column]));
				else columns.add(column);
			}
			return [
				...planOnlyTables
					.filter((name) => !live.has(name))
					.map((name) => `${name}: table is missing`),
				...[...declaredColumns]
					.toSorted(([left], [right]) => left.localeCompare(right))
					.flatMap(([name, declared]) => {
						const columns = live.get(name);
						if (columns === undefined) return [`${name}: table is missing`];
						const absent = [...declared].filter((column) => !columns.has(column)).toSorted();
						// An unexpected column is reported too, not tolerated: it is what a dropped field leaves
						// behind, and a `not null` leftover refuses every insert the workspace makes.
						const unexpected = [...columns].filter((column) => !declared.has(column)).toSorted();
						return [
							...(absent.length === 0
								? []
								: [
										`${name}: missing column${absent.length === 1 ? '' : 's'} ${absent.join(', ')}`
									]),
							...(unexpected.length === 0
								? []
								: [
										`${name}: unexpected column${unexpected.length === 1 ? '' : 's'} ${unexpected.join(', ')}`
									])
						];
					})
			];
		});
		const validate = Effect.fn('WorkspaceSchema.validate')(function* () {
			const ids = new Set<string>();
			for (const step of schemaPlan.steps) {
				if (step.id.trim() === '' || step.sql.trim() === '')
					return yield* new SchemaValidationError({
						message: 'Schema plan contains an empty migration step'
					});
				if (ids.has(step.id))
					return yield* new SchemaValidationError({
						message: `Schema plan contains duplicate step ${step.id}`
					});
				ids.add(step.id);
			}
		});
		/**
		 * The lineage the artifact carries, oldest first; empty when the workspace has never migrated.
		 *
		 * Sorted here rather than trusted, even though the compiler reads the directory in tag order. A tag
		 * is `<UTC timestamp>_<name>`, so lexical order is chronological order, and the array is ordinary
		 * data inside an artifact — one that arrived in a different order would apply entry three against
		 * the shape entry one leaves behind and fail in a way that names a table rather than the ordering.
		 */
		const lineage = [...(workspace.definition.migrations ?? [])].toSorted((left, right) =>
			left.tag.localeCompare(right.tag)
		);
		/**
		 * The lineage tags this database has already been brought through.
		 *
		 * Read from `__drizzle_migrations`, the ledger `applyLineage` and `baselineLineage` below write,
		 * so a database is recognised as being however many entries in that it actually is. Reading it
		 * rather than assuming is what makes "pending" mean pending.
		 */
		const appliedTags = Effect.fn('WorkspaceSchema.appliedTags')(function* (effectId: EffectId) {
			const result = yield* executeBuilt(
				effectId,
				database,
				composer.select({ tag: migrationLedger.tag }).from(migrationLedger)
			);
			return new Set(
				result.rows.flatMap((row) => {
					const tag = typeof row === 'object' && row !== null ? Reflect.get(row, 'tag') : undefined;
					return typeof tag === 'string' ? [tag] : [];
				})
			);
		});
		/**
		 * Applies the lineage entries this database has not been through, oldest first.
		 *
		 * Each entry is one transaction that ends with its own ledger row, so the DDL and the record of it
		 * commit together: Postgres makes DDL transactional, so a half-applied entry cannot be recorded and
		 * a recorded entry cannot be half-applied. `tag` is UNIQUE, which is what makes exactly-once a
		 * database guarantee rather than a race between two hosts booting at the same moment.
		 *
		 * A failure propagates rather than being collected, so the loop stops on the entry that failed
		 * instead of stepping over it. Entry N+1 is a diff against the shape entry N leaves behind, and
		 * running it against the shape entry N-1 left is how a lineage produces a database no snapshot
		 * describes.
		 */
		const applyLineage = Effect.fn('WorkspaceSchema.applyLineage')(function* (effectId: EffectId) {
			const applied = yield* appliedTags(effectId);
			// `concurrency: 1` is the requirement, not a default: an entry is a diff against the shape its
			// predecessor leaves behind, so two entries running at once describe a shape that never existed.
			// It is also what makes the failure behaviour right — the first failure ends the traversal, so a
			// broken entry stops the lineage instead of being stepped over.
			yield* Effect.forEach(
				lineage.filter((entry) => !applied.has(entry.tag)),
				(entry) =>
					transactionBuilt(effectId, database, [
						...entry.statements.map((statement) => transactionSql(statement)),
						composer.insert(migrationLedger).values({ tag: entry.tag })
					]),
				{ concurrency: 1 }
			);
		});
		/**
		 * Records the whole lineage as reached, without running any of it.
		 *
		 * Only ever used when the plan has just provisioned every collection from nothing. The plan renders
		 * the *current* authored shape, which is where the lineage ends, so a database it has just built is
		 * already at the head of the lineage; replaying entries that describe how earlier shapes became this
		 * one would fail on the first `CREATE TABLE`.
		 *
		 * This is not a licence to skip. The alternative is not "apply them anyway", it is a database whose
		 * position in the lineage is unrecorded — so the next entry `bolt migrate` appends would queue up
		 * behind every entry that came before it and never run. And `verify` still runs afterwards and is
		 * the arbiter: if baselining were ever the wrong answer, the divergence it names fails the migration.
		 *
		 * Re-baselining a workspace onto Bolt's own lineage does not retire this, and every lineage in the
		 * realm is now Bolt's own. The plan is what provisions, and its `create table if not exists` runs
		 * before the lineage does, so even a lineage whose first entry is a complete Bolt baseline meets
		 * tables that already exist and fails on its own `CREATE TABLE "companies"`. Retiring this means
		 * the lineage provisioning instead of the plan — see the note on `migrate` below.
		 */
		const baselineLineage = Effect.fn('WorkspaceSchema.baselineLineage')(function* (
			effectId: EffectId
		) {
			if (lineage.length === 0) return;
			yield* transactionBuilt(
				effectId,
				database,
				lineage.map((entry) =>
					composer
						.insert(migrationLedger)
						.values({ tag: entry.tag })
						.onConflictDoNothing({ target: migrationLedger.tag })
				)
			);
		});
		return Service.of({
			plan: () => schemaPlan,
			validate,
			fingerprint: () => schemaPlan.fingerprint,
			migrate: Effect.fn('WorkspaceSchema.migrate')(function* (effectId) {
				yield* validate();
				// Taken before the plan runs, because the plan is about to create whatever is missing and
				// afterwards nothing distinguishes a database provisioned a second ago from one that was
				// already carrying every table. That distinction is the whole of the baseline decision
				// below, so it has to be read while it is still observable.
				const absent = new Set(
					(yield* verify(effectId)).flatMap((divergence) => {
						const missing = /^(?<table>.+): table is missing$/.exec(divergence)?.groups?.['table'];
						return missing === undefined ? [] : [missing];
					})
				);
				const allAuthoredTablesPresent = workspace.definition.collections.every(
					({ name }) => !absent.has(name)
				);
				/**
				 * Whether this database was built by the older plan, which rendered collection tables itself.
				 *
				 * "Has tables but no lineage tags" is not enough to say so: a database provisioned from the
				 * lineage a moment ago also has tables and no tags yet. The discriminator is a plan fingerprint
				 * written by a *previous* migrate — read before this run writes its own — which only a database
				 * the old plan provisioned can have.
				 */
				// Two statements rather than one guarded by `case`: PostgreSQL resolves every relation a query
				// names at parse time, whichever branch would run, so a `case` guarding the count still fails
				// with `relation "bolt_schema_state" does not exist` on the database this exists to recognise.
				const readField = (row: Schema.Json | undefined, key: string): unknown =>
					typeof row === 'object' && row !== null && !Array.isArray(row)
						? Reflect.get(row, key)
						: undefined;
				const planned = !absent.has('bolt_schema_state')
					? Number(
							readField(
								(yield* executeBuilt(
									effectId,
									database,
									composer.select({ count: count() }).from(schemaState)
								)).rows[0],
								'count'
							) ?? 0
						)
					: 0;
				/**
				 * An EXCLUDE constraint has to wait for the lineage that builds the table it constrains.
				 *
				 * These are the one part of the plan that alters a workspace collection rather than creating
				 * something of Bolt's own, and the plan stopped rendering those tables when the lineage took
				 * them over — so on a virgin database the constraint arrived before anything had created
				 * `contribution_rates`, `'contribution_rates'::regclass` raised, and `migrate` died there.
				 * The lineage never ran, and the tenant was left with the handful of `bolt_*` tables the
				 * plan does still own, looking provisioned. It only stayed hidden because an already-migrated
				 * database has the tables, so the constraint applies and the ordering never shows.
				 *
				 * Split by id rather than by inspecting the SQL: `exclusionStep` is what mints these and it
				 * is the same module that decides they belong to a collection.
				 */
				const [postLineageSteps, planSteps] = Array.partition(schemaPlan.steps, (step) =>
					step.id.includes(':exclusion:') || step.id.startsWith('sync-trigger:')
						? Result.fail(step)
						: Result.succeed(step)
				);
				yield* transactionBuilt(effectId, database, [
					...planSteps.map(({ sql }) => transactionSql(sql)),
					composer.insert(schemaState).values({ fingerprint: schemaPlan.fingerprint })
				]);
				// The lineage runs after the plan, never before: its DDL calls `bolt_date` and
				// `bolt_daterange` and indexes with `gin_trgm_ops`, all of which the plan's foundation
				// installs, and it records itself in a ledger the plan creates.
				//
				// This fork is why two definitions of every collection table exist — the plan's
				// `create table if not exists` and the lineage's `CREATE TABLE`. The intended end state is
				// that the lineage owns collection DDL and the plan owns only extensions, functions and
				// `bolt_*` tables, which would delete `baselineLineage` and one of the two definitions with
				// it. Three things block it, and none is a legacy accommodation:
				//
				//   - `system-collections.ts` declares `approval_request` and `requestor` as
				//     `CollectionDefinition`s, not Drizzle models. They are Bolt's, not any workspace's, so
				//     they appear in no workspace lineage and only the plan can create them.
				//   - An EXCLUDE constraint is not a Drizzle entity (see `CollectionDefinition.exclusions`),
				//     so the lineage cannot render one and the plan is the only writer.
				//   - Every definition assembled in a test is `field.*` calls with no lineage behind them,
				//     and `tests/support/bolt-test-layer.ts` provisions from the plan.
				//
				// Closing it means giving system collections and tests a generated lineage — a mechanism
				// that does not exist. What keeps the two halves honest meanwhile is that they render the
				// same types from the same declaration; `tests/compiler/schema-migrations.test.ts` pins that.
				// Inverted when the plan stopped rendering collection DDL. A virgin database used to arrive
				// here with every table already built by the plan, so the lineage was *recorded* as reached;
				// replaying it would have failed on its own first `CREATE TABLE`. The lineage now owns those
				// tables, so on a virgin database it is the only thing that creates them and it has to run.
				//
				// Baselining survives for exactly one case: a database provisioned by the older plan, which
				// therefore has the tables but has never recorded a lineage tag. Running the lineage there
				// would fail on `CREATE TABLE "companies"`, and skipping the record would leave its position
				// unknown so the next authored entry would queue behind entries that can never run.
				const recorded = yield* appliedTags(effectId);
				// A previous plan can only have provisioned the workspace when every authored table is
				// present. "Not wholly virgin" is weaker: a failed first lineage can leave Bolt's own tables
				// and a plan fingerprint behind while its transactional CREATE TABLE statements roll back.
				// Baselining that partial database records schema DDL that never committed, after which every
				// retry skips the only statements capable of creating the missing tables.
				const legacy = allAuthoredTablesPresent && recorded.size === 0 && planned > 0;
				yield* legacy ? baselineLineage(effectId) : applyLineage(effectId);
				// Now that the collections exist, whichever half created them.
				if (postLineageSteps.length > 0) {
					yield* transactionBuilt(
						effectId,
						database,
						postLineageSteps.map(({ sql }) => transactionSql(sql))
					);
				}
				// Neither half can be trusted to have finished the job. The plan can only add, so a collection
				// whose table already exists in an older shape is skipped by every `if not exists` in it; the
				// lineage only carries the entries somebody generated. A successful run is therefore not
				// evidence the database matches the workspace — and reporting `migrated` on a divergent
				// database is how a broken table shape stays hidden. What neither reached is named here.
				const divergences = yield* verify(effectId);
				if (divergences.length > 0) {
					return yield* new SchemaValidationError({
						message: `The database does not match the authored collections after applying the schema plan and ${lineage.length} lineage entr${lineage.length === 1 ? 'y' : 'ies'}. These need a migration:\n${divergences.map((divergence) => `  ${divergence}`).join('\n')}`
					});
				}
			}),
			verify
		});
	})
);
