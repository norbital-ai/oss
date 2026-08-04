import { defineAutomation } from '@norbital-ai/pod/authoring';
import { deskToday } from '../lib/calendar.js';

export default defineAutomation({ schedule: '0 6 * * *' }, async (api) => {
	const today = deskToday();

	const expiredQuotes = await api.db.query.quotes.findMany({
		where: {
			status: { eq: 'sent' },
			valid_until: { lte: today }
		},
		columns: {
			norbital_id: true,
			doc_no: true,
			title: true,
			account_id: true,
			owner_id: true,
			gross: true,
			currency: true,
			valid_until: true
		},
		limit: 250
	});

	return {
		automation_key: 'quote_expiry_watch',
		generated_at: new Date().toISOString(),
		summary: { expired: expiredQuotes.length },
		exports: [
			{
				filename: 'expired-quotes.json',
				content_type: 'application/json',
				rows: expiredQuotes.slice(0, 50)
			}
		]
	};
});
