import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { defineModel, enums, text } from '../../src/authoring/index.js';
import type { SystemRow } from '../../src/authoring/contracts-schema.js';
import { describeModel } from '../../src/authoring/model-introspection.js';
import { extractCollectionCatalog } from '../../src/compiler/model-fields.js';
import { planWorkspaceMigration } from '../../src/compiler/schema-migrations.js';
import { SYSTEM_COLUMN_NAMES } from '../../src/compiler/schema-plan.js';

/**
 * Two more options that were accepted at the authoring boundary and then dropped: an `enums()`
 * column's members, and the sixth system column in the row type authored code is handed.
 */

const model = defineModel({
	status: enums(['active', 'draft']),
	lifecycle: enums(['DRAFT', 'PAID'], { search: true }),
	title: enums(['a']).notNull(),
	reference: enums(['x', 'y']).default('x')
});

const source = `export default defineModel({
	status: enums(['active', 'draft']),
	lifecycle: enums(['DRAFT', 'PAID'], { search: true })
});`;

describe('enums() members', () => {
	/**
	 * `enums()` returned a bare `pgText()` and threw the members away, so `config.enumValues` was
	 * empty and `describeModelColumns` never set `FieldDefinition.values` — the one path that reads
	 * the declaration rather than scraping the source.
	 */
	it('survives onto the column declaration', () => {
		const fields = describeModel(model);
		expect(fields.status?.values).toEqual(['active', 'draft']);
		expect(fields.lifecycle?.values).toEqual(['DRAFT', 'PAID']);
	});

	/** The members must survive the fluent builder calls every authored column is written with. */
	it('survives .notNull() and .default() on the same builder', () => {
		const fields = describeModel(model);
		expect(fields.title?.values).toEqual(['a']);
		expect(fields.reference?.values).toEqual(['x', 'y']);
		expect(fields.title?.required).toBe(true);
	});

	/** Recovering the members must not cost the column its search opt-in, which shares the builder. */
	it('leaves the search opt-in intact', () => {
		expect(describeModel(model).lifecycle?.search).toBe(true);
	});

	/**
	 * The divergence the introspection rewrite existed to end: the regex catalog the client reads
	 * recovered the members from source while the declaration-read path could not, so the two halves
	 * of one declaration disagreed with nothing to say so. Pinned to each other here.
	 */
	it('agrees with the members the client catalog recovers from source', () => {
		const catalog = extractCollectionCatalog('payroll_runs', source, []);
		const declared = describeModel(model);
		for (const field of catalog.fields) {
			expect(declared[field.name]?.values).toEqual(field.values);
		}
		expect(catalog.fields.map(({ values }) => values)).toEqual([
			['active', 'draft'],
			['DRAFT', 'PAID']
		]);
	});

	/**
	 * The members are a validation and rendering concern, not a storage one: Drizzle's `enum` on a
	 * text builder narrows values, it does not create a Postgres enum type. If that ever stopped being
	 * true the column would change type under every deployed workspace, so it is asserted rather than
	 * assumed.
	 */
	it('changes no DDL — the column is still text', async () => {
		const migration = await Effect.runPromise(planWorkspaceMigration({
			models: { payroll_runs: model },
			relations: [],
			previous: undefined
		}));
		const create = migration?.statements.find((statement) => statement.startsWith('CREATE TABLE'));
		expect(create).toContain('"status" text');
		expect(create).not.toMatch(/CREATE TYPE|::"?payroll_runs/i);
	});

	/**
	 * Every deployed workspace's newest snapshot was written by the builder that dropped the members.
	 * If they reached the snapshot, the next `bolt migrate` would diff every enum column in every
	 * template against a lineage that never mentioned them — a migration nobody asked for, over
	 * columns whose storage did not change.
	 */
	it('leaves a lineage written before the fix converged', async () => {
		const before = await Effect.runPromise(planWorkspaceMigration({
			models: {
				payroll_runs: defineModel({
					status: text(),
					lifecycle: text({ search: true }),
					title: text().notNull(),
					reference: text().default('x')
				})
			},
			relations: [],
			previous: undefined
		}));
		if (before === undefined)
			throw new Error('a schema built from nothing must produce a migration');

		expect(
			await Effect.runPromise(planWorkspaceMigration({
				models: { payroll_runs: model },
				relations: [],
				previous: before.snapshot
			}))
		).toBeUndefined();
	});
});

describe('SystemRow', () => {
	/**
	 * Typed as `SystemRow`, so this literal is the witness: a column `SystemRow` does not declare is
	 * an excess property and fails `tsc`, and one it declares but this omits fails too. `keyof` is not
	 * enumerable at runtime, so the assertion below then proves the witness names exactly the columns
	 * the schema plan creates — which is what authored row types claim to describe.
	 *
	 * `norbital_sys_period` was the omission: five of six, so every template's row type denied that
	 * the temporal column exists while every table has it.
	 */
	const witness: SystemRow = {
		norbital_id: '2f1b4a1e-0000-4000-8000-000000000000',
		norbital_created_at: '2026-01-01T00:00:00.000Z',
		norbital_updated_at: '2026-01-01T00:00:00.000Z',
		norbital_sys_period: '["2026-01-01 00:00:00+00",)',
		norbital_row_version: 1,
		norbital_approval_id: null
	};

	it('describes every system column the schema plan creates, and no others', () => {
		expect(Object.keys(witness).toSorted()).toEqual([...SYSTEM_COLUMN_NAMES].toSorted());
	});
});
