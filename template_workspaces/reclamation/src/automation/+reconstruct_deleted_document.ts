import { defineAutomation } from '@norbital-ai/pod/authoring';
import { reconstructForDocument } from '../lib/reclamation/stitch-driver.js';

/**
 * Rebuild the model without a removed reconstruction document.
 *
 * A revision that was stitched from a section sheet which no longer exists is not the project's
 * model any more, so the removal appends a revision built from what is left.
 */
export default defineAutomation(
	{ trigger: { collection: 'project_documents', event: 'deleted' } },
	async (api, { scope }) => ({
		project_id: scope.incoming_record.project_id,
		outcome: await reconstructForDocument(api, scope.incoming_record)
	})
);
