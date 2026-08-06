import type { Hooks } from './$types.js';

const COMMITTED_TARGETS = {
	quotes: 'confirmed',
	purchase_orders: 'confirmed',
	purchase_invoices: 'confirmed'
} as const;

type TargetType = keyof typeof COMMITTED_TARGETS;

export default {
	create: {
		before: async ({ input, api }) => {
			const regardingType = input.regarding_type as TargetType | undefined;
			if (!regardingType || !(regardingType in COMMITTED_TARGETS)) {
				throw new Error(
					'A settlement must reference a quote, purchase order, or purchase invoice.'
				);
			}
			if (!input.regarding_id) throw new Error('A settlement must reference a document.');

			const amount = Number(input.amount);
			if (Number.isNaN(amount) || amount <= 0) {
				throw new Error('Settlement amount must be greater than zero.');
			}

			if (regardingType === 'quotes') {
				const quote = await api.db.query.quotes.findFirst({
					where: { norbital_id: { eq: input.regarding_id } }
				});
				if (!quote) throw new Error('Referenced quote does not exist.');
				if (quote.status !== 'confirmed') {
					throw new Error('Settlements can only be recorded against a confirmed quote.');
				}
				if (input.currency && quote.currency && input.currency !== quote.currency) {
					throw new Error('Settlement currency must match the document currency.');
				}
				return { ...input, currency: input.currency ?? quote.currency };
			}

			if (regardingType === 'purchase_orders') {
				const order = await api.db.query.purchase_orders.findFirst({
					where: { norbital_id: { eq: input.regarding_id } }
				});
				if (!order) throw new Error('Referenced purchase order does not exist.');
				if (order.status !== 'confirmed') {
					throw new Error('Settlements can only be recorded against a confirmed purchase order.');
				}
				if (input.currency && order.currency && input.currency !== order.currency) {
					throw new Error('Settlement currency must match the document currency.');
				}
				return { ...input, currency: input.currency ?? order.currency };
			}

			const invoice = await api.db.query.purchase_invoices.findFirst({
				where: { norbital_id: { eq: input.regarding_id } }
			});
			if (!invoice) throw new Error('Referenced purchase invoice does not exist.');
			if (invoice.status !== 'confirmed') {
				throw new Error('Settlements can only be recorded against a confirmed purchase invoice.');
			}
			if (input.currency && invoice.currency && input.currency !== invoice.currency) {
				throw new Error('Settlement currency must match the document currency.');
			}
			return { ...input, currency: input.currency ?? invoice.currency };
		}
	}
} satisfies Hooks;
