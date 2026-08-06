import { defineQueryHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

/**
 * The three-way match for one purchase order: ordered quantity from the order lines,
 * received quantity from goods receipts, invoiced quantity from live purchase invoices.
 * Cancelled invoices do not count toward invoiced; receipts are immutable events.
 */
export default defineQueryHandler({
	schema: z.object({ purchase_order_id: z.string() }),
	handler: async (input, api) => {
		const orderLines = await api.db.query.purchase_order_lines.findMany({
			where: { purchase_order_id: { eq: input.purchase_order_id } },
			columns: {
				norbital_id: true,
				product_code: true,
				product_name: true,
				quantity: true
			},
			limit: 5000
		});
		const lineIds = orderLines
			.map((line) => line.norbital_id)
			.filter((id): id is string => typeof id === 'string');
		if (lineIds.length === 0) return { lines: [] };

		const [receiptLines, invoiceLines] = await Promise.all([
			api.db.query.goods_receipt_lines.findMany({
				where: { purchase_order_line_id: { in: lineIds } },
				columns: { purchase_order_line_id: true, quantity_received: true },
				limit: 5000
			}),
			(async () => {
				const raw = await api.db.query.purchase_invoice_lines.findMany({
					where: { purchase_order_line_id: { in: lineIds } },
					columns: {
						purchase_order_line_id: true,
						purchase_invoice_id: true,
						quantity: true
					},
					limit: 5000
				});
				const invoiceIds = [
					...new Set(
						raw
							.map((line) => line.purchase_invoice_id)
							.filter((id): id is string => typeof id === 'string')
					)
				];
				if (invoiceIds.length === 0) return [];
				const invoices = await api.db.query.purchase_invoices.findMany({
					where: { norbital_id: { in: invoiceIds } },
					columns: { norbital_id: true, status: true },
					limit: 5000
				});
				const live = new Set(
					invoices
						.filter((invoice) => invoice.status !== 'cancelled')
						.map((invoice) => invoice.norbital_id)
				);
				return raw.filter((line) => live.has(line.purchase_invoice_id));
			})()
		]);

		const received = new Map<string, number>();
		for (const line of receiptLines) {
			const id = String(line.purchase_order_line_id);
			received.set(id, (received.get(id) ?? 0) + Number(line.quantity_received ?? 0));
		}
		const invoiced = new Map<string, number>();
		for (const line of invoiceLines) {
			const id = String(line.purchase_order_line_id);
			invoiced.set(id, (invoiced.get(id) ?? 0) + Number(line.quantity ?? 0));
		}

		return {
			lines: orderLines.map((line) => {
				const ordered = Number(line.quantity ?? 0);
				const receivedQty = received.get(String(line.norbital_id)) ?? 0;
				const invoicedQty = invoiced.get(String(line.norbital_id)) ?? 0;
				return {
					purchase_order_line_id: line.norbital_id,
					product_code: line.product_code,
					product_name: line.product_name,
					ordered,
					received: receivedQty,
					invoiced: invoicedQty,
					remaining_to_receive: ordered - receivedQty
				};
			})
		};
	}
});
