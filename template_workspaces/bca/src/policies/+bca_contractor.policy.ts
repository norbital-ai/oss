import type { Policy } from './$types.js';

/** The approval shape, taken from the grant that holds it so there is nothing to keep in step. */
type Approval = NonNullable<Policy['grants'][number]['approval']>;

/**
 * The contractor: their own profile, the jobs they were assigned, and nothing else.
 *
 * Every grant here is conditional, and the conditions are subqueries rather than column comparisons —
 * a contractor is a `contractor_profiles` row, not a user id, so almost nothing on these collections
 * carries the requestor directly. `$sql` is the form that expresses that.
 *
 * `${requestor.norbital_id}` is **not** interpolated here: these are single-quoted strings, so the
 * literal token reaches the database, and the policy compiler replaces it with a bound parameter on
 * every request. An unknown path throws rather than binding null, so a renamed scope root fails loudly.
 *
 * Use `$sql`, never `RAW`. `RAW` is a function; a grant is stored as jsonb and round-tripped through
 * the manifest, so the function disappears and the grant lands with empty conditions — which the guard
 * reads as unconditional access to the whole collection. A narrowing that silently inverts into a
 * widening is the worst thing a permission rule can do, so `definePolicy` refuses it outright.
 */

/** Their own contractor row — the one collection where the requestor appears as a column. */
const ownProfile = { user_id: { eq: '${requestor.norbital_id}' } } as const;

/** Certifications hanging off their own profile. */
const ownCertification = {
	$sql:
		'"contractor_profile_id" IN (SELECT norbital_id FROM contractor_profiles ' +
		'WHERE user_id = ${requestor.norbital_id})'
} as const;

/**
 * The certification catalogue, narrowed to entries that actually concern them: ones they hold, plus
 * ones required by a job they are assigned to. Without the second half a contractor cannot read the
 * name of a certification their job demands and they lack.
 */
const relevantCertificationType = {
	$sql:
		'"norbital_id" IN (SELECT certification_type_id FROM contractor_certifications ' +
		'WHERE contractor_profile_id IN (SELECT norbital_id FROM contractor_profiles ' +
		'WHERE user_id = ${requestor.norbital_id}) ' +
		'UNION SELECT certification_type_id FROM job_certification_requirements ' +
		'WHERE job_id IN (SELECT a.job_id FROM job_assignments a ' +
		'JOIN contractor_profiles c ON c.norbital_id = a.contractor_profile_id ' +
		'WHERE c.user_id = ${requestor.norbital_id}))'
} as const;

/** Sites reachable through an assignment. */
const assignedSite = {
	$sql:
		'"norbital_id" IN (SELECT j.site_id FROM jobs j ' +
		'JOIN job_assignments a ON a.job_id = j.norbital_id ' +
		'JOIN contractor_profiles c ON c.norbital_id = a.contractor_profile_id ' +
		'WHERE c.user_id = ${requestor.norbital_id})'
} as const;

/** Jobs they were assigned. */
const assignedJob = {
	$sql:
		'"norbital_id" IN (SELECT a.job_id FROM job_assignments a ' +
		'JOIN contractor_profiles c ON c.norbital_id = a.contractor_profile_id ' +
		'WHERE c.user_id = ${requestor.norbital_id})'
} as const;

/** Certification requirements of a job they were assigned. */
const assignedJobRequirement = {
	$sql:
		'"job_id" IN (SELECT a.job_id FROM job_assignments a ' +
		'JOIN contractor_profiles c ON c.norbital_id = a.contractor_profile_id ' +
		'WHERE c.user_id = ${requestor.norbital_id})'
} as const;

/** Their own assignment rows. */
const ownAssignment = {
	$sql:
		'"contractor_profile_id" IN (SELECT norbital_id FROM contractor_profiles ' +
		'WHERE user_id = ${requestor.norbital_id})'
} as const;

/** Variations raised against one of their own assignments. */
const ownVariation = {
	$sql:
		'"job_assignment_id" IN (SELECT a.norbital_id FROM job_assignments a ' +
		'JOIN contractor_profiles c ON c.norbital_id = a.contractor_profile_id ' +
		'WHERE c.user_id = ${requestor.norbital_id})'
} as const;

/**
 * Photos hang off exactly one of an assignment or a variation, so both legs are needed; a condition on
 * `job_assignment_id` alone would hide every photo attached to their own variation request.
 */
const ownEvidence = {
	$sql:
		'("job_assignment_id" IN (SELECT a.norbital_id FROM job_assignments a ' +
		'JOIN contractor_profiles c ON c.norbital_id = a.contractor_profile_id ' +
		'WHERE c.user_id = ${requestor.norbital_id}) ' +
		'OR "variation_request_id" IN (SELECT variation.norbital_id FROM variation_requests variation ' +
		'WHERE variation.job_assignment_id IN (SELECT a.norbital_id FROM job_assignments a ' +
		'JOIN contractor_profiles c ON c.norbital_id = a.contractor_profile_id ' +
		'WHERE c.user_id = ${requestor.norbital_id})))'
} as const;

/**
 * A scope change is a commercial decision, so writing a variation raises a request instead of a row.
 *
 * The ids are carried over from the seeded policy rather than reissued: `approval_config_id` on an
 * existing `approval_request` is resolved by scanning grants for a matching `norbital_id`, so a new id
 * would leave every in-flight and historical request unable to name the flow that produced it.
 *
 * The approver is named by `team.name`, not by `team.norbital_id`. A team is a runtime row, so its id
 * exists per tenant and belongs to whichever database seeded it — hardcoding one here put a private
 * identifier in a public template and made the flow unsatisfiable anywhere else, with nothing to say
 * so. Reconciliation resolves the name against the tenant it is reconciling and refuses a name that
 * has no team.
 */
const controllerTeam = 'BCA Controllers';

function variationApproval(configId: string, stepId: string): Approval {
	return {
		id: configId,
		name: 'BCA variation approval',
		steps: [
			{
				id: stepId,
				name: 'BCA controller review',
				approvers: [controllerTeam],
				description: 'Controller verifies scope change and selected photo evidence.'
			}
		]
	};
}

export default {
	name: 'BCA Contractor',
	description:
		'Self-scoped access to assigned jobs and sites, with field updates on own assignments and linked variation or photo evidence.',
	apps: ['bca_contractor'],
	grants: [
		{ collection: 'contractor_profiles', action: 'read', where: ownProfile },
		{ collection: 'certification_types', action: 'read', where: relevantCertificationType },
		{ collection: 'contractor_certifications', action: 'read', where: ownCertification },
		{ collection: 'sites', action: 'read', where: assignedSite },
		{ collection: 'jobs', action: 'read', where: assignedJob },
		{
			collection: 'job_certification_requirements',
			action: 'read',
			where: assignedJobRequirement
		},
		{ collection: 'job_assignments', action: 'read', where: ownAssignment },
		{ collection: 'job_assignments', action: 'update', where: ownAssignment },
		{ collection: 'variation_requests', action: 'read', where: ownVariation },
		{
			collection: 'variation_requests',
			action: 'create',
			where: ownVariation,
			approval: variationApproval(
				'019f6f10-0001-7000-8000-000000000003',
				'019f6f10-0001-7000-8000-000000000103'
			)
		},
		{
			collection: 'variation_requests',
			action: 'update',
			where: ownVariation,
			approval: variationApproval(
				'019f6f10-0001-7000-8000-000000000004',
				'019f6f10-0001-7000-8000-000000000104'
			)
		},
		{ collection: 'photo_evidence', action: 'read', where: ownEvidence },
		{ collection: 'photo_evidence', action: 'create', where: ownEvidence }
	]
} satisfies Policy;
