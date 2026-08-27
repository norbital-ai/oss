import { describe, expect, it } from 'vitest';
import type { CollectionHooks, CreateGraph } from '../../src/authoring/contracts-schema.js';

/**
 * That a nested write is checked at compile time, not discovered at run time.
 *
 * These assertions are the test. Every `@ts-expect-error` below fails `tsc -p tests/tsconfig.json`
 * — which `pnpm lint` runs — the moment the type stops rejecting the shape it names, and the file
 * stops compiling at all if the type starts rejecting a shape it should admit. The runtime
 * assertion at the bottom exists only so the suite has something to run.
 *
 * The schema is written by hand rather than generated, because what is under test is the type the
 * compiler emits *into*: `tables`, `relations` keyed by collection then by declared relation name,
 * and `inputs`. `renderRelationTypes` in `compiler/sync.ts` produces exactly this shape.
 */
interface TestSchema {
	readonly tables: {
		readonly payroll_runs: {
			$inferSelect: { id: string; company_id: string; period: string };
			$inferInsert: { company_id: string; period: string; configuration_hash?: string };
		};
		readonly payslips: {
			$inferSelect: { id: string; payroll_run_id: string; gross: number };
			$inferInsert: { payroll_run_id: string; employment_id: string; gross: number };
		};
		readonly payslip_lines: {
			$inferSelect: { id: string; payslip_id: string; amount: number };
			$inferInsert: { payslip_id: string; amount: number };
		};
		readonly companies: {
			$inferSelect: { id: string; name: string };
			$inferInsert: { name: string };
		};
	};
	readonly relations: {
		readonly payroll_runs: {
			readonly payslip_payroll_run: {
				readonly target: 'payslips';
				readonly cardinality: 'many';
				readonly column: 'payroll_run_id';
			};
			// A `one` relation points at a parent that must already exist. Not expandable.
			readonly payroll_run_company: {
				readonly target: 'companies';
				readonly cardinality: 'one';
				readonly column: 'company_id';
			};
		};
		readonly payslips: {
			readonly payslip_line_payslip: {
				readonly target: 'payslip_lines';
				readonly cardinality: 'many';
				readonly column: 'payslip_id';
			};
		};
	};
}

type RunGraph = CreateGraph<TestSchema, 'payroll_runs'>;

/** Columns alone: no expansion is required of anyone. */
const flat: RunGraph = { company_id: 'c', period: '2026-08' };

/** One level, keyed by the declared relation name — the same name `with:` takes. */
const nested: RunGraph = {
	company_id: 'c',
	period: '2026-08',
	payslip_payroll_run: [{ employment_id: 'e', gross: 100 }]
};

/** Three levels. Depth is the author's choice and each level is checked. */
const deep: RunGraph = {
	company_id: 'c',
	period: '2026-08',
	payslip_payroll_run: [{ employment_id: 'e', gross: 100, payslip_line_payslip: [{ amount: 25 }] }]
};

/** A misspelled relation name is not a free-form key. */
// @ts-expect-error — `payslip_payroll_runs` is not a declared relation of payroll_runs
const typo: RunGraph = { company_id: 'c', period: '2026-08', payslip_payroll_runs: [] };

/** A `many` relation expands as an array, never as one record. */
// @ts-expect-error — a many relation is a list
const notAnArray: RunGraph = { company_id: 'c', period: '2026-08', payslip_payroll_run: {} };

/** A child is typed as its own collection's insert, not as anything. */
// prettier-ignore
// @ts-expect-error — `gross` is a number on payslips
const wrongChildColumn: RunGraph = { company_id: 'c', period: '2026-08', payslip_payroll_run: [{ employment_id: 'e', gross: 'lots' }] };

/** The runtime fills the child's foreign key from the parent. The author may not claim it. */
// prettier-ignore
// @ts-expect-error — payroll_run_id is omitted from the child insert
const writesTheForeignKey: RunGraph = { company_id: 'c', period: '2026-08', payslip_payroll_run: [{ payroll_run_id: 'r', employment_id: 'e', gross: 100 }] };

/** A `one` relation is not a nested write: its target has to exist already. */
// prettier-ignore
// @ts-expect-error — payroll_run_company is cardinality 'one'
const expandsAOneRelation: RunGraph = { company_id: 'c', period: '2026-08', payroll_run_company: [{ name: 'Acme' }] };

/** And the same rules hold through the hook that returns one, which is the point. */
const hooks: CollectionHooks<TestSchema, 'payroll_runs'> = {
	create: {
		perRecord: {
			before: {
				description: 'Builds a run and its payslips.',
				handler: ({ input }) => ({
					company_id: input.company_id,
					period: input.period,
					payslip_payroll_run: [{ employment_id: 'e', gross: 1 }]
				})
			}
		}
	}
};

describe('the nested write graph', () => {
	it('admits the shapes above and rejects the ones marked, at compile time', () => {
		expect([
			flat,
			nested,
			deep,
			typo,
			notAnArray,
			wrongChildColumn,
			writesTheForeignKey,
			expandsAOneRelation,
			hooks
		]).toHaveLength(9);
	});
});
