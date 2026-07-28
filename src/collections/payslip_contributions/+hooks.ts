import { refuse } from '@norbital-ai/pod/authoring';
import type { Hooks } from './$types.js';

/** A statutory charge may only be removed while the run that produced it is still DRAFT. */
export default {
	delete: {
		before: async ({ existing, api }) => {
			const payslip = await api.db.query.payslips.findFirst({
				where: { norbital_id: { eq: existing.payslip_id } }
			});
			if (!payslip) {
				refuse('A payslip contribution cannot be deleted without its payslip.');
			}
			const run = await api.db.query.payroll_runs.findFirst({
				where: { norbital_id: { eq: payslip.payroll_run_id } }
			});
			if (!run) {
				refuse('A payslip contribution cannot be deleted without its payroll run.');
			}
			if (run.lifecycle !== 'DRAFT') {
				refuse(
					`Payroll run ${run.period} is ${run.lifecycle}. Payslip contributions can only be deleted while the run is DRAFT.`
				);
			}
		}
	}
} satisfies Hooks;
