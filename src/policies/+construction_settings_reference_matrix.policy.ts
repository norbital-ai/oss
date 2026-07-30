import type { Policy } from './$types.js';

/**
 * BIM reference matrix administration, opened through its own settings app.
 *
 * Same twelve read grants as the other two construction policies — carried over from the seed
 * unchanged. The matrix is a lookup that only means something against the projects, jobs, and assets
 * that cite it, so the reach is wider than the app's name suggests.
 *
 * None of these three policies grants a write anywhere. Construction's mutations run as admin today;
 * whether that is right is a product question, and answering it inside a port would hide the answer
 * in a diff about file moves.
 */
export default {
	name: 'Construction Reference Matrix',
	description: 'BIM reference matrix administration.',
	apps: ['construction_settings_reference_matrix'],
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
