import { deskToday, shiftCalendarDate } from '../../lib/calendar.js';
import { docNoSeriesPattern, nextDocNo } from '../../lib/numbering.js';
import type { Hooks } from './$types.js';

type PurchaseOrderStatus = 'draft' | 'submitted' | 'confirmed' | 'cancelled';

const VALID_TRANSITIONS: Record<PurchaseOrderStatus, readonly PurchaseOrderStatus[]> = {
	draft: ['submitted', 'cancelled'],
	submitted: ['confirmed', 'cancelled'],
	confirmed: [],
	cancelled: []
};

export default {
	create: {
		before: async ({ input, api }) => {
			if (!input.supplier_id) throw new Error('A purchase order must reference a supplier.');
			const supplier = await api.db.query.suppliers.findFirst({
				where: { norbital_id: { eq: input.supplier_id } }
			});
			if (!supplier) throw new Error('Referenced supplier does not exist.');
			if (!supplier.active) {
				throw new Error('Cannot create a purchase order for an inactive supplier.');
			}

			const resolved = {
				...input,
				supplier_code: supplier.code,
				supplier_name: supplier.name,
				currency: input.currency ?? supplier.currency,
				status: input.status ?? 'draft',
				tax_inclusive: input.tax_inclusive ?? true,
				net: input.net ?? 0,
				tax: input.tax ?? 0,
				gross: input.gross ?? 0,
				expected_date: input.expected_date ?? shiftCalendarDate(deskToday(), 14)
			};

			if (!input.doc_no) {
				const year = new Date().getFullYear();
				const existing = await api.db.query.purchase_orders.findMany({
					where: { doc_no: { like: docNoSeriesPattern('PO', year) } },
					columns: { doc_no: true },
					limit: 5000
				});
				return {
					...resolved,
					doc_no: nextDocNo(
						existing.map((row) => row.doc_no),
						'PO',
						year
					)
				};
			}

			return resolved;
		}
	},
	update: {
		before: async ({ input, existing, api }) => {
			if (input.supplier_id != null && input.supplier_id !== existing.supplier_id) {
				throw new Error('Supplier cannot be changed on a purchase order.');
			}

			const newStatus = (input.status ?? existing.status) as PurchaseOrderStatus;
			const oldStatus = existing.status as PurchaseOrderStatus;

			if (oldStatus === newStatus) {
				if (oldStatus === 'draft') return input;
				throw new Error(
					`A ${oldStatus} purchase order is immutable. Revise by starting a new order.`
				);
			}

			const allowed = VALID_TRANSITIONS[oldStatus];
			if (!allowed.includes(newStatus)) {
				throw new Error(
					`Invalid status transition: ${oldStatus} → ${newStatus}. Allowed: ${allowed.join(', ')}.`
				);
			}

			const updates: Record<string, unknown> = { ...input };

			if (newStatus === 'submitted') {
				const lines = await api.db.query.purchase_order_lines.findMany({
					where: { purchase_order_id: { eq: existing.norbital_id } },
					limit: 1
				});
				if (lines.length === 0) {
					throw new Error(
						'A purchase order must have at least one line before it can be submitted.'
					);
				}
			}

			if (newStatus === 'confirmed' && existing.confirmed_at == null) {
				updates.confirmed_at = new Date();
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
