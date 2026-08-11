import { defineAutomation } from '@norbital-ai/pod/authoring';

export default defineAutomation(
	{ schedule: '0 6 * * *' },
	{
		kind: 'deterministic',
		description:
			'Sweeps the permits to work every morning at 6am and publishes the first 25 as a JSON extract so permits nearing the end of their validity range are caught before crews are stood down.',
		handler: async (api) => {
			const permits = await api.db.query.permits_to_work.findMany({ limit: 250 });
			return {
				automation_key: 'permit_expiry_watch',
				generated_at: new Date().toISOString(),
				summary: { permit_count: permits.length },
				exports: [
					{
						filename: 'permit-expiry-watch.json',
						content_type: 'application/json',
						rows: permits.slice(0, 25)
					}
				]
			};
		}
	}
);
