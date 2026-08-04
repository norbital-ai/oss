import { defineQueryHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

/**
 * Buying-pipeline counters for the purchase app.
 *
 * Each stage count is an indexed `count()` — `status` carries its own index — so no row crosses the
 * boundary just to be tallied, and the count is not capped by a scan limit. Only the committed
 * orders are read as rows, and only the four columns the money roll-up reads, because summing is
 * the one thing the collection api has no server-side primitive for. The shape this replaced read
 * every draft and cancelled order as well, to compute numbers `count()` already knows.
 *
 * A row with no status is a draft, which is how the pipeline has always read it.
 */
const STATUSES = ['draft', 'submitted', 'confirmed', 'cancelled'] as const;
const COMMITTED_STATUSES = ['submitted', 'confirmed'] as const;
const TOP_SUPPLIER_LIMIT = 5;
const COMMITTED_SCAN_LIMIT = 5000;

export default defineQueryHandler({
	schema: z.object({}),
	handler: async (_input, api) => {
		const [committedOrders, ...stageTotals] = await Promise.all([
			api.db.query.purchase_orders.findMany({
				where: { status: { in: [...COMMITTED_STATUSES] } },
				columns: { currency: true, supplier_id: true, supplier_name: true, gross: true },
				orderBy: { doc_no: 'asc' },
				limit: COMMITTED_SCAN_LIMIT
			}),
			...STATUSES.map((status) =>
				api.db.purchase_orders.count({
					where:
						status === 'draft'
							? { OR: [{ status: { eq: 'draft' } }, { status: { isNull: true } }] }
							: { status: { eq: status } }
				})
			)
		]);

		const statusCounts: Record<string, number> = {};
		for (const [index, status] of STATUSES.entries()) {
			statusCounts[status] = Number(stageTotals[index] ?? 0);
		}

		const committedByCurrency = new Map<string, number>();
		const committedBySupplier = new Map<string, { supplierName: string; gross: number }>();

		for (const order of committedOrders) {
			if (order.currency == null) continue;
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
