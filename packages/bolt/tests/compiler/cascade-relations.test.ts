import { describe, expect, it } from 'vitest';
import { extractRelationships } from '../../src/compiler/model-fields.js';

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

	it('reads both relations of the block, wrapper or not', () => {
		expect(relations.map(({ name }) => name).toSorted()).toEqual(['employment', 'run']);
	});
});
