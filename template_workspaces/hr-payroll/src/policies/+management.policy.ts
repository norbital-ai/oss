import {
	grantsOn,
	leaveApproval,
	payrollGrants,
	payrollRunApproval,
	peopleGrants,
	referenceGrants,
	statutoryGrants,
	timeEntryApproval
} from '../lib/policy_grants.js';
import type { Policy } from './$types.js';

/**
 * A manager: reads everything HR reads, writes almost none of it. 35 grants.
 *
 * The same groups as `+hr.policy.ts`, crossed with `read` alone — including `referenceGrants`, which
 * HR writes. That single difference is the whole shape of the role: a manager has to see a shift
 * definition to explain a roster, and must not be able to change one.
 *
 * The exceptions are the two things a manager actually does — run payroll, and act on their reports'
 * time and leave. Each carries its own approval config with its own id, distinct from HR's. The same
 * flow reached by a different role is a different config row, and collapsing them would make an
 * HR-raised run indistinguishable from a manager-raised one in the approval history.
 */
export default {
	name: 'Management',
	description: 'Manager access to review people operations and run payroll.',
	apps: ['hr_controller'],
	grants: [
		...referenceGrants('read'),
		...statutoryGrants('read'),
		...peopleGrants('read'),
		...grantsOn('time_entries', ['read']),
		...grantsOn('leave_requests', ['read']),
		...payrollGrants('read'),

		...grantsOn('payroll_runs', ['update', 'delete']),
		{
			collection: 'payroll_runs',
			action: 'create',
			approval: payrollRunApproval('019efa4d-0a10-7a04-8b04-000000000008')
		},

		{
			collection: 'time_entries',
			action: 'create',
			approval: timeEntryApproval('019efa4d-0a10-7a04-8b04-00000000000b')
		},
		{
			collection: 'time_entries',
			action: 'update',
			approval: timeEntryApproval('019efa4d-0a10-7a04-8b04-00000000000c')
		},

		// Raising leave is reviewed; amending one already raised is not. A manager amending a request
		// is acting as its reviewer, so routing that back through review would ask them to approve
		// themselves.
		{
			collection: 'leave_requests',
			action: 'create',
			approval: leaveApproval('019efa4d-0a10-7a04-8b04-000000000006')
		},
		{ collection: 'leave_requests', action: 'update' }
	]
} satisfies Policy;
