import { docNoSeriesPattern, nextDocNo } from '../../lib/numbering.js';
import type { Hooks } from './$types.js';

type InvoiceStatus = 'draft' | 'confirmed' | 'cancelled';

const VALID_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
	draft: ['confirmed', 'cancelled'],
	confirmed: [],
	cancelled: []
};

export default {
	create: {
		before: async ({ input, api }) => {
			if (!input.purchase_order_id) {
				throw new Error('A purchase invoice must reference a purchase order.');
			}
			const order = await api.db.query.purchase_orders.findFirst({
				where: { norbital_id: { eq: input.purchase_order_id } }
			});
			if (!order) throw new Error('Referenced purchase order does not exist.');
			if (order.status !== 'confirmed') {
				throw new Error('Invoices can only be booked against a confirmed purchase order.');
			}

			const resolved = {
				...input,
				supplier_id: order.supplier_id,
				supplier_code: order.supplier_code,
				supplier_name: order.supplier_name,
				currency: order.currency,
				tax_inclusive: order.tax_inclusive,
				status: input.status ?? 'draft',
				net: input.net ?? 0,
				tax: input.tax ?? 0,
				gross: input.gross ?? 0
			};

			if (!input.doc_no) {
				const year = new Date().getFullYear();
				const existing = await api.db.query.purchase_invoices.findMany({
					where: { doc_no: { like: docNoSeriesPattern('PI', year) } },
					columns: { doc_no: true },
					limit: 5000
				});
				return {
					...resolved,
					doc_no: nextDocNo(
						existing.map((row) => row.doc_no),
						'PI',
						year
					)
				};
			}

			return resolved;
		}
	},
	update: {
		before: async ({ input, existing, api }) => {
			const newStatus = (input.status ?? existing.status) as InvoiceStatus;
			const oldStatus = existing.status as InvoiceStatus;

			if (oldStatus === newStatus) {
				if (oldStatus === 'draft') return input;
				throw new Error(
					`A ${oldStatus} purchase invoice is immutable. Revise by booking a new invoice.`
				);
			}

			const allowed = VALID_TRANSITIONS[oldStatus];
			if (!allowed.includes(newStatus)) {
				throw new Error(
					`Invalid status transition: ${oldStatus} → ${newStatus}. Allowed: ${allowed.join(', ')}.`
				);
			}

			const updates: Record<string, unknown> = { ...input };

			if (newStatus === 'confirmed') {
				const lines = await api.db.query.purchase_invoice_lines.findMany({
					where: { purchase_invoice_id: { eq: existing.norbital_id } },
					limit: 1
				});
				if (lines.length === 0) {
					throw new Error(
						'A purchase invoice must have at least one line before it can be confirmed.'
					);
				}
				if (existing.confirmed_at == null) updates.confirmed_at = new Date();
			}

			if (newStatus === 'cancelled') {
				const cancelReason = input.cancel_reason ?? existing.cancel_reason;
				if (!cancelReason || String(cancelReason).trim() === '') {
					throw new Error('A cancellation reason is required.');
				}
				if (existing.cancelled_at == null) updates.cancelled_at = new Date();
			}

			return updates;
		}
	}
} satisfies Hooks;
