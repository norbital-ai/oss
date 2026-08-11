/**
 * What a settled payroll run hands to the outside world.
 *
 * Three artefacts, each tagged with its `metadata.kind` so the app can route them:
 * `payroll-report-xlsx`, `bank-files`, `payslip-pdfs`.
 *
 * The workbook's column vocabulary lives in `lib/report.ts` — in the export path, never as a column
 * on a model. A pay component knows its code, its type and how it is measured; what a spreadsheet
 * calls the resulting number is presentation, and presentation does not belong on data.
 */

import type { Pipelines } from './$types.js';
import type { TExportManifest } from '@norbital-ai/pod/authoring';
import { loadRunExports } from './lib/export-data.js';

export default {
	export: {
		description:
			'Turns the selected payroll runs into the three artefacts a settled period hands out: a bank payment CSV, one PDF payslip per employee, and the payroll report workbook.',
		handler: async ({ records }, api) => {
			const { bankFileRows, payrollReportXlsx, payslipPdf } = await import('./lib/export.js');
			const exports = await loadRunExports(api, records);
			const actions: TExportManifest = [];

			for (const run of exports) {
				if (run.bank.length === 0 && run.skippedEmploymentIds.length === 0) continue;
				actions.push({
					label: `Bank file ${run.period}`,
					attachments: [
						{
							name: `bank_payments_${run.period}.csv`,
							contentType: 'CSV',
							content: bankFileRows(
								run.bank.map((payment) => ({
									...payment,
									payrollRunId: run.runId,
									paymentDate: run.payDate
								}))
							)
						}
					],
					metadata: {
						kind: 'bank-files',
						period: run.period,
						included_payslips: run.bank.length,
						skipped_payslips: run.skippedEmploymentIds.length,
						skipped_employment_ids: run.skippedEmploymentIds
					}
				});
			}

			for (const run of exports) {
				if (run.payslips.length === 0) continue;
				actions.push({
					label: `Payslips ${run.period}`,
					attachments: run.payslips.map((payslip) => ({
						name: `payslip_${run.period}_${payslip.employeeNumber}.pdf`,
						contentType: 'PDF',
						content: payslipPdf({
							period: run.period,
							payDate: run.payDate,
							payslip
						})
					})),
					metadata: { kind: 'payslip-pdfs', period: run.period }
				});
			}

			const sheets = exports.filter((run) => run.payslips.length > 0);
			if (sheets.length > 0) {
				const label = sheets.length === 1 ? sheets[0]!.period : `${sheets.length}_runs`;
				actions.push({
					label: 'Payroll workbook',
					attachments: [
						{
							name: `payroll_report_${label}.xlsx`,
							contentType: 'XLSX',
							content: await payrollReportXlsx(sheets)
						}
					],
					metadata: {
						kind: 'payroll-report-xlsx',
						periods: sheets.map((run) => run.period)
					}
				});
			}

			return actions;
		}
	}
} satisfies Pipelines;
