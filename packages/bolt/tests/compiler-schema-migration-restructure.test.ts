import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { defineModel, numeric, reference, text } from '../src/authoring/index.js';
import type { ModelDeclaration } from '../src/authoring/models-schema.js';
import { compileWorkspaceAuthoring } from '../src/authoring/model-introspection.js';
import {
	planWorkspaceMigration as planCompiledMigration,
	type WorkspaceSnapshot
} from '../src/compiler/schema-migrations.js';

const planWorkspaceMigration = (input: {
	readonly models: Readonly<Record<string, ModelDeclaration>>;
	readonly previous: WorkspaceSnapshot | undefined;
}) =>
	planCompiledMigration({
		authoring: compileWorkspaceAuthoring({
			models: input.models,
			sourcePaths: Object.fromEntries(
				Object.keys(input.models).map((name) => [name, `fixture:${name}`])
			)
		}),
		previous: input.previous
	});

/**
 * A restructure removes and adds in the same step, and until the two-pass split it could not be
 * migrated at all.
 *
 * drizzle-kit decides create-versus-rename through a resolver it consults whenever one diff both
 * created and deleted something of the same entity kind. `generateMigration` builds those resolvers
 * with no `HintsHandler`, so merely reaching that question throws
 * `Internal error: resolver(table) was called without a HintsHandler`. The resolver returns early
 * when either side is empty, so every edit Bolt had been asked for until then — a workspace that
 * only grew, or a lineage that only dropped — passed straight through it and left the failure
 * waiting for the first real restructure.
 *
 * Each test here is one entity kind that reaches its own resolver, and every one of them threw
 * before the split. They assert the migration is *produced*: the resolver failure was a rejected
 * Effect, not wrong SQL, so a test that only inspected statements would still be the test that
 * caught it.
 */

const snapshotOf = async (
	models: Readonly<Record<string, ModelDeclaration>>
): Promise<WorkspaceSnapshot> => {
	const migration = await Effect.runPromise(
		planWorkspaceMigration({ models, previous: undefined })
	);
	if (migration === undefined)
		throw new Error('a schema built from nothing must produce a migration');
	return migration.snapshot;
};

const migrate = async (
	previous: WorkspaceSnapshot,
	models: Readonly<Record<string, ModelDeclaration>>
): Promise<ReadonlyArray<string>> => {
	const migration = await Effect.runPromise(
		planWorkspaceMigration({ models, previous })
	);
	if (migration === undefined) throw new Error('a restructure must produce a migration');
	return migration.statements;
};

/** The index of the first statement containing `fragment`, or -1. */
const at = (statements: ReadonlyArray<string>, fragment: string): number =>
	statements.findIndex((statement) => statement.includes(fragment));

/** The index of the last statement containing `fragment`, or -1. */
const lastAt = (statements: ReadonlyArray<string>, fragment: string): number =>
	statements.findLastIndex((statement) => statement.includes(fragment));

const keep = defineModel({ code: text(), name: text() }, { recordLabel: 'name' });

describe('a restructure that removes and adds in one step', () => {
	/**
	 * The reported failure, reduced: hr-payroll dropped six collections and created three, which made
	 * the created and deleted sides of the `tables` diff non-empty together for the first time.
	 */
	it('drops removed collections and creates added ones in one migration', async () => {
		const previous = await snapshotOf({
			keep,
			retired_one: defineModel({ name: text() }, { recordLabel: 'name' }),
			retired_two: defineModel({ name: text() }, { recordLabel: 'name' })
		});
		const statements = await migrate(previous, {
			keep,
			added_one: defineModel({ name: text() }, { recordLabel: 'name' }),
			added_two: defineModel({ name: text() }, { recordLabel: 'name' })
		});
		const ddl = statements.join('\n');
		expect(ddl).toContain('DROP TABLE "retired_one"');
		expect(ddl).toContain('DROP TABLE "retired_two"');
		expect(ddl).toContain('CREATE TABLE "added_one"');
		expect(ddl).toContain('CREATE TABLE "added_two"');
		// The resolver exists to offer "did you mean a rename?". Bolt's answer is always no, and the
		// split is what makes that answer structural rather than a preference the resolver could
		// override once someone supplied it hints.
		expect(ddl).not.toContain('RENAME');
	});

	/**
	 * The guard against re-introducing the bug the previous-snapshot filter caused. That filter also
	 * computed "the entities `previous` and the current models agree on", so it looks like the
	 * intermediate snapshot; it used the set as the *source* of the only diff, which hid a removed
	 * collection from the differ and emitted nothing for it. The intermediate is the *target* of the
	 * first pass instead, so a removed collection is present in that pass's source and absent from its
	 * target, and the drop is the whole point of the pass rather than the casualty of it.
	 *
	 * A restructure is the case where the two are hardest to tell apart, because the added collection
	 * gives the diff something to emit either way — the migration is non-empty, and only the drop's
	 * presence distinguishes a working split from the reverted filter.
	 */
	it('still drops a removed collection when the same step also adds one', async () => {
		const previous = await snapshotOf({ keep, retired: defineModel({ name: text() }) });
		const statements = await migrate(previous, { keep, added: defineModel({ name: text() }) });
		expect(at(statements, 'DROP TABLE "retired"')).toBeGreaterThanOrEqual(0);
	});

	/**
	 * Every drop belongs to the first pass and every create to the second, so a foreign key can never
	 * be created against a table that a later statement drops. Concatenation order is the only
	 * ordering decision this module makes across the two passes; drizzle-kit orders within each.
	 */
	it('orders every drop ahead of every create', async () => {
		const previous = await snapshotOf({
			keep,
			retired: defineModel({ name: text() }, { recordLabel: 'name' })
		});
		const statements = await migrate(previous, {
			keep,
			added: defineModel({ name: text() }, { recordLabel: 'name' })
		});
		const lastDrop = lastAt(statements, 'DROP TABLE ');
		const firstCreate = at(statements, 'CREATE TABLE ');
		// Named separately so a migration that stopped emitting one of the two fails here rather than
		// passing on a -1 that compares smaller than everything.
		expect(lastDrop).toBeGreaterThanOrEqual(0);
		expect(firstCreate).toBeGreaterThanOrEqual(0);
		expect(lastDrop).toBeLessThan(firstCreate);
	});

	/**
	 * `resolver(column)`. drizzle-kit groups the column diff by table before consulting the resolver,
	 * so this needs both sides on one surviving table rather than one column anywhere — which is what
	 * an author does every time they rename a field, since Bolt asks them to express that as a drop
	 * and an add.
	 */
	it('replaces a column on a table that survives', async () => {
		const previous = await snapshotOf({
			keep: defineModel({ code: text(), name: text(), retired: numeric() }, { recordLabel: 'name' })
		});
		const statements = await migrate(previous, {
			keep: defineModel({ code: text(), name: text(), added: numeric() }, { recordLabel: 'name' })
		});
		const dropped = at(statements, 'DROP COLUMN "retired"');
		const addedColumn = at(statements, 'ADD COLUMN "added"');
		expect(dropped).toBeGreaterThanOrEqual(0);
		expect(addedColumn).toBeGreaterThan(dropped);
	});

	/**
	 * `resolver(unique)`: the constraint moves from one column of a surviving table to another, which
	 * puts a created and a deleted unique on the same table in one diff. The assertion is deliberately
	 * shallow — drizzle-kit owns the constraint's generated name and the exact `ALTER` it renders, and
	 * what is being pinned here is that the plan is produced at all, since before the split this
	 * rejected before emitting anything.
	 */
	it('moves a unique constraint between columns of one table', async () => {
		const previous = await snapshotOf({
			keep: defineModel({ code: text().unique(), name: text() }, { recordLabel: 'name' })
		});
		const statements = await migrate(previous, {
			keep: defineModel({ code: text(), name: text().unique() }, { recordLabel: 'name' })
		});
		expect(statements.join('\n')).toContain('UNIQUE');
	});

	/**
	 * `resolver(foreign key)`. A polymorphic reference compiles to one nullable column per target and
	 * one foreign key named after the target's tag, so swapping a target both creates and deletes a
	 * foreign key on the same table in a single diff. The `num_nonnulls` check is named after the
	 * field alone and so survives as an alteration rather than a drop and an add — asserted here
	 * because the check has to follow the columns through the swap, not because it reaches a resolver.
	 */
	it('swaps one reference target for another', async () => {
		const targets = {
			time_entries: defineModel({ name: text() }, { recordLabel: 'name' }),
			leave_requests: defineModel({ name: text() }, { recordLabel: 'name' }),
			adjustments: defineModel({ name: text() }, { recordLabel: 'name' })
		};
		const previous = await snapshotOf({
			...targets,
			claims: defineModel({
				source: reference({ TIME_ENTRY: 'time_entries', LEAVE_REQUEST: 'leave_requests' })
			})
		});
		const statements = await migrate(previous, {
			...targets,
			claims: defineModel({
				source: reference({ TIME_ENTRY: 'time_entries', ADJUSTMENT: 'adjustments' })
			})
		});
		const ddl = statements.join('\n');
		expect(ddl).toContain('DROP COLUMN "source__leave_request_id"');
		expect(ddl).toContain('ADD COLUMN "source__adjustment_id"');
		expect(ddl).toContain('num_nonnulls("source__time_entry_id", "source__adjustment_id") <= 1');
	});

	/**
	 * The split must not invent work. A step that only adds has an intermediate identical to the
	 * previous snapshot, so the first pass diffs a snapshot against itself and contributes nothing —
	 * the migration has to stay exactly the one statement the single-pass diff produced.
	 */
	it('leaves a pure addition to a single statement', async () => {
		const previous = await snapshotOf({ keep });
		expect(
			await migrate(previous, {
				keep: defineModel({ code: text(), name: text(), added: numeric() }, { recordLabel: 'name' })
			})
		).toEqual(['ALTER TABLE "keep" ADD COLUMN "added" numeric;']);
	});

	/** And a step that only drops still resolves through the second pass to nothing extra. */
	it('leaves a pure removal to a single statement', async () => {
		const previous = await snapshotOf({
			keep: defineModel({ code: text(), name: text(), retired: numeric() }, { recordLabel: 'name' })
		});
		expect(await migrate(previous, { keep })).toEqual([
			'ALTER TABLE "keep" DROP COLUMN "retired";'
		]);
	});

	/** Converged schemas must still report nothing to do rather than an empty two-pass migration. */
	it('writes no migration when the models and the lineage already agree', async () => {
		const models = { keep, other: defineModel({ name: text() }, { recordLabel: 'name' }) };
		expect(
			await Effect.runPromise(
				planWorkspaceMigration({ models, previous: await snapshotOf(models) })
			)
		).toBeUndefined();
	});
});
