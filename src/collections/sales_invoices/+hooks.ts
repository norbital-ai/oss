import { docNoSeriesPattern, nextDocNo } from '../../lib/numbering.js';
import type { Hooks } from './$types.js';

type InvoiceStatus = 'draft' | 'issued' | 'cancelled';

const VALID_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
	draft: ['issued', 'cancelled'],
	issued: [],
	cancelled: []
};

export default {
	create: {
		before: async ({ input, api }) => {
			if (!input.quote_id) throw new Error('A sales invoice must reference a quote.');
			const quote = await api.db.query.quotes.findFirst({
				where: { norbital_id: { eq: input.quote_id } }
			});
			if (!quote) throw new Error('Referenced quote does not exist.');
			if (quote.status !== 'confirmed') {
				throw new Error('Invoices can only be raised against a confirmed quote.');
			}

			const resolved = {
				...input,
				account_id: quote.account_id,
				currency: quote.currency,
				tax_inclusive: quote.tax_inclusive,
				status: input.status ?? 'draft',
				net: input.net ?? 0,
				tax: input.tax ?? 0,
				gross: input.gross ?? 0
			};

			if (!input.doc_no) {
				const year = new Date().getFullYear();
				const existing = await api.db.query.sales_invoices.findMany({
					where: { doc_no: { like: docNoSeriesPattern('SI', year) } },
					columns: { doc_no: true },
					limit: 5000
				});
				return {
					...resolved,
					doc_no: nextDocNo(
						existing.map((row) => row.doc_no),
						'SI',
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
					`An ${oldStatus} sales invoice is immutable. Revise by raising a new invoice.`
				);
			}

			const allowed = VALID_TRANSITIONS[oldStatus];
			if (!allowed.includes(newStatus)) {
				throw new Error(
					`Invalid status transition: ${oldStatus} → ${newStatus}. Allowed: ${allowed.join(', ')}.`
				);
			}

			const updates: Record<string, unknown> = { ...input };

			if (newStatus === 'issued') {
				const lines = await api.db.query.sales_invoice_lines.findMany({
					where: { sales_invoice_id: { eq: existing.norbital_id } },
					limit: 1
				});
				if (lines.length === 0) {
					throw new Error('A sales invoice must have at least one line before it can be issued.');
				}
				if (existing.issued_at == null) updates.issued_at = new Date();
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
