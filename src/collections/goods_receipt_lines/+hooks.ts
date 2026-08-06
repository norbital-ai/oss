import type { Hooks } from './$types.js';

export default {
	create: {
		before: async ({ input, api }) => {
			if (!input.goods_receipt_id) {
				throw new Error('A goods receipt line must reference a goods receipt.');
			}
			const receipt = await api.db.query.goods_receipts.findFirst({
				where: { norbital_id: { eq: input.goods_receipt_id } }
			});
			if (!receipt) throw new Error('Referenced goods receipt does not exist.');

			if (!input.purchase_order_line_id) {
				throw new Error('A goods receipt line must reference a purchase order line.');
			}
			const orderLine = await api.db.query.purchase_order_lines.findFirst({
				where: { norbital_id: { eq: input.purchase_order_line_id } }
			});
			if (!orderLine) throw new Error('Referenced purchase order line does not exist.');
			if (orderLine.purchase_order_id !== receipt.purchase_order_id) {
				throw new Error('The received line belongs to a different purchase order.');
			}

			const quantity = Number(input.quantity_received);
			if (Number.isNaN(quantity) || quantity <= 0) {
				throw new Error('Received quantity must be greater than zero.');
			}

			const prior = await api.db.query.goods_receipt_lines.findMany({
				where: { purchase_order_line_id: { eq: orderLine.norbital_id } },
				columns: { quantity_received: true },
				limit: 5000
			});
			const receivedSoFar = prior.reduce(
				(sum, line) => sum + Number(line.quantity_received ?? 0),
				0
			);
			const ordered = Number(orderLine.quantity ?? 0);
			if (receivedSoFar + quantity > ordered) {
				throw new Error(
					`Over-delivery: ${receivedSoFar} of ${ordered} received so far; this receipt would exceed the ordered quantity.`
				);
			}

			return { ...input, quantity_received: quantity };
		}
	}
} satisfies Hooks;
