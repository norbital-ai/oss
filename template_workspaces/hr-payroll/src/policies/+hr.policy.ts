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
 * HR administration: the widest of the three payroll policies, 79 grants.
 *
 * Kept generated, because the groups are what the policy actually says. `referenceGrants` with four
 * actions beside `statutoryGrants` with one is a rule you can read — a company owns its configuration
 * and only reads the law — and it vanishes into seventy-nine indistinguishable lines once flattened.
 * The exceptions are written out below the generated blocks, which is where the interesting part of
 * any permission set lives. See `src/lib/policy_grants.ts` for why the groups are functions.
 *
 * The three gated grants carry their approval configs **verbatim** — same `norbital_id`, same step
 * id, same `teams_that_can_approve`. Those ids are not decorative: an existing `approval_request`
 * resolves its `approval_config_id` by scanning grants for a matching `norbital_id`, so reissuing one
 * would leave every in-flight and historical request unable to name the flow that produced it.
 * Dropping the gate would be worse still — a reviewed payroll run would quietly become a direct write.
 *
 * `apps: ['hr_controller']` names the app *group*, as the seed did. Eight apps sit under it and
 * `appAccessAllowed` matches a group prefix, so this is one grant rather than eight — and, unlike
 * eight, it still covers the ninth when somebody adds it.
 */
export default {
	name: 'HR',
	description: 'HR administration across people, scheduling, requests, loans, and payroll.',
	apps: ['hr_controller'],
	grants: [
		...referenceGrants('read', 'create', 'update', 'delete'),
		...statutoryGrants('read'),
		...peopleGrants('read'),
		...peopleGrants('create', 'update', 'delete'),
		...grantsOn('time_entries', ['read']),

		// Attendance becomes a payroll source, so writing it is reviewed. Deleting it is not, and that
		// asymmetry is the seed's: removing an entry withdraws a claim on payroll rather than making
		// one, and routing a withdrawal through the manager who would have to notice it only leaves the
		// bad row sitting in the run.
		{
			collection: 'time_entries',
			action: 'create',
			approval: timeEntryApproval('019efa4d-0a10-7a04-8b04-000000000009')
		},
		{
			collection: 'time_entries',
			action: 'update',
			approval: timeEntryApproval('019efa4d-0a10-7a04-8b04-00000000000a')
		},
		{ collection: 'time_entries', action: 'delete' },

		...grantsOn('leave_requests', ['read', 'update', 'delete']),
		{
			collection: 'leave_requests',
			action: 'create',
			approval: leaveApproval('019efa4d-0a10-7a04-8b04-000000000004')
		},

		...payrollGrants('read'),
		...grantsOn('payroll_runs', ['update', 'delete']),
		{
			collection: 'payroll_runs',
			action: 'create',
			approval: payrollRunApproval('019efa4d-0a10-7a04-8b04-000000000007')
		}
	]
} satisfies Policy;
