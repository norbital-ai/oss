import { defineQueryHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

export default defineQueryHandler({
	schema: z.object({ currency: z.string().optional() }),
	handler: async ({ currency }, api) => {
		const quotes = await api.db.query.quotes.findMany({
			where: { status: { in: ['confirmed', 'fulfilled', 'won'] } },
			columns: {
				norbital_id: true,
				doc_no: true,
				currency: true,
				gross: true,
				status: true
			},
			limit: 1000
		});

		const filtered = currency ? quotes.filter((q) => q.currency === currency) : quotes;
		if (filtered.length === 0) {
			return { orders: [], total_invoiced: 0, total_paid: 0, outstanding: 0 };
		}

		const quoteIds = filtered.map((q) => q.norbital_id);
		const payments = await api.db.query.payment_records.findMany({
			where: { quote_id: { in: quoteIds } },
			columns: { quote_id: true, amount: true },
			limit: 5000
		});

		const paidByQuote = new Map<string, number>();
		for (const p of payments) {
			if (p.quote_id == null) continue;
			const curr = paidByQuote.get(p.quote_id) ?? 0;
			paidByQuote.set(p.quote_id, curr + (p.amount?.value ?? 0));
		}

		let totalInvoiced = 0;
		let totalPaid = 0;
		const orderSummaries = filtered.map((quote) => {
			const paid = paidByQuote.get(quote.norbital_id) ?? 0;
			const gross = quote.gross != null ? Number(quote.gross) : 0;
			totalInvoiced += gross;
			totalPaid += paid;
			return {
				id: quote.norbital_id,
				doc_no: quote.doc_no,
				currency: quote.currency,
				gross,
				paid,
				status: gross === 0 ? 'empty' : paid >= gross ? 'paid' : paid > 0 ? 'partial' : 'unpaid'
			};
		});

		return {
			orders: orderSummaries,
			total_invoiced: totalInvoiced,
			total_paid: totalPaid,
			outstanding: totalInvoiced - totalPaid
		};
	}
});
