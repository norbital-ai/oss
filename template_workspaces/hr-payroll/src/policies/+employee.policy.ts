import {
	claimApproval,
	employeeReferenceGrants,
	leaveApproval,
	statutoryGrants,
	timeEntryApproval
} from '../lib/policy_grants.js';
import type { Policy } from './$types.js';

/**
 * Self-service: an employee's own record and nothing else, 26 grants.
 *
 * The scope root here is `${requestor.email}`, not `${requestor.norbital_id}`. That is the seed's
 * choice and it is kept: an `employees` row is HR data with its own lifecycle and is not the same
 * object as a platform user, so there is no user id on it to match. The join is by address, folded on
 * both sides — `lower(p."email") = lower(${requestor.email})` — because HR imports and identity
 * providers disagree about case constantly and an exact match would show an employee an empty
 * workspace with no error.
 *
 * `${requestor.email}` is not interpolated by JavaScript: these are single-quoted strings, so the
 * literal token reaches jsonb and the policy compiler binds it as a positional parameter on every
 * request. An unknown scope path throws rather than binding null.
 *
 * `$sql`, never `RAW`. `RAW` is a function, a grant is stored as jsonb, and a dropped function leaves
 * `conditions: {}` — which the guard reads as *unconditional*. On this policy that would hand every
 * employee the whole payroll.
 */

/** Their own `employees` row. The one grant that matches on the collection's own column. */
const ownEmployeeRecord = { email: '${requestor.email}' } as const;

/** Employment rows belonging to their own employee record. */
const ownEmployment = {
	$sql:
		'"employee_id" IN (SELECT p."norbital_id" FROM "employees" p ' +
		'WHERE lower(p."email") = lower(${requestor.email}))'
} as const;

/**
 * Anything hanging off one of their own employments: terms, statutory facts, roster, loans, ledger,
 * payslips, component entries, time entries, leave requests. All nine carry `employment_id`, so one
 * subquery covers them.
 */
const ownEmploymentChild = {
	$sql:
		'"employment_id" IN (SELECT e."norbital_id" FROM "employments" e ' +
		'JOIN "employees" p ON p."norbital_id" = e."employee_id" ' +
		'WHERE lower(p."email") = lower(${requestor.email}))'
} as const;

/**
 * A claim is a `component_entries` row distinguished only by its `origin` variant — the table also
 * holds entries HR posts directly. Leave has no such discriminator because a leave request *is*
 * `leave_requests`, which is why the leave create grant below reuses `ownEmploymentChild` unchanged.
 *
 * The variant test matters on a create: without it this grant would let an employee post any
 * component entry against their own employment, including one HR alone is meant to raise.
 */
const ownClaim = {
	$sql:
		'"employment_id" IN (SELECT e."norbital_id" FROM "employments" e ' +
		'JOIN "employees" p ON p."norbital_id" = e."employee_id" ' +
		'WHERE lower(p."email") = lower(${requestor.email})) ' +
		`AND "origin"->>'kind' = 'CLAIM'`
} as const;

export default {
	name: 'Employee',
	description: 'Employee self-service access to profile, time, requests, loans, and payslips.',
	apps: ['hr_employee'],
	grants: [
		{ collection: 'employees', action: 'read', where: ownEmployeeRecord },
		{ collection: 'employments', action: 'read', where: ownEmployment },

		{ collection: 'employment_terms', action: 'read', where: ownEmploymentChild },
		{ collection: 'employment_statutory_facts', action: 'read', where: ownEmploymentChild },
		{ collection: 'roster_entries', action: 'read', where: ownEmploymentChild },
		{ collection: 'repayment_agreements', action: 'read', where: ownEmploymentChild },
		{ collection: 'leave_ledger', action: 'read', where: ownEmploymentChild },
		{ collection: 'payslips', action: 'read', where: ownEmploymentChild },
		{ collection: 'component_entries', action: 'read', where: ownEmploymentChild },
		{ collection: 'time_entries', action: 'read', where: ownEmploymentChild },
		{ collection: 'leave_requests', action: 'read', where: ownEmploymentChild },

		{
			collection: 'time_entries',
			action: 'create',
			where: ownEmploymentChild,
			approval: timeEntryApproval('019efa4b-b947-755a-990e-53c8da7b855f')
		},
		{
			collection: 'component_entries',
			action: 'create',
			where: ownClaim,
			approval: claimApproval('019efa4b-b947-755a-990e-53c8da7b855e')
		},
		{
			collection: 'leave_requests',
			action: 'create',
			where: ownEmploymentChild,
			approval: leaveApproval('019efa4b-b947-755a-990e-53c8da7b856e')
		},

		// Reference data an employee needs to read their own numbers. Unconditional, and correctly so:
		// a holiday calendar and a leave type are company-wide facts, not personal records.
		...employeeReferenceGrants('read'),
		...statutoryGrants('read')
	]
} satisfies Policy;
