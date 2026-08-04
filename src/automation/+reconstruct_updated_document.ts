import { defineAutomation } from '@norbital-ai/pod/authoring';
import { reconstructForDocument } from '../lib/reclamation/stitch-driver.js';

/**
 * Re-read the model when a reconstruction document is re-filed.
 *
 * Replacing the file or changing its role changes what the engine reads; renaming it does not, and
 * the input fingerprint is what tells the two apart.
 */
export default defineAutomation(
	{ trigger: { collection: 'project_documents', event: 'updated' } },
	async (api, { scope }) => ({
		project_id: scope.incoming_record.project_id,
		outcome: await reconstructForDocument(api, scope.incoming_record)
	})
);
