import type { Pipelines } from './$types.js';

/**
 * The push payload the outbound integration binding delivers.
 *
 * The host runs this export against the outboxed records — a confirmed quote and its lines — and
 * the binding's `transform` takes the JSON attachment as the request body. The schema is the
 * handoff contract: document number, header facts, and the lines exactly as they were confirmed.
 */
export default {
	export: {
		handler: async ({ records }, api) => {
			const quoteIds = records
				.map((quote) => quote.norbital_id)
				.filter((id): id is string => typeof id === 'string');
			if (quoteIds.length === 0) return [];

			const lines = await api.db.query.quote_lines.findMany({
				where: { quote_id: { in: quoteIds } },
				limit: 5000
			});

			return records.map((quote) => {
				const quoteLines = lines.filter((line) => line.quote_id === quote.norbital_id);
				const code = String(quote.doc_no ?? quote.norbital_id).replace(/[^a-z0-9_-]/gi, '_');

				return {
					label: `Confirmed quote · ${quote.doc_no}`,
					attachments: [
						{
							name: `quote_${code}.json`,
							contentType: 'JSON' as const,
							content: {
								schema: 'norbital.crm.confirmed_quote.v1',
								quote: {
									doc_no: quote.doc_no,
									title: quote.title,
									status: quote.status,
									currency: quote.currency,
									net: quote.net,
									tax: quote.tax,
									gross: quote.gross,
									confirmed_at: quote.confirmed_at
								},
								lines: quoteLines.map((line) => ({
									product_code: line.product_code,
									product_name: line.product_name,
									quantity: line.quantity,
									unit_price: line.unit_price,
									discount_pct: line.discount_pct,
									tax_rate: line.tax_rate,
									line_total: line.line_total
								}))
							}
						}
					],
					metadata: {
						schema: 'norbital.crm.confirmed_quote.v1',
						quote_id: quote.norbital_id,
						doc_no: quote.doc_no
					}
				};
			});
		}
	}
} satisfies Pipelines;
