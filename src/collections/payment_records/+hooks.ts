import type { Hooks } from './$types.js';

const SALES_STATUSES_CLOSED_TO_PAYMENT = ['draft', 'sent'] as const;
const SALES_STATUSES_REFUSING_PAYMENT = ['cancelled', 'lost'] as const;
const PURCHASE_STATUSES_CLOSED_TO_PAYMENT = ['draft'] as const;

export default {
	create: {
		before: async ({ input, api }) => {
			const hasQuote = input.quote_id != null;
			const hasPurchaseOrder = input.purchase_order_id != null;
			if (hasQuote === hasPurchaseOrder) {
				throw new Error(
					'A payment must reference exactly one document — either a sales document or a purchase order.'
				);
			}

			if (!input.amount?.value || input.amount.value <= 0) {
				throw new Error('Payment amount must be greater than zero.');
			}

			if (input.quote_id != null) {
				const quote = await api.db.query.quotes.findFirst({
					where: { norbital_id: { eq: input.quote_id } }
				});
				if (!quote) throw new Error('Referenced sales document does not exist.');
				if (SALES_STATUSES_CLOSED_TO_PAYMENT.some((status) => status === quote.status)) {
					throw new Error(
						'Payments can only be recorded against confirmed, fulfilled, or won documents.'
					);
				}
				if (SALES_STATUSES_REFUSING_PAYMENT.some((status) => status === quote.status)) {
					throw new Error('Payments cannot be recorded against cancelled or lost documents.');
				}
				if (input.amount.currency !== quote.currency) {
					throw new Error(
						`Payment currency (${input.amount.currency}) must match the document currency (${quote.currency}).`
					);
				}
				return { ...input, direction: input.direction ?? ('incoming' as const) };
			}

			if (input.purchase_order_id == null) {
				throw new Error(
					'A payment must reference exactly one document — either a sales document or a purchase order.'
				);
			}

			const purchaseOrder = await api.db.query.purchase_orders.findFirst({
				where: { norbital_id: { eq: input.purchase_order_id } }
			});
			if (!purchaseOrder) throw new Error('Referenced purchase order does not exist.');
			if (PURCHASE_STATUSES_CLOSED_TO_PAYMENT.some((status) => status === purchaseOrder.status)) {
				throw new Error('Payments can only be recorded against a submitted purchase order.');
			}
			if (purchaseOrder.status === 'cancelled') {
				throw new Error('Payments cannot be recorded against a cancelled purchase order.');
			}
			if (input.amount.currency !== purchaseOrder.currency) {
				throw new Error(
					`Payment currency (${input.amount.currency}) must match the purchase order currency (${purchaseOrder.currency}).`
				);
			}
			return { ...input, direction: input.direction ?? ('outgoing' as const) };
		}
	},
	update: {
		before: async ({ input, existing }) => {
			// Re-pointing a settled payment at a different document silently rewrites two documents'
			// paid figures, so the reference is fixed once the row exists.
			if (input.quote_id != null && input.quote_id !== existing.quote_id) {
				throw new Error('A payment cannot be moved to a different sales document.');
			}
			if (
				input.purchase_order_id != null &&
				input.purchase_order_id !== existing.purchase_order_id
			) {
				throw new Error('A payment cannot be moved to a different purchase order.');
			}
			if (input.amount != null && (!input.amount.value || input.amount.value <= 0)) {
				throw new Error('Payment amount must be greater than zero.');
			}
			return input;
		}
	}
} satisfies Hooks;
