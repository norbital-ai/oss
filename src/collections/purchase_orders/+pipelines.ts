import type { Pipelines } from './$types.js';

/**
 * The push payload the outbound integration binding delivers.
 *
 * The host runs this export against the outboxed records — a confirmed purchase order and its
 * lines — and the binding's `transform` takes the JSON attachment as the request body. The schema
 * is the handoff contract: document number, header facts, and the lines exactly as they were
 * confirmed, in the order's own currency.
 */
export default {
	export: {
		handler: async ({ records }, api) => {
			const orderIds = records
				.map((order) => order.norbital_id)
				.filter((id): id is string => typeof id === 'string');
			if (orderIds.length === 0) return [];

			const lines = await api.db.query.purchase_order_lines.findMany({
				where: { purchase_order_id: { in: orderIds } },
				limit: 5000
			});

			return records.map((order) => {
				const orderLines = lines.filter((line) => line.purchase_order_id === order.norbital_id);
				const code = String(order.doc_no ?? order.norbital_id).replace(/[^a-z0-9_-]/gi, '_');

				return {
					label: `Confirmed purchase order · ${order.doc_no}`,
					attachments: [
						{
							name: `purchase_order_${code}.json`,
							contentType: 'JSON' as const,
							content: {
								schema: 'norbital.crm.confirmed_purchase_order.v1',
								purchase_order: {
									doc_no: order.doc_no,
									supplier_code: order.supplier_code,
									supplier_name: order.supplier_name,
									status: order.status,
									currency: order.currency,
									net: order.net,
									tax: order.tax,
									gross: order.gross,
									confirmed_at: order.confirmed_at
								},
								lines: orderLines.map((line) => ({
									product_code: line.product_code,
									product_name: line.product_name,
									quantity: line.quantity,
									unit_cost: line.unit_cost,
									tax_rate: line.tax_rate,
									line_total: line.line_total
								}))
							}
						}
					],
					metadata: {
						schema: 'norbital.crm.confirmed_purchase_order.v1',
						purchase_order_id: order.norbital_id,
						doc_no: order.doc_no
					}
				};
			});
		}
	}
} satisfies Pipelines;
