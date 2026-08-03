/**
 * The payroll run's lifecycle, and the entry point that builds one.
 *
 * ```
 *  DRAFT ──mark paid──► PAID
 *    │
 *    └──── recalculate
 * ```
 *
 * The platform owns permissions, approval locks, request-change comments, and audit history. This
 * hook owns the payroll invariant: draft figures may be rebuilt; paid figures are immutable and
 * later corrections arrive as adjustment entries in a future draft.
 *
 * Creating a run resolves its window and its governing configuration first, because
 * `configuration_hash`, `pay_date`, `attendance_from` and `attendance_to` are what make a payslip
 * traceable to the law it was computed under — a run that had to be built before it could say what
 * it was built against would be unauditable. The build itself then runs after the record exists.
 */

import { refuse } from '@norbital-ai/pod/authoring';
import { z } from 'zod';
import type { Hooks } from './$types.js';
import { buildPayrollRun as runEngine, preparePayrollRun } from './lib/engine.js';
import type { PayrollApi } from './lib/api.js';
import { configurationSnapshot } from './lib/configuration.js';

/**
 * What a person actually chooses when creating a run: a company and a period. Everything else on the
 * record is derived below, so the generated create schema — which requires every non-nullable column,
 * `lifecycle` and the whole resolved window among them — would demand figures the caller has no way
 * to know and no business asserting.
 */
const createPayrollRunInput = z.object({
	company_id: z.string().uuid(),
	period: z
		.string()
		.regex(/^2026-(0[1-9]|1[0-2])$/, 'Payroll period must be January–December 2026.')
});

/** Columns the engine owns; a person may not edit them. */
const DERIVED_COLUMNS = [
	'company_id',
	'period',
	'configuration_hash',
	'configuration_snapshot',
	'pay_date',
	'attendance_from',
	'attendance_to'
] as const;

/**
 * Build (or rebuild) one company's payroll for one period.
 *
 * This is what a representation calls. The run record must already exist — `create.after` calls it
 * for a new run, and recalculating a draft calls it again. It is idempotent: the run's existing
 * results are cleared before the new ones are written.
 */
export async function buildPayrollRun(
	input: { readonly companyId: string; readonly period: string },
	api: PayrollApi
): Promise<{ payslipCount: number; lineCount: number }> {
	const run = await api.db.query.payroll_runs.findFirst({
		where: { company_id: { eq: input.companyId }, period: { eq: input.period } }
	});
	if (!run)
		refuse(
			`There is no payroll run for ${input.period}. Create the run first; building it is what ` +
				'creating it does.'
		);
	if (run.lifecycle === 'PAID')
		refuse(`Payroll ${input.period} is paid. A paid run is never re-run — correct it instead.`);
	const result = await runEngine({
		api,
		runId: run.norbital_id,
		companyId: input.companyId,
		period: input.period
	});
	return { payslipCount: result.payslipCount, lineCount: result.lineCount };
}

export default {
	create: {
		input: createPayrollRunInput,
		before: async ({ input, api }) => {
			const existing = await api.db.query.payroll_runs.findFirst({
				where: { company_id: { eq: input.company_id }, period: { eq: input.period } }
			});
			if (existing) {
				const lifecycle = existing.lifecycle;
				if (lifecycle == null) refuse(`Payroll ${input.period} already exists.`);
				refuse(
					`Payroll ${input.period} already exists (${lifecycle.toLowerCase()}). ` +
						'Open that run, or delete it first if it is still a draft.'
				);
			}
			const { window, configuration } = await preparePayrollRun({
				api,
				companyId: input.company_id,
				period: input.period
			});
			// The previous period must be settled before this one is calculated, so a year-to-date
			// figure can never be assembled from a period that is still moving.
			const previous = await api.db.query.payroll_runs.findMany({
				where: { company_id: { eq: input.company_id }, period: { lt: input.period } },
				limit: 1000
			});
			const unsettled = previous
				.toSorted((left, right) => right.period.localeCompare(left.period))
				.find((run) => run.lifecycle === 'DRAFT');
			if (unsettled)
				refuse(
					`Payroll ${unsettled.period} is still a draft. Settle it before calculating ${input.period}: ` +
						'its figures are this period’s year-to-date.'
				);
			return {
				...input,
				lifecycle: 'DRAFT' as const,
				configuration_hash: configuration.hash,
				configuration_snapshot: {
					kind: 'CAPTURED' as const,
					configuration_hash: configuration.hash,
					configuration: configurationSnapshot(configuration, input.period)
				},
				pay_date: window.payDate,
				attendance_from: window.attendance.start,
				attendance_to: window.attendance.end
			};
		},
		after: async ({ record, api }) => {
			await runEngine({
				api,
				runId: record.norbital_id,
				companyId: record.company_id,
				period: record.period
			});
		}
	},

	update: {
		before: async ({ input, existing, api }) => {
			for (const column of DERIVED_COLUMNS)
				if (input[column] != null && String(input[column]) !== String(existing[column]))
					refuse(
						`Payroll run ${column} is derived from the period and the configuration, and cannot be edited.`
					);
			const next = input.lifecycle ?? existing.lifecycle;
			if (next === existing.lifecycle) {
				if (next !== 'DRAFT') return input;
				const { window, configuration } = await preparePayrollRun({
					api,
					companyId: existing.company_id,
					period: existing.period
				});
				return {
					...input,
					configuration_hash: configuration.hash,
					configuration_snapshot: {
						kind: 'CAPTURED' as const,
						configuration_hash: configuration.hash,
						configuration: configurationSnapshot(configuration, existing.period)
					},
					pay_date: window.payDate,
					attendance_from: window.attendance.start,
					attendance_to: window.attendance.end
				};
			}
			if (existing.lifecycle === 'PAID')
				refuse('A paid payroll run is immutable. Correct it with a later adjustment entry.');
			return input;
		},
		after: async ({ record, api }) => {
			// A same-state DRAFT update is the explicit recalculation action after source entries
			// change. The platform carries the approval/revision context; payroll only rebuilds.
			if (record.lifecycle !== 'DRAFT') return;
			await runEngine({
				api,
				runId: record.norbital_id,
				companyId: record.company_id,
				period: record.period
			});
		}
	},

	delete: {
		before: async ({ existing }) => {
			if (existing.lifecycle !== 'DRAFT')
				refuse(
					`Payroll run ${existing.period} is ${existing.lifecycle}. Only a draft run can be deleted.`
				);
		}
	}
} satisfies Hooks;
