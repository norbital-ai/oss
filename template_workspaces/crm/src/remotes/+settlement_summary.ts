import { defineQueryHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

/**
 * Paid-to-date per document for one regarding type, so tables can derive
 * paid / partial / unpaid at render without reading every settlement row per document.
 * The status itself is never stored: a surface compares `paid` against the document gross
 * and shows an em-dash for anything that is not committed.
 */
export default defineQueryHandler({
	description:
		'Totals the amount settled to date against each quote, purchase order or purchase invoice of the requested type.',
	schema: z.object({
		regarding_type: z.enum(['quotes', 'purchase_orders', 'purchase_invoices'])
	}),
	handler: async (input, api) => {
		const rows = await api.db.query.settlements.findMany({
			where: { regarding_type: { eq: input.regarding_type } },
			columns: { regarding_id: true, amount: true, currency: true },
			limit: 5000
		});

		const summaries = new Map<string, { paid: number; currency: string }>();
		for (const row of rows) {
			if (typeof row.regarding_id !== 'string') continue;
			const current = summaries.get(row.regarding_id) ?? {
				paid: 0,
				currency: typeof row.currency === 'string' ? row.currency : ''
			};
			summaries.set(row.regarding_id, {
				paid: current.paid + Number(row.amount ?? 0),
				currency: current.currency
			});
		}

		return {
			summaries: Object.fromEntries(summaries.entries())
		};
	}
});
