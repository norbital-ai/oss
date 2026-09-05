// repository-health:allow SEM_PARALLEL -- the runtime workspace-schema consumes the compiler
// schema-plan contract/identify names over the #lib alias, so the pair is linked, not parallel.
import { Array, Context, Effect, Layer, Result, Schema } from 'effect';
import {
	EMBEDDED_AT_COLUMN,
	RECORD_EMBEDDING_COLUMN,
	RECORD_EMBEDDING_FINGERPRINT_COLUMN,
	SEARCH_DOCUMENT_COLUMN,
	searchableColumns
} from '#lib/authoring/model-introspection.js';
import { eq } from 'drizzle-orm';
import { pgSchema, pgTable, text } from 'drizzle-orm/pg-core';
import type { EffectId } from '@norbital-ai/bolt-protocol';
import { planTableNames, type SchemaPlan } from './schema-plan.js';
export { fingerprintSchemaSteps } from './schema-plan.js';
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
import { isObjectLike, isString } from '#lib/schema-decode.js';

const { bolt_schema_state: schemaState } = SYSTEM_MODEL_TABLES;
// `__drizzle_migrations` is drizzle's ledger, not Bolt's. The runtime descriptor names only the one
// column this service reads and writes.
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
export const layer = (schemaPlan: SchemaPlan) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const workspace = yield* Workspace.Service;
			const database = yield* Database.Service;
			/**
			 * The columns each collection is supposed to have, from the same definition the plan renders DDL
			 * from — so "declared" cannot drift from "created" by being restated here.
			 */
			const declaredColumns = new Map<string, ReadonlySet<string>>(
				workspace.definition.collections.map((collection) => [
					collection.name,
					new Set([
						...SYSTEM_COLUMN_NAMES,
						// Platform-owned embedding state, declared by the model but owned by no authored field.
						// Settle owns all three as one protocol: the vector, when it was written, and the exact
						// source fingerprint it represents. Omitting either witness makes verification call the
						// columns the lineage just created unexpected and rejects a correct database.
						...(collection.embedding === undefined
							? []
							: [RECORD_EMBEDDING_COLUMN, EMBEDDED_AT_COLUMN, RECORD_EMBEDDING_FINGERPRINT_COLUMN]),
						// The generated lexical document, for the same reason and read the same way the plan
						// decides to create it: `search.fields` when the compiler derived them, otherwise the
						// `search: true` flags themselves. Omitting it made every searchable collection —
						// `user` and `team` among them — report the column the plan had just added as
						// unexpected, which fails `migrate` on a database that is exactly right.
						...((collection.search?.fields ?? searchableColumns(collection.fields)).length === 0
							? []
							: [SEARCH_DOCUMENT_COLUMN]),
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
			const planOnlyTables = planTableNames(schemaPlan).filter(
				(name) => !declaredColumns.has(name)
			);
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
					if (!isObjectLike(row)) continue;
					const table = Reflect.get(row, 'table_name');
					const column = Reflect.get(row, 'column_name');
					if (!isString(table) || !isString(column)) continue;
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
			 * Read from `__drizzle_migrations`, the ledger `applyLineage` below writes,
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
						const tag = isObjectLike(row) ? Reflect.get(row, 'tag') : undefined;
						return isString(tag) ? [tag] : [];
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
			const applyLineage = Effect.fn('WorkspaceSchema.applyLineage')(function* (
				effectId: EffectId
			) {
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
			return Service.of({
				plan: () => schemaPlan,
				validate,
				fingerprint: () => schemaPlan.fingerprint,
				migrate: Effect.fn('WorkspaceSchema.migrate')(function* (effectId) {
					yield* validate();
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
					 *
					 * `:live-index:` steps share the constraint for the same reason: `effectiveIndexSteps`
					 * indexes relationship endpoints and effective-plan probes on *workspace* collections —
					 * the one other plan step kind whose target table only the lineage creates. On a virgin
					 * database the first of them raised `relation … does not exist`, the plan transaction
					 * rolled back whole, and the tenant was left an empty database that looked provisioned.
					 */
					const [postLineageSteps, planSteps] = Array.partition(schemaPlan.steps, (step) =>
						step.id.includes(':exclusion:') ||
						step.id.includes(':live-index:') ||
						step.id.startsWith('sync-trigger:')
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
					// `bolt_*` tables. Three things block it:
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
					yield* applyLineage(effectId);
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
