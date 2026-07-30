import type { Policy } from './$types.js';

/**
 * Workforce administration: the same twelve collections, opened through the workforce settings app.
 *
 * The grant set is identical to `+construction_project_workspace.policy.ts` — that is what the seed
 * did, and it is not an oversight to be tidied here. Compliance work needs to read a job and its
 * payment claim to explain why a worker's certification blocks it, so trimming the list to
 * `workers` and `certification_types` would be a behaviour change dressed as a port.
 *
 * What actually separates the three policies is `apps`. See the sibling file for why the collection
 * list is repeated rather than shared.
 */
export default {
	name: 'Construction Workforce',
	description: 'Workforce library and compliance administration.',
	apps: ['construction_settings_workforce'],
	grants: [
		{ collection: 'projects', action: 'read' },
		{ collection: 'site_locations', action: 'read' },
		{ collection: 'rfis', action: 'read' },
		{ collection: 'defects', action: 'read' },
		{ collection: 'workers', action: 'read' },
		{ collection: 'certification_types', action: 'read' },
		{ collection: 'permits_to_work', action: 'read' },
		{ collection: 'jobs', action: 'read' },
		{ collection: 'job_assignments', action: 'read' },
		{ collection: 'payment_claims', action: 'read' },
		{ collection: 'bim_reference_matrix', action: 'read' },
		{ collection: 'asset_documents', action: 'read' }
	]
} satisfies Policy;
