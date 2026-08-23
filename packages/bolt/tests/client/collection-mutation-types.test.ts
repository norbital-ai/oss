import { describe, expect, it } from 'vitest';
import { defineModel, text } from '../../src/authoring/index.js';
import type { TablesForModels } from '../../src/authoring/internals.js';
import type { CollectionMutationValues } from '../../src/client/runtime.js';

interface TestSchema {
	readonly tables: {
		readonly payroll_runs: {
			readonly $inferSelect: {
				readonly id: string;
				readonly company_id: string;
				readonly period: string;
				readonly created_at: string;
				readonly updated_at: string;
				readonly sys_period: string;
				readonly row_version: number;
				readonly approval_id: string | null;
			};
			readonly $inferInsert: { readonly company_id: string; readonly period: string };
		};
		readonly payslips: {
			readonly $inferSelect: {
				readonly id: string;
				readonly payroll_run_id: string;
				readonly gross: number;
			};
			readonly $inferInsert: {
				readonly payroll_run_id: string;
				readonly employment_id: string;
				readonly gross: number;
			};
		};
		readonly payslip_lines: {
			readonly $inferSelect: {
				readonly id: string;
				readonly payslip_id: string;
				readonly amount: number;
			};
			readonly $inferInsert: { readonly payslip_id: string; readonly amount: number };
		};
		readonly companies: {
			readonly $inferSelect: { readonly id: string; readonly name: string };
			readonly $inferInsert: { readonly name: string };
		};
	};
	readonly relations: {
		readonly payroll_runs: {
			readonly payslip_payroll_run: {
				readonly target: 'payslips';
				readonly cardinality: 'many';
				readonly column: 'payroll_run_id';
				readonly parentColumn: 'id';
			};
			readonly unresolved_payslips: {
				readonly target: 'payslips';
				readonly cardinality: 'many';
				readonly column: never;
				readonly parentColumn: never;
			};
			readonly payslips_by_company: {
				readonly target: 'payslips';
				readonly cardinality: 'many';
				readonly column: 'payroll_run_id';
				readonly parentColumn: 'company_id';
			};
			readonly payroll_run_company: {
				readonly target: 'companies';
				readonly cardinality: 'one';
				readonly column: 'company_id';
				readonly parentColumn: 'id';
			};
		};
		readonly payslips: {
			readonly payslip_line_payslip: {
				readonly target: 'payslip_lines';
				readonly cardinality: 'many';
				readonly column: 'payslip_id';
				readonly parentColumn: 'id';
			};
		};
	};
}

type RunMutation = CollectionMutationValues<TestSchema, 'payroll_runs'>;

const actualModels = {
	orders: defineModel({ reference: text().notNull() })
};
interface ActualCompiledSchema {
	readonly tables: TablesForModels<typeof actualModels>;
	readonly relations: Readonly<Record<never, never>>;
}
type ActualOrderMutation = CollectionMutationValues<ActualCompiledSchema, 'orders'>;

const actualCompiledUpdate: ActualOrderMutation = { id: 'order-1', reference: 'ORD-2' };
// @ts-expect-error — actual TablesForModels system creation timestamp is never writable
const actualWritesCreatedAt: ActualOrderMutation = { id: 'order-1', created_at: new Date() };
// @ts-expect-error — actual TablesForModels system update timestamp is never writable
const actualWritesUpdatedAt: ActualOrderMutation = { id: 'order-1', updated_at: new Date() };
// @ts-expect-error — actual TablesForModels history period is never writable
const actualWritesSysPeriod: ActualOrderMutation = { id: 'order-1', sys_period: '[2026-08-01,)' };
// @ts-expect-error — actual TablesForModels row version is never writable
const actualWritesRowVersion: ActualOrderMutation = { id: 'order-1', row_version: 2 };
// @ts-expect-error — actual TablesForModels approval id is never writable
const actualWritesApprovalId: ActualOrderMutation = { id: 'order-1', approval_id: 'approval-1' };

const inserted: RunMutation = {
	company_id: 'company-1',
	period: '2026-08',
	payslip_payroll_run: [
		{
			employment_id: 'employment-1',
			gross: 100,
			payslip_line_payslip: [{ amount: 25 }]
		}
	]
};

const synchronized: RunMutation = {
	id: 'run-1',
	payslip_payroll_run: [
		{ id: 'payslip-1', gross: 110, payslip_line_payslip: [{ id: 'line-1', amount: 30 }] },
		{ employment_id: 'employment-2', gross: 90 }
	]
};

const untouchedRelationships: RunMutation = { id: 'run-1', period: '2026-09' };
const deleteEveryRelatedRow: RunMutation = { id: 'run-1', payslip_payroll_run: [] };

// @ts-expect-error — only declared many relationship names are mutation keys
const misspelled: RunMutation = { id: 'run-1', payslips_payroll_run: [] };

// @ts-expect-error — a many relationship is its complete desired array, never one child
const notAnArray: RunMutation = { id: 'run-1', payslip_payroll_run: { id: 'payslip-1' } };

const claimsForeignKey: RunMutation = {
	id: 'run-1',
	// @ts-expect-error — the server derives a nested child's owning foreign key from the parent
	payslip_payroll_run: [{ id: 'payslip-1', payroll_run_id: 'another-run' }]
};

// @ts-expect-error — one relations point at existing parents and are not synchronized as children
const expandsOne: RunMutation = { id: 'run-1', payroll_run_company: [{ id: 'company-1' }] };

// @ts-expect-error — a new nested row retains all non-derived required insert fields
const incompleteInsert: RunMutation = { id: 'run-1', payslip_payroll_run: [{ gross: 10 }] };

// @ts-expect-error — endpointless or ambiguous many relations are not writable mutation keys
const unresolvedRelation: RunMutation = { id: 'run-1', unresolved_payslips: [] };

// @ts-expect-error — the synchronizer supports parent id joins only
const unsupportedParentJoin: RunMutation = { id: 'run-1', payslips_by_company: [] };

// @ts-expect-error — system creation timestamps are read-only
const writesCreatedAt: RunMutation = { id: 'run-1', created_at: '2026-08-01T00:00:00Z' };

// @ts-expect-error — system update timestamps are read-only
const writesUpdatedAt: RunMutation = { id: 'run-1', updated_at: '2026-08-01T00:00:00Z' };

// @ts-expect-error — temporal history periods are read-only
const writesSysPeriod: RunMutation = { id: 'run-1', sys_period: '[2026-08-01,)' };

// @ts-expect-error — optimistic row versions are read-only
const writesRowVersion: RunMutation = { id: 'run-1', row_version: 2 };

// @ts-expect-error — approval ownership is managed by the mutation pipeline
const writesApprovalId: RunMutation = { id: 'run-1', approval_id: 'approval-1' };

const nestedSystemColumn: RunMutation = {
	id: 'run-1',
	// @ts-expect-error — system columns are excluded recursively, not only on the root
	payslip_payroll_run: [{ id: 'payslip-1', created_at: '2026-08-01T00:00:00Z' }]
};

describe('collection mutation graph types', () => {
	it('accepts insert, update, omission, and explicit empty synchronization shapes', () => {
		expect([
			inserted,
			synchronized,
			untouchedRelationships,
			deleteEveryRelatedRow,
			misspelled,
			notAnArray,
			claimsForeignKey,
			expandsOne,
			incompleteInsert,
			unresolvedRelation,
			unsupportedParentJoin,
			writesCreatedAt,
			writesUpdatedAt,
			writesSysPeriod,
			writesRowVersion,
			writesApprovalId,
			nestedSystemColumn,
			actualCompiledUpdate,
			actualWritesCreatedAt,
			actualWritesUpdatedAt,
			actualWritesSysPeriod,
			actualWritesRowVersion,
			actualWritesApprovalId
		]).toHaveLength(23);
	});
});
