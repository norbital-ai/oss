import { describe, expect, it } from 'vitest';
import { extractCollectionCatalog, extractRelationships } from '../../src/compiler/model-fields.js';

/**
 * `cascade(...)` used to be a wrapper the parser recognised and threw away.
 *
 * The relation pattern matched `(?:cascade\(\s*)?` — non-capturing — so the call was stripped,
 * nothing carried a flag, and every foreign key in every workspace was emitted `NO ACTION`. The
 * declaration read as meaningful and meant nothing: a payroll run could not be deleted once it had
 * written a payslip, which is the documented way to release the settlement locks it holds over
 * attendance, entries and leave.
 */
const source = `
export default defineRelationships((r) => ({
	payroll_runs: {
		payslips: r.many.payslips()
	},
	payslips: {
		run: cascade(r.one.payroll_runs({ from: r.payslips.payroll_run_id, to: r.payroll_runs.id })),
		employment: r.one.employments({ from: r.payslips.employment_id, to: r.employments.id })
	}
}));
`;

describe('cascade relations', () => {
	const relations = extractRelationships(source);

	it('carries the wrapper onto the relation it wraps', () => {
		const run = relations.find(({ name }) => name === 'run');
		expect(run?.cascade).toBe(true);
		expect(run?.target).toBe('payroll_runs');
		expect(run?.from).toEqual({ collection: 'payslips', column: 'payroll_run_id' });
	});

	it('leaves an unwrapped relation alone, so the default stays NO ACTION', () => {
		const employment = relations.find(({ name }) => name === 'employment');
		expect(employment?.cascade).toBeUndefined();
		expect(employment?.target).toBe('employments');
	});

	it('carries inverse ownership onto the parent many edge and generated catalog', () => {
		const payslips = relations.find(
			({ source: owner, name }) => owner === 'payroll_runs' && name === 'payslips'
		);
		expect(payslips).toMatchObject({
			cascade: true,
			from: { collection: 'payslips', column: 'payroll_run_id' },
			to: { collection: 'payroll_runs', column: 'id' }
		});

		const catalog = extractCollectionCatalog('payroll_runs', '', relations);
		expect(catalog.relationships).toContainEqual({
			name: 'payslips',
			target: 'payslips',
			cardinality: 'many',
			cascade: true
		});
	});

	it('uses the owning child edge for a foreign-key field catalog', () => {
		const catalog = extractCollectionCatalog(
			'payslips',
			`export default defineModel({
	payroll_run_id: uuid().notNull()
});`,
			relations
		);
		expect(catalog.fields[0]?.relation).toEqual({
			name: 'run',
			target: 'payroll_runs',
			cardinality: 'one'
		});
	});

	it('reads both relations of the block, wrapper or not', () => {
		expect(relations.map(({ name }) => name).toSorted()).toEqual(['employment', 'payslips', 'run']);
	});
});
