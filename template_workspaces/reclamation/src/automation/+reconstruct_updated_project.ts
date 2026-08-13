import { defineAutomation } from '@norbital-ai/pod/authoring';
import { reconstructProject } from '../lib/reclamation/stitch-driver.js';

/**
 * Rebuild the model when a project's documents or tuning change.
 *
 * This fires on every project update, including a rename or a status change. That is deliberate
 * and cheap: `reconstructProject` compares the current documents and settings against the
 * fingerprint on the newest ready run, so only an edit that would change the solid re-integrates
 * the site. Everything else returns `skipped` without reading a single asset.
 */
export default defineAutomation(
	{ trigger: { collection: 'reclamation_projects', event: 'updated' } },
	{
		description:
			'Re-integrates the site whenever a project edit changes its three source drawings or its grid tuning, and leaves the existing revision alone for a rename or a status change.',
		handler: async (api, { scope }) => ({
			project_id: scope.incoming_record.norbital_id,
			outcome: await reconstructProject(api, scope.incoming_record.norbital_id)
		})
	}
);
