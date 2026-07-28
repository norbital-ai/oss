import type { Hooks } from './$types.js';

export default {
	create: {
		before: async ({ input, api }) => {
			if (!input.quote_id) throw new Error('A payment must reference a quote.');
			const quote = await api.db.query.quotes.findFirst({
				where: { norbital_id: { eq: input.quote_id } }
			});
			if (!quote) throw new Error('Referenced quote does not exist.');
			if (quote.status === 'draft' || quote.status === 'sent') {
				throw new Error(
					'Payments can only be recorded against confirmed, fulfilled, or won documents.'
				);
			}
			if (quote.status === 'cancelled' || quote.status === 'lost') {
				throw new Error('Payments cannot be recorded against cancelled or lost documents.');
			}
			if (!input.amount?.value || input.amount.value <= 0) {
				throw new Error('Payment amount must be greater than zero.');
			}
			if (input.amount.currency !== quote.currency) {
				throw new Error(
					`Payment currency (${input.amount.currency}) must match the document currency (${quote.currency}).`
				);
			}
			return input;
		}
	}
} satisfies Hooks;
