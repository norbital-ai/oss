import { defineAutomation } from '@norbital-ai/pod/authoring';

export default defineAutomation(
	{ schedule: '0 6 * * *' },
	{
		description:
			'Counts the payment claims on the books every morning at 6am and publishes the first 25 as a JSON extract so the commercial team can check progress-claim readiness.',
		handler: async (api) => {
			const claims = await api.db.query.payment_claims.findMany({ limit: 250 });
			return {
				automation_key: 'payment_claim_readiness_watch',
				generated_at: new Date().toISOString(),
				summary: { payment_claim_count: claims.length },
				exports: [
					{
						filename: 'payment-claim-readiness-watch.json',
						content_type: 'application/json',
						rows: claims.slice(0, 25)
					}
				]
			};
		}
	}
);
