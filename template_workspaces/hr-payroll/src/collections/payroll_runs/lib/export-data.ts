/**
 * Loading a settled run back out for export.
 *
 * The workbook, the bank file and the payslips are all views of the same four collections. This
 * assembles that view once, so the three artefacts never disagree with each other.
 */

import type { PayrollReadApi } from './api.js';
import { PAGE_LIMIT, assertComplete, groupBy } from './api.js';
import { requiredDateKey } from './dates.js';
import { coversDate } from './effective.js';
import type { ReportLine, ReportPayslip } from './report.js';

export type RunExport = {
	readonly runId: string;
	readonly period: string;
	readonly payDate: string;
	readonly payslips: readonly ReportPayslip[];
	readonly bank: readonly BankDestination[];
	/** Employments whose payslip has no bank destination and is therefore not in the bank file. */
	readonly skippedEmploymentIds: readonly string[];
};

export type BankDestination = {
	readonly employmentId: string;
	readonly employeeNumber: string;
	readonly currency: string;
	readonly net: number;
	readonly bank: {
		readonly account_name: string;
		readonly bank_code: string;
		readonly bank_name: string;
		readonly account_number: string;
	};
};

type RunRow = {
	readonly norbital_id: string;
	readonly period: string;
	readonly pay_date: string | Date;
	readonly attendance_from: string | Date;
	readonly attendance_to: string | Date;
};

function timestampHours(
	row: { readonly clock_in: string | Date | null; readonly clock_out: string | Date | null },
	breakMinutes: number
): number {
	if (row.clock_in == null || row.clock_out == null) return 0;
	const elapsed = new Date(row.clock_out).getTime() - new Date(row.clock_in).getTime();
	if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
	return Math.max(0, elapsed / 3_600_000 - breakMinutes / 60);
}

function clockMinutes(value: string): number {
	const [hours, minutes] = value.split(':').map(Number);
	if (!Number.isFinite(hours) || !Number.isFinite(minutes))
		throw new Error(`Shift clock ${JSON.stringify(value)} is invalid.`);
	return hours! * 60 + minutes!;
}

function shiftHours(shift: {
	readonly start_time: string;
	readonly end_time: string;
	readonly break_minutes: number;
	readonly crosses_midnight: boolean;
}): number {
	const start = clockMinutes(shift.start_time);
	let end = clockMinutes(shift.end_time);
	if (shift.crosses_midnight || end < start) end += 24 * 60;
	return Math.max(0, (end - start - Number(shift.break_minutes)) / 60);
}

export async function loadRunExports(
	api: PayrollReadApi,
	runs: readonly RunRow[]
): Promise<RunExport[]> {
	const runIds = runs.map((run) => run.norbital_id);
	if (runIds.length === 0) return [];

	const payslips = await api.db.query.payslips.findMany({
		where: { payroll_run_id: { in: runIds } },
		limit: PAGE_LIMIT
	});
	assertComplete(payslips, 'payslips');
	if (payslips.length === 0)
		return runs.map((run) => ({
			runId: run.norbital_id,
			period: run.period,
			payDate: requiredDateKey(run.pay_date, 'payroll_runs.pay_date'),
			payslips: [],
			bank: [],
			skippedEmploymentIds: []
		}));

	const payslipIds = payslips.map((row) => row.norbital_id);
	const employmentIds = [...new Set(payslips.map((row) => row.employment_id))];
	const attendanceFrom = runs
		.map((run) => requiredDateKey(run.attendance_from, 'payroll_runs.attendance_from'))
		.toSorted()[0]!;
	const attendanceTo = runs
		.map((run) => requiredDateKey(run.attendance_to, 'payroll_runs.attendance_to'))
		.toSorted()
		.at(-1)!;
	const [lines, charges, employments, componentTypes, payComponents, terms, timeEntries, rosters] =
		await Promise.all([
			api.db.query.payslip_lines.findMany({
				where: { payslip_id: { in: payslipIds } },
				limit: PAGE_LIMIT
			}),
			api.db.query.payslip_contributions.findMany({
				where: { payslip_id: { in: payslipIds } },
				limit: PAGE_LIMIT
			}),
			api.db.query.employments.findMany({
				where: { norbital_id: { in: employmentIds } },
				limit: PAGE_LIMIT
			}),
			api.db.query.component_types.findMany({ limit: PAGE_LIMIT }),
			api.db.query.pay_components.findMany({ limit: PAGE_LIMIT }),
			api.db.query.employment_terms.findMany({
				where: { employment_id: { in: employmentIds } },
				limit: PAGE_LIMIT
			}),
			api.db.query.time_entries.findMany({
				where: {
					employment_id: { in: employmentIds },
					work_date: { gte: attendanceFrom, lte: attendanceTo }
				},
				limit: PAGE_LIMIT
			}),
			api.db.query.roster_entries.findMany({
				where: {
					employment_id: { in: employmentIds },
					work_date: { gte: attendanceFrom, lte: attendanceTo }
				},
				limit: PAGE_LIMIT
			})
		]);
	assertComplete(lines, 'payslip lines');
	assertComplete(terms, 'employment terms');
	assertComplete(timeEntries, 'time entries');
	assertComplete(rosters, 'roster entries');

	const employeeIds = [...new Set(employments.map((row) => row.employee_id))];
	const shiftIds = [...new Set(rosters.map((row) => row.shift_definition_id))];
	const [employees, shifts] = await Promise.all([
		api.db.query.employees.findMany({
			where: { norbital_id: { in: employeeIds } },
			limit: PAGE_LIMIT
		}),
		shiftIds.length
			? api.db.query.shift_definitions.findMany({
					where: { norbital_id: { in: shiftIds } },
					limit: PAGE_LIMIT
				})
			: []
	]);
	assertComplete(employees, 'employees');
	assertComplete(shifts, 'shift definitions');

	const contributionIds = [...new Set(charges.map((row) => row.statutory_contribution_id))];
	const contributions = contributionIds.length
		? await api.db.query.statutory_contributions.findMany({
				where: { norbital_id: { in: contributionIds } },
				limit: PAGE_LIMIT
			})
		: [];

	const typeById = new Map(componentTypes.map((row) => [row.norbital_id, row]));
	const componentById = new Map(payComponents.map((row) => [row.norbital_id, row]));
	const employmentById = new Map(employments.map((row) => [row.norbital_id, row]));
	const employeeById = new Map(employees.map((row) => [row.norbital_id, row]));
	const termsByEmployment = groupBy(terms, (row) => row.employment_id);
	const timeByEmployment = groupBy(timeEntries, (row) => row.employment_id);
	const rosterByEmployment = groupBy(rosters, (row) => row.employment_id);
	const shiftById = new Map(shifts.map((row) => [row.norbital_id, row]));
	const contributionCodeById = new Map(contributions.map((row) => [row.norbital_id, row.code]));
	const linesByPayslip = groupBy(lines, (row) => row.payslip_id);
	const chargesByPayslip = groupBy(charges, (row) => row.payslip_id);
	const payslipsByRun = groupBy(payslips, (row) => row.payroll_run_id);

	return runs.map((run) => {
		const runPayslips = payslipsByRun.get(run.norbital_id) ?? [];
		const runAttendanceFrom = requiredDateKey(run.attendance_from, 'payroll_runs.attendance_from');
		const runAttendanceTo = requiredDateKey(run.attendance_to, 'payroll_runs.attendance_to');
		const runPayDate = requiredDateKey(run.pay_date, 'payroll_runs.pay_date');
		const skipped: string[] = [];
		const bank: BankDestination[] = [];
		const report: ReportPayslip[] = runPayslips.map((payslip) => {
			const employment = employmentById.get(payslip.employment_id);
			const employeeNumber = employment?.employee_number ?? payslip.employment_id;
			const employee = employment == null ? null : employeeById.get(employment.employee_id);
			const activeTerms = (termsByEmployment.get(payslip.employment_id) ?? []).find((row) =>
				coversDate(row.effective_range, runPayDate)
			);
			const runRosters = (rosterByEmployment.get(payslip.employment_id) ?? []).filter(
				(row) => row.work_date >= runAttendanceFrom && row.work_date <= runAttendanceTo
			);
			const runTimes = (timeByEmployment.get(payslip.employment_id) ?? []).filter(
				(row) => row.work_date >= runAttendanceFrom && row.work_date <= runAttendanceTo
			);
			const account = employment?.bank;
			if (account == null) skipped.push(payslip.employment_id);
			else
				bank.push({
					employmentId: payslip.employment_id,
					employeeNumber,
					currency: payslip.currency,
					net: Number(payslip.net),
					bank: {
						account_name: account.bank_account_name,
						bank_code: account.bank_code,
						bank_name: account.bank_name,
						account_number: account.bank_account_number
					}
				});
			const reportLines: ReportLine[] = (linesByPayslip.get(payslip.norbital_id) ?? [])
				.toSorted((left, right) => Number(left.sequence) - Number(right.sequence))
				.map((line) => {
					const type = typeById.get(line.component_type_id);
					const definition = componentById.get(line.pay_component_id)?.definition ?? null;
					const overtimeDayType =
						definition != null &&
						(definition.source === 'OVERTIME' || definition.source === 'OVERTIME_EXCESS')
							? definition.rule.day_type
							: null;
					return {
						payComponentCode: componentById.get(line.pay_component_id)?.code ?? 'UNKNOWN',
						componentTypeCode: type?.code ?? 'UNKNOWN',
						nature: type?.nature ?? 'INFORMATION',
						amount: Number(line.amount),
						quantity: line.quantity == null ? null : Number(line.quantity),
						isCompanyDirect:
							definition?.source === 'ENTRY' && definition.settlement === 'COMPANY_DIRECT',
						isClaim: definition?.source === 'ENTRY' && definition.cap != null,
						overtimeDayType,
						isOvertimeExcess: definition?.source === 'OVERTIME_EXCESS'
					};
				});
			return {
				employmentId: payslip.employment_id,
				employeeNumber,
				currency: payslip.currency,
				designation: activeTerms?.job_title ?? null,
				section: activeTerms?.department ?? null,
				group: activeTerms?.payroll_group ?? null,
				employeeName: employee?.name ?? employeeNumber,
				identityNumber: employee?.identity_number ?? null,
				hireDate:
					employment == null ? '' : requiredDateKey(employment.hire_date, 'employments.hire_date'),
				lastDay:
					employment?.exit_date == null
						? null
						: requiredDateKey(employment.exit_date, 'employments.exit_date'),
				attendance: {
					normalHours: runRosters.reduce((total, roster) => {
						if (roster.designation !== 'WORK') return total;
						const shift = shiftById.get(roster.shift_definition_id);
						return total + (shift == null ? 0 : shiftHours(shift));
					}, 0),
					actualHours: runTimes.reduce(
						(total, row) => total + timestampHours(row, Number(row.break_minutes)),
						0
					),
					shiftCodes: [
						...new Set(
							runRosters.flatMap((row) => {
								if (row.assignment_code != null) return [row.assignment_code];
								const shift = shiftById.get(row.shift_definition_id);
								return shift == null ? [] : [shift.code];
							})
						)
					].toSorted()
				},
				gross: Number(payslip.gross),
				totalDeductions: Number(payslip.total_deductions),
				net: Number(payslip.net),
				employerCost: Number(payslip.employer_cost),
				lines: reportLines,
				contributions: new Map(
					(chargesByPayslip.get(payslip.norbital_id) ?? []).flatMap((charge) => {
						const code = contributionCodeById.get(charge.statutory_contribution_id);
						if (code == null) return [];
						return [
							[
								code,
								{
									base: Number(charge.base_amount),
									employee: Number(charge.employee_amount),
									employer: Number(charge.employer_amount)
								}
							] as const
						];
					})
				)
			};
		});
		return {
			runId: run.norbital_id,
			period: run.period,
			payDate: runPayDate,
			payslips: report,
			bank,
			skippedEmploymentIds: skipped
		};
	});
}
