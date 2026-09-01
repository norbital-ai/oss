import { describe, expect, it } from 'vitest';
import type { PlatformRelationshipsFor } from '../../src/authoring/internals.js';
import { cascade, defineModel, uuid } from '../../src/authoring/index.js';
import {
	collectionCatalogEntry,
	compileWorkspaceAuthoring
} from '../../src/authoring/model-introspection.js';

const models = {
	payroll_runs: defineModel({ period_id: uuid() }),
	payslips: defineModel({ payroll_run_id: uuid().notNull(), employment_id: uuid().notNull() }),
	employments: defineModel({ employee_id: uuid() })
};

const relationships = ((r) => ({
	payroll_runs: { payslips: r.many.payslips() },
	payslips: {
		run: cascade(
			r.one.payroll_runs({ from: r.payslips.payroll_run_id, to: r.payroll_runs.id })
		),
		employment: r.one.employments({
			from: r.payslips.employment_id,
			to: r.employments.id
		})
	}
})) satisfies PlatformRelationshipsFor<typeof models>;

const compiled = compileWorkspaceAuthoring({
	models,
	sourcePaths: Object.fromEntries(
		Object.keys(models).map((name) => [name, `src/collections/${name}/+model.ts`])
	),
	relationships
});

describe('cascade relations', () => {
	it('carries the wrapper onto the relation it wraps', () => {
		const run = compiled.relationships.find(({ name }) => name === 'run');
		expect(run?.cascade).toBe(true);
		expect(run?.target).toBe('payroll_runs');
		expect(run?.from).toEqual({ collection: 'payslips', column: 'payroll_run_id' });
	});

	it('leaves an unwrapped relation alone, so the default stays NO ACTION', () => {
		const employment = compiled.relationships.find(({ name }) => name === 'employment');
		expect(employment?.cascade).toBeUndefined();
	});

	it('carries inverse ownership onto the parent many edge and generated catalog', () => {
		const parent = compiled.collections.find(({ name }) => name === 'payroll_runs');
		if (parent === undefined) throw new Error('payroll_runs did not compile');
		const catalog = collectionCatalogEntry(parent, compiled.relationships);

		expect(compiled.relationships.find(({ name }) => name === 'payslips')).toMatchObject({
			cascade: true,
			from: { collection: 'payroll_runs', column: 'id' },
			to: { collection: 'payslips', column: 'payroll_run_id' }
		});
		expect(catalog.relationships).toContainEqual({
			name: 'payslips',
			target: 'payslips',
			cardinality: 'many',
			cascade: true
		});
	});

	it('uses only the owning child edge for a foreign-key field catalog', () => {
		const child = compiled.collections.find(({ name }) => name === 'payslips');
		if (child === undefined) throw new Error('payslips did not compile');
		const catalog = collectionCatalogEntry(child, compiled.relationships);

		expect(catalog.fields.find(({ name }) => name === 'payroll_run_id')?.relation).toEqual({
			name: 'run',
			target: 'payroll_runs',
			cardinality: 'one'
		});
	});
});
