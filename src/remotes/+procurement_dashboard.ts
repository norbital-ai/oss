import { defineQueryHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

const COMMITTED_STATUSES = ['submitted', 'confirmed', 'received'] as const;

export default defineQueryHandler({
	schema: z.object({}),
	handler: async (_input, api) => {
		const purchaseOrders = await api.db.query.purchase_orders.findMany({
			columns: {
				norbital_id: true,
				doc_no: true,
				status: true,
				currency: true,
				gross: true
			},
			limit: 5000
		});

		const statusCounts: Record<string, number> = {};
		const committedByCurrency = new Map<string, number>();

		for (const order of purchaseOrders) {
			const status = order.status ?? 'draft';
			statusCounts[status] = (statusCounts[status] ?? 0) + 1;

			if (
				order.currency != null &&
				COMMITTED_STATUSES.some((committed) => committed === order.status)
			) {
				const gross = order.gross != null ? Number(order.gross) : 0;
				const current = committedByCurrency.get(order.currency) ?? 0;
				committedByCurrency.set(order.currency, current + gross);
			}
		}

		const payableOrders = purchaseOrders.filter(
			(order) => order.status != null && order.status !== 'draft' && order.status !== 'cancelled'
		);
		const purchaseOrderIds = payableOrders.map((order) => order.norbital_id);

		const payments =
			purchaseOrderIds.length === 0
				? []
				: await api.db.query.payment_records.findMany({
						where: {
							purchase_order_id: { in: purchaseOrderIds },
							direction: { eq: 'outgoing' }
						},
						columns: { purchase_order_id: true, amount: true },
						limit: 5000
					});

		const paidByOrder = new Map<string, number>();
		for (const payment of payments) {
			if (payment.purchase_order_id == null) continue;
			const current = paidByOrder.get(payment.purchase_order_id) ?? 0;
			paidByOrder.set(payment.purchase_order_id, current + (payment.amount?.value ?? 0));
		}

		const payables = payableOrders.map((order) => {
			const gross = order.gross != null ? Number(order.gross) : 0;
			const paid = paidByOrder.get(order.norbital_id) ?? 0;
			const outstanding = gross - paid;
			return {
				id: order.norbital_id,
				doc_no: order.doc_no,
				currency: order.currency,
				gross,
				paid,
				outstanding,
				status: gross === 0 ? 'empty' : paid >= gross ? 'paid' : paid > 0 ? 'partial' : 'unpaid'
			};
		});

		const stockLevels = await api.db.query.stock_levels.findMany({
			columns: { product_id: true, qty_on_hand: true },
			limit: 5000
		});

		const lowStockRows = stockLevels.filter((row) => Number(row.qty_on_hand ?? 0) <= 0);
		const lowStockProductIds = lowStockRows.map((row) => row.product_id);

		const products =
			lowStockProductIds.length === 0
				? []
				: await api.db.query.products.findMany({
						where: { norbital_id: { in: lowStockProductIds } },
						columns: { norbital_id: true, code: true, name: true },
						limit: lowStockProductIds.length
					});

		const productById = new Map(products.map((product) => [product.norbital_id, product]));

		const lowStock = lowStockRows.flatMap((row) => {
			const product = productById.get(row.product_id);
			if (!product) return [];
			return [
				{
					product_id: row.product_id,
					product_code: product.code,
					product_name: product.name,
					qty_on_hand: Number(row.qty_on_hand ?? 0)
				}
			];
		});

		return {
			status_counts: statusCounts,
			committed_by_currency: [...committedByCurrency.entries()]
				.map(([currency, total]) => ({ currency, total }))
				.sort((left, right) => left.currency.localeCompare(right.currency)),
			payables,
			low_stock: lowStock.sort((left, right) => left.product_code.localeCompare(right.product_code))
		};
	}
});
