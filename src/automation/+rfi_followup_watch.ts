import { defineAutomation } from '@norbital-ai/pod/authoring';
import type { Api } from './$types.js';

export default defineAutomation({ schedule: '0 6 * * *' }, async (api: Api) => {
	const rfis = await api.db.query.rfis.findMany({ limit: 250 });
	return {
		automation_key: 'rfi_followup_watch',
		generated_at: new Date().toISOString(),
		summary: { rfi_count: rfis.length },
		exports: [
			{
				filename: 'rfi-followup-watch.json',
				content_type: 'application/json',
				rows: rfis.slice(0, 25)
			}
		]
	};
});
