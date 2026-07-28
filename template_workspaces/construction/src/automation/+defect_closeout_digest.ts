import { defineAutomation } from '@norbital-ai/pod/authoring';
import type { Api } from './$types.js';

export default defineAutomation({ schedule: '0 6 * * *' }, async (api: Api) => {
	const defects = await api.db.query.defects.findMany({ limit: 250 });
	return {
		automation_key: 'defect_closeout_digest',
		generated_at: new Date().toISOString(),
		summary: { defect_count: defects.length },
		exports: [
			{
				filename: 'defect-closeout-digest.json',
				content_type: 'application/json',
				rows: defects.slice(0, 25)
			}
		]
	};
});
