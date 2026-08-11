import { refuse } from '@norbital-ai/pod/authoring';
import type { Hooks } from './$types.js';

/** A payslip line may only be removed while the run that produced it is still DRAFT. */
export default {
	delete: {
		before: {
			description:
				'Blocks removing a payslip line once the payroll run behind its payslip has left DRAFT, so a paid payslip keeps every line that made up its total.',
			handler: async ({ existing, api }) => {
				const payslip = await api.db.query.payslips.findFirst({
					where: { norbital_id: { eq: existing.payslip_id } }
				});
				if (!payslip) {
					refuse('A payslip line cannot be deleted without its payslip.');
				}
				const run = await api.db.query.payroll_runs.findFirst({
					where: { norbital_id: { eq: payslip.payroll_run_id } }
				});
				if (!run) {
					refuse('A payslip line cannot be deleted without its payroll run.');
				}
				if (run.lifecycle !== 'DRAFT') {
					refuse(
						`Payroll run ${run.period} is ${run.lifecycle}. Payslip lines can only be deleted while the run is DRAFT.`
					);
				}
			}
		}
	}
} satisfies Hooks;
