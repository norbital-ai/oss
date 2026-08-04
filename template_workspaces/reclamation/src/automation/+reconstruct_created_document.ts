import { defineAutomation } from '@norbital-ai/pod/authoring';
import { reconstructForDocument } from '../lib/reclamation/stitch-driver.js';

/**
 * Fold a newly attached reconstruction document into the model.
 *
 * Additional sections and additional bathymetry change the solid, so the site is re-integrated.
 * The fingerprint covers the attached set, so a document the engine never reads leaves the
 * existing revision alone.
 */
export default defineAutomation(
	{ trigger: { collection: 'project_documents', event: 'created' } },
	async (api, { scope }) => ({
		project_id: scope.incoming_record.project_id,
		outcome: await reconstructForDocument(api, scope.incoming_record)
	})
);
