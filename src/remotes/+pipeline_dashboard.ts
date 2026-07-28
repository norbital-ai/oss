import { defineQueryHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';
import type { Api } from './$types.js';

export default defineQueryHandler({
	schema: z.object({ owner_id: z.string().optional() }),
	handler: async ({ owner_id }, api: Api) => {
		const where = owner_id ? { owner_id: { eq: owner_id } } : {};

		const quotes = await api.db.query.quotes.findMany({
			where,
			columns: {
				norbital_id: true,
				account_id: true,
				doc_no: true,
				title: true,
				status: true,
				currency: true,
				net: true,
				gross: true,
				owner_id: true,
				valid_until: true
			},
			orderBy: { doc_no: 'desc' },
			limit: 500
		});

		if (quotes.length === 0) {
			return { cards: [], stage_counts: {}, total_pipeline_value: 0 };
		}

		const accountIds = [...new Set(quotes.map((q) => q.account_id))];
		const accounts = await api.db.query.accounts.findMany({
			where: { norbital_id: { in: accountIds } },
			columns: { norbital_id: true, name: true },
			limit: accountIds.length
		});
		const accountById = new Map(accounts.map((a) => [a.norbital_id, a.name]));

		const stageCounts: Record<string, number> = {};
		let pipelineTotal = 0;
		for (const quote of quotes) {
			const stage = quote.status ?? 'draft';
			stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;
			if (quote.status !== 'lost' && quote.gross != null) {
				pipelineTotal += Number(quote.gross);
			}
		}

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
			})),
			stage_counts: stageCounts,
			total_pipeline_value: pipelineTotal
		};
	}
});
