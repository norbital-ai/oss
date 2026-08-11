import { deskToday } from '../../lib/calendar.js';
import { docNoSeriesPattern, nextDocNo } from '../../lib/numbering.js';
import type { Hooks } from './$types.js';

export default {
	create: {
		before: {
			description:
				'Accepts a receipt only against a confirmed purchase order, defaults the received date to today, and assigns the next GRN document number for the year.',
			handler: async ({ input, api }) => {
				if (!input.purchase_order_id) {
					throw new Error('A goods receipt must reference a purchase order.');
				}
				const order = await api.db.query.purchase_orders.findFirst({
					where: { norbital_id: { eq: input.purchase_order_id } }
				});
				if (!order) throw new Error('Referenced purchase order does not exist.');
				if (order.status !== 'confirmed') {
					throw new Error('Goods can only be received against a confirmed purchase order.');
				}

				const resolved = {
					...input,
					received_date: input.received_date ?? deskToday(),
					received_at: input.received_at ?? new Date()
				};

				if (!input.doc_no) {
					const year = new Date().getFullYear();
					const existing = await api.db.query.goods_receipts.findMany({
						where: { doc_no: { like: docNoSeriesPattern('GRN', year) } },
						columns: { doc_no: true },
						limit: 5000
					});
					return {
						...resolved,
						doc_no: nextDocNo(
							existing.map((row) => row.doc_no),
							'GRN',
							year
						)
					};
				}

				return resolved;
			}
		}
	}
} satisfies Hooks;
