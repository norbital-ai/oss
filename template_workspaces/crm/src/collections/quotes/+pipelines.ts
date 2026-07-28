import type { Pipelines } from './$types.js';

export default {
	export: {
		handler: async ({ records }, api) => {
			const quoteIds = records.map((quote) => quote.norbital_id);
			if (quoteIds.length === 0) return [];

			const lines = await api.db.query.quote_lines.findMany({
				where: { quote_id: { in: quoteIds } },
				limit: 5000
			});

			return records.map((quote) => {
				const quoteLines = lines.filter((line) => line.quote_id === quote.norbital_id);
				const code = (quote.doc_no || quote.norbital_id).replace(/[^a-z0-9_-]/gi, '_');

				const lineRows = quoteLines.map((line) => ({
					record_id: line.norbital_id,
					quote_id: line.quote_id,
					product_code: line.product_code,
					product_name: line.product_name,
					product_unit: line.product_unit,
					quantity: line.quantity,
					unit_price: line.unit_price,
					discount_pct: line.discount_pct,
					tax_rate: line.tax_rate,
					line_total: line.line_total
				}));

				return {
					label: `Quote export · ${quote.doc_no}`,
					attachments: [
						{
							name: `quote_${code}.json`,
							contentType: 'JSON' as const,
							content: {
								schema: 'norbital.crm.interoperability.v1',
								quote: {
									doc_no: quote.doc_no,
									title: quote.title,
									status: quote.status,
									currency: quote.currency,
									net: quote.net,
									tax: quote.tax,
									gross: quote.gross,
									valid_until: quote.valid_until,
									description: quote.description
								},
								lines: lineRows
							}
						},
						{
							name: `quote_${code}_lines.csv`,
							contentType: 'CSV' as const,
							content: lineRows
						}
					],
					metadata: {
						schema: 'norbital.crm.interoperability.v1',
						quote_id: quote.norbital_id,
						doc_no: quote.doc_no
					}
				};
			});
		}
	}
} satisfies Pipelines;
