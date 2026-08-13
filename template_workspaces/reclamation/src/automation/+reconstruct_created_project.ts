import { defineAutomation } from '@norbital-ai/pod/authoring';
import { reconstructProject } from '../lib/reclamation/stitch-driver.js';

/**
 * Build the model for a project that arrives with its documents already attached.
 *
 * A project created through the app has no documents yet and this run costs one fingerprint
 * comparison before returning `skipped`. A project created by an import or an API caller can
 * arrive complete, and that is the case this exists for.
 *
 * The stitch reads three file assets, walks a survey grid, and appends a `site_reconstructions`
 * revision. None of that belongs in the write that creates the project: it is durable work against
 * another collection, so it runs after commit where a failure records a failed revision instead of
 * rolling back the project the engineer just saved.
 */
export default defineAutomation(
	{ trigger: { collection: 'reclamation_projects', event: 'created' } },
	{
		description:
			'Stitches the first site reconstruction for a project that is created with its floor plan, bathymetry and cross-sections already attached, as an import or an API caller would.',
		handler: async (api, { scope }) => ({
			project_id: scope.incoming_record.norbital_id,
			outcome: await reconstructProject(api, scope.incoming_record.norbital_id)
		})
	}
);
