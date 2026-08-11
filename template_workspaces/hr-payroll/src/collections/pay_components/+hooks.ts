import { assertNoOverlap } from '../../lib/effective_range.js';
import type { Hooks } from './$types.js';

/**
 * Exclusion key (plan 02 §7): company =, code =, effective range &&.
 * A catalogue change is an end-date plus a successor row, never an overlapping duplicate.
 *
 * The database is the guarantee — `pay_components_no_overlap` in +model.ts rejects an overlap with
 * SQLSTATE 23P01 whatever path the write takes, including a concurrent one. This hook is the
 * message: it fails first and names the row and the clash instead of raising a raw constraint
 * violation.
 */
export default {
	create: {
		before: {
			description:
				'Refuses a pay component whose effective range overlaps another component with the same code in the same company, so a payslip line can only ever resolve one definition for that code.',
			handler: async ({ input, api }) => {
				const existing = await api.db.query.pay_components.findMany({
					where: { company_id: { eq: input.company_id }, code: { eq: input.code } }
				});
				assertNoOverlap({
					candidate: input.effective_range,
					existing,
					identity: `pay component ${input.code}`
				});
				return input;
			}
		}
	},
	update: {
		before: {
			description:
				'Re-checks an edited pay component so a catalogue change becomes an end-date plus a successor row rather than two versions of one code in force at once.',
			handler: async ({ input, existing, api }) => {
				const company_id = input.company_id ?? existing.company_id;
				const code = input.code ?? existing.code;
				const effective_range = input.effective_range ?? existing.effective_range;
				const siblings = await api.db.query.pay_components.findMany({
					where: { company_id: { eq: company_id }, code: { eq: code } }
				});
				assertNoOverlap({
					candidate: effective_range,
					existing: siblings,
					identity: `pay component ${code}`,
					excludeId: existing.norbital_id
				});
				return input;
			}
		}
	}
} satisfies Hooks;
