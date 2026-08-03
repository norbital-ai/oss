import type { Policy } from './$types.js';

/**
 * The controller: full command of the dispatch surface.
 *
 * Every collection, every action, unconditional. Written out one grant per line rather than generated
 * from a loop because a permission set is read far more often than it is written, and a reader should
 * be able to see that `photo_evidence` is deletable here without first evaluating a `flatMap`.
 *
 * The key is the filename, and it matches the key this policy had while it was seeded — reconciliation
 * upserts by key, so the declaration takes over the existing row instead of creating a second one and
 * orphaning every `team.policy_id` that points at it.
 */
export default {
	name: 'Field Operations Controller',
	description:
		'Controller access to dispatch jobs, manage contractor certifications, assignments, sites, and approval records.',
	apps: ['field_ops_controller', 'field_ops_contractor'],
	grants: [
		{ collection: 'sites', action: 'read' },
		{ collection: 'sites', action: 'create' },
		{ collection: 'sites', action: 'update' },
		{ collection: 'sites', action: 'delete' },

		{ collection: 'contractor_profiles', action: 'read' },
		{ collection: 'contractor_profiles', action: 'create' },
		{ collection: 'contractor_profiles', action: 'update' },
		{ collection: 'contractor_profiles', action: 'delete' },

		{ collection: 'certification_types', action: 'read' },
		{ collection: 'certification_types', action: 'create' },
		{ collection: 'certification_types', action: 'update' },
		{ collection: 'certification_types', action: 'delete' },

		{ collection: 'contractor_certifications', action: 'read' },
		{ collection: 'contractor_certifications', action: 'create' },
		{ collection: 'contractor_certifications', action: 'update' },
		{ collection: 'contractor_certifications', action: 'delete' },

		{ collection: 'jobs', action: 'read' },
		{ collection: 'jobs', action: 'create' },
		{ collection: 'jobs', action: 'update' },
		{ collection: 'jobs', action: 'delete' },

		{ collection: 'job_certification_requirements', action: 'read' },
		{ collection: 'job_certification_requirements', action: 'create' },
		{ collection: 'job_certification_requirements', action: 'update' },
		{ collection: 'job_certification_requirements', action: 'delete' },

		{ collection: 'job_assignments', action: 'read' },
		{ collection: 'job_assignments', action: 'create' },
		{ collection: 'job_assignments', action: 'update' },
		{ collection: 'job_assignments', action: 'delete' },

		{ collection: 'variation_requests', action: 'read' },
		{ collection: 'variation_requests', action: 'create' },
		{ collection: 'variation_requests', action: 'update' },
		{ collection: 'variation_requests', action: 'delete' },

		{ collection: 'photo_evidence', action: 'read' },
		{ collection: 'photo_evidence', action: 'create' },
		{ collection: 'photo_evidence', action: 'update' },
		{ collection: 'photo_evidence', action: 'delete' }
	]
} satisfies Policy;
