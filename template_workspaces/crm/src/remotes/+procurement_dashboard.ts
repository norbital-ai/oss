import { defineQueryHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

const COMMITTED_STATUSES = ['submitted', 'confirmed'] as const;
const TOP_SUPPLIER_LIMIT = 5;

export default defineQueryHandler({
	schema: z.object({}),
	handler: async (_input, api) => {
		const purchaseOrders = await api.db.query.purchase_orders.findMany({
			columns: {
				norbital_id: true,
				doc_no: true,
				status: true,
				currency: true,
				supplier_id: true,
				supplier_name: true,
				gross: true
			},
			orderBy: { doc_no: 'asc' },
			limit: 5000
		});

		const statusCounts: Record<string, number> = {};
		const committedByCurrency = new Map<string, number>();
		const committedBySupplier = new Map<string, { supplierName: string; gross: number }>();

		for (const order of purchaseOrders) {
			const status = order.status ?? 'draft';
			statusCounts[status] = (statusCounts[status] ?? 0) + 1;

			if (order.currency == null || !COMMITTED_STATUSES.some((s) => s === order.status)) {
				continue;
			}
			const gross = order.gross != null ? Number(order.gross) : 0;

			const currencyTotal = committedByCurrency.get(order.currency) ?? 0;
			committedByCurrency.set(order.currency, currencyTotal + gross);

			const current = committedBySupplier.get(order.supplier_id) ?? {
				supplierName: order.supplier_name,
				gross: 0
			};
			committedBySupplier.set(order.supplier_id, {
				supplierName: current.supplierName,
				gross: current.gross + gross
			});
		}

		const topSuppliers = [...committedBySupplier.entries()]
			.map(([supplierId, row]) => ({
				supplier_id: supplierId,
				supplier_name: row.supplierName,
				gross: row.gross
			}))
			.sort((left, right) => right.gross - left.gross)
			.slice(0, TOP_SUPPLIER_LIMIT);

		return {
			status_counts: statusCounts,
			committed_by_currency: [...committedByCurrency.entries()]
				.map(([currency, total]) => ({ currency, total }))
				.sort((left, right) => left.currency.localeCompare(right.currency)),
			top_suppliers: topSuppliers
		};
	}
});
