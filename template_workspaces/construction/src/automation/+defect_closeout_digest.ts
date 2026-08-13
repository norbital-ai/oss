import { defineAutomation } from '@norbital-ai/pod/authoring';

export default defineAutomation(
	{ schedule: '0 6 * * *' },
	{
		description:
			'Counts the defect register every morning at 6am and publishes the first 25 defects as a JSON extract for the closeout meeting.',
		handler: async (api) => {
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
		}
	}
);
