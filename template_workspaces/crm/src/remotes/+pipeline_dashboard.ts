import { defineQueryHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

export default defineQueryHandler({
	schema: z.object({
		owner_id: z.string().optional(),
		account_id: z.string().optional()
	}),
	handler: async ({ owner_id, account_id }, api) => {
		const where = {
			...(owner_id ? { owner_id: { eq: owner_id } } : {}),
			...(account_id ? { account_id: { eq: account_id } } : {})
		};

		const quotes = await api.db.query.quotes.findMany({
			where,
			columns: {
				norbital_id: true,
				account_id: true,
				doc_no: true,
				title: true,
				status: true,
				currency: true,
				gross: true,
				valid_until: true
			},
			orderBy: { doc_no: 'desc' },
			limit: 500
		});

		if (quotes.length === 0) {
			return { cards: [] };
		}

		const accountIds = [...new Set(quotes.map((quote) => quote.account_id))];
		const accounts = await api.db.query.accounts.findMany({
			where: { norbital_id: { in: accountIds } },
			columns: { norbital_id: true, name: true },
			limit: accountIds.length
		});
		const accountById = new Map(accounts.map((account) => [account.norbital_id, account.name]));

		return {
			cards: quotes.map((quote) => ({
				id: quote.norbital_id,
				doc_no: quote.doc_no,
				title: quote.title,
				account: accountById.get(quote.account_id) ?? 'Unknown account',
				status: quote.status,
				gross: quote.gross,
				currency: quote.currency,
				valid_until: quote.valid_until
			}))
		};
	}
});
