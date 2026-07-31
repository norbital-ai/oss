import type { Policy } from '../policies/$types.js';

/**
 * The collection groups and approval flows the three payroll policies are built from.
 *
 * This lives in `src/lib` rather than beside the policies because `src/policies` admits only
 * `+<name>.policy.ts` — anything else there is a `POLICY_NAME_INVALID` diagnostic, not a module.
 *
 * The grouping is kept, not flattened. Core's seed generated ~140 grants from four collection lists
 * crossed with action lists, and the lists are the statement: a company writes its own configuration
 * and only ever reads the law. Expanded to literal grants that distinction is unrecoverable — you
 * would have to diff two long lists to notice that `contribution_rates` has no `update` while
 * `pay_components` does.
 *
 * Each group is a **function over actions** rather than an array of names, and that shape is forced
 * rather than chosen. `PolicyGrant` is a distributed union that pairs each collection with its own
 * row type, so `{ collection: 'a' | 'b', action }` is assignable to neither member: TypeScript does
 * not push a union-typed discriminant through a union target. Mapping an array of names therefore
 * cannot typecheck without a cast, and a cast here would be exactly the wrong thing — it is the
 * pairing that stops a `where` from naming another collection's column. `grantsOn` takes **one**
 * collection as a literal generic, so every name below is still checked at its call site.
 */

type Grant = Policy['grants'][number];
type Action = Grant['action'];

/** Unconditional grants for one collection. The generic keeps `collection` a literal, so it checks. */
export function grantsOn<const C extends Grant['collection']>(
	collection: C,
	actions: readonly Action[]
) {
	return actions.map((action) => ({ collection, action }));
}

/**
 * Configuration a company reads and writes.
 *
 * `roster_entries` sits here rather than with people because a roster is scheduling configuration
 * that HR edits in bulk, even though an employee reads only their own rows out of it.
 */
export const referenceGrants = (...actions: Action[]): readonly Grant[] => [
	...grantsOn('companies', actions),
	...grantsOn('company_holidays', actions),
	...grantsOn('shift_definitions', actions),
	...grantsOn('roster_entries', actions),
	...grantsOn('pay_components', actions),
	...grantsOn('leave_types', actions),
	...grantsOn('accrual_bands', actions)
];

/**
 * Jurisdiction and global rows: readable by everyone who needs to explain a number, writable by none.
 *
 * Every caller passes `'read'` and that is the point — the law is stated once by product, and a
 * company may read across that boundary but never write across it.
 */
export const statutoryGrants = (...actions: Action[]): readonly Grant[] => [
	...grantsOn('jurisdictions', actions),
	...grantsOn('component_types', actions),
	...grantsOn('statutory_contributions', actions),
	...grantsOn('contribution_rates', actions),
	...grantsOn('contribution_treatments', actions),
	...grantsOn('overtime_rules', actions),
	...grantsOn('overtime_limits', actions)
];

/**
 * People records, excluding `time_entries`.
 *
 * `time_entries` is split out because no role writes it directly — every create and update is gated
 * behind the direct manager. Leaving it in the group and subtracting it at each call site is how the
 * seed did it, and it made the exception something you had to notice inside a `.filter()`.
 */
export const peopleGrants = (...actions: Action[]): readonly Grant[] => [
	...grantsOn('employees', actions),
	...grantsOn('employments', actions),
	...grantsOn('employment_terms', actions),
	...grantsOn('employment_statutory_facts', actions),
	...grantsOn('component_entries', actions),
	...grantsOn('repayment_agreements', actions),
	...grantsOn('leave_ledger', actions)
];

/** Payroll output. Read-only as a group; `payroll_runs` gets its writes stated separately. */
export const payrollGrants = (...actions: Action[]): readonly Grant[] => [
	...grantsOn('payroll_runs', actions),
	...grantsOn('payslips', actions),
	...grantsOn('payslip_lines', actions),
	...grantsOn('payslip_contributions', actions),
	...grantsOn('payslip_line_sources', actions)
];

/** What an employee may read to understand their own numbers: company-wide facts, not personal rows. */
export const employeeReferenceGrants = (...actions: Action[]): readonly Grant[] => [
	...grantsOn('companies', actions),
	...grantsOn('company_holidays', actions),
	...grantsOn('shift_definitions', actions),
	...grantsOn('pay_components', actions),
	...grantsOn('leave_types', actions)
];

/**
 * Teams the approval steps route to, named by `team.name`.
 *
 * These used to be `team.norbital_id` values carried over from Core's seed verbatim — private
 * identifiers from one database, sitting in a public template, checked by nothing and unsatisfiable
 * anywhere that seed had not run. A team is a runtime row, so its id cannot be declared; its name can.
 * Reconciliation binds the name to this tenant's id and refuses a name with no team behind it.
 *
 * The config and step **ids** are still carried verbatim, and that is a different thing: an in-flight
 * `approval_request` resolves against them, so a fresh one strands every request already raised.
 */
const HQ_PAYROLL_HR_TEAM = 'HQ Payroll HR';
const HR_MANAGER_TEAM = 'HR Manager';
const L1_MANAGER_TEAM = 'L1 Manager';

/** The approval shape, taken from the grant that holds it so there is nothing to keep in step. */
type Approval = NonNullable<Grant['approval']>;

/**
 * The seed derived each step id from its config id by replacing the last character with `9`. Kept, so
 * the ids a live `approval_request` already points at are the ids these configs still carry.
 */
function stepId(configId: string): string {
	return `${configId.slice(0, -1)}9`;
}

/** Attendance becomes a payroll source, so the direct manager sees it before it can become one. */
export function timeEntryApproval(configId: string): Approval {
	return {
		id: configId,
		name: 'Time entry approval',
		steps: [
			{
				id: stepId(configId),
				name: 'Direct manager review',
				approvers: [L1_MANAGER_TEAM],
				description:
					'The employee direct manager reviews attendance before it can become a payroll source.'
			}
		]
	};
}

/** Leave goes to the requester's direct manager. */
export function leaveApproval(configId: string): Approval {
	return {
		id: configId,
		name: 'Leave approval',
		steps: [
			{
				id: stepId(configId),
				name: 'Direct manager review',
				approvers: [L1_MANAGER_TEAM],
				description: 'The employee direct manager reviews the leave request.'
			}
		]
	};
}

/** A claim is money, so it skips the line manager and goes straight to HQ Payroll HR. */
export function claimApproval(configId: string): Approval {
	return {
		id: configId,
		name: 'Claim approval',
		steps: [
			{
				id: stepId(configId),
				name: 'HQ Payroll HR review',
				approvers: [HQ_PAYROLL_HR_TEAM],
				description: 'HQ Payroll HR performs the final claim review.'
			}
		]
	};
}

/** Opening a run commits every payslip under it, so an HR Manager reconciles it first. */
export function payrollRunApproval(configId: string): Approval {
	return {
		id: configId,
		name: 'Payroll run approval',
		steps: [
			{
				id: stepId(configId),
				name: 'HR Manager review',
				approvers: [HR_MANAGER_TEAM],
				description: 'An HR Manager reconciles the run before payslips become final.'
			}
		]
	};
}
