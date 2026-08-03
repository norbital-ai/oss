import { docNoSeriesPattern, nextDocNo } from '../../lib/numbering.js';
import type { Hooks } from './$types.js';

type InvoiceStatus = 'draft' | 'issued' | 'settled' | 'cancelled';

const VALID_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
	draft: ['issued', 'cancelled', 'draft'],
	issued: ['settled', 'cancelled'],
	settled: [],
	cancelled: []
};

function todayDateString(): string {
	return new Date().toISOString().slice(0, 10);
}

function addDaysToDate(dateStr: string, days: number): string {
	const date = new Date(`${dateStr}T00:00:00`);
	date.setDate(date.getDate() + days);
	return date.toISOString().slice(0, 10);
}

function assertOnlyFieldsChanged(
	input: Record<string, unknown>,
	existing: Record<string, unknown>,
	allowed: readonly string[],
	status: InvoiceStatus
): void {
	for (const key of Object.keys(input)) {
		if (key === 'status') continue;
		if (input[key] === undefined) continue;
		if (allowed.includes(key)) continue;
		if (input[key] !== existing[key]) {
			throw new Error(
				`An ${status} invoice cannot change ${key}. Return the invoice to draft to edit it.`
			);
		}
	}
}

export default {
	create: {
		before: async ({ input, api }) => {
			if (!input.quote_id) throw new Error('An invoice must reference a sales document.');
			const quote = await api.db.query.quotes.findFirst({
				where: { norbital_id: { eq: input.quote_id } }
			});
			if (!quote) throw new Error('Referenced sales document does not exist.');
			if (quote.status !== 'confirmed' && quote.status !== 'fulfilled') {
				throw new Error(
					'An invoice can only be raised against a confirmed or fulfilled sales document.'
				);
			}

			if (input.account_id != null && input.account_id !== quote.account_id) {
				throw new Error('Invoice account must match the sales document account.');
			}

			const currency = input.currency ?? quote.currency;
			if (input.currency != null && input.currency !== quote.currency) {
				throw new Error('Invoice currency must match the sales document currency.');
			}

			const taxInclusive = input.tax_inclusive ?? quote.tax_inclusive;
			if (input.tax_inclusive != null && input.tax_inclusive !== quote.tax_inclusive) {
				throw new Error('Invoice tax treatment must match the sales document.');
			}

			const issueDate = input.issue_date ?? todayDateString();
			let dueDate = input.due_date;
			if (dueDate == null && quote.payment_terms_days != null) {
				dueDate = addDaysToDate(issueDate, Number(quote.payment_terms_days));
			}

			const resolved = {
				...input,
				account_id: quote.account_id,
				currency,
				tax_inclusive: taxInclusive,
				status: input.status ?? 'draft',
				issue_date: issueDate,
				due_date: dueDate,
				net: input.net ?? 0,
				tax: input.tax ?? 0,
				gross: input.gross ?? 0
			};

			if (!input.doc_no) {
				const year = new Date().getFullYear();
				const existing = await api.db.query.invoices.findMany({
					where: { doc_no: { like: docNoSeriesPattern('INV', year) } },
					columns: { doc_no: true },
					limit: 5000
				});
				return {
					...resolved,
					doc_no: nextDocNo(
						existing.map((row) => row.doc_no),
						'INV',
						year
					)
				};
			}

			return resolved;
		}
	},
	update: {
		before: async ({ input, existing, api }) => {
			if (input.quote_id != null && input.quote_id !== existing.quote_id) {
				throw new Error('Sales document cannot be changed on an invoice.');
			}

			const newStatus = (input.status ?? existing.status) as InvoiceStatus;
			const oldStatus = existing.status as InvoiceStatus;

			if (oldStatus === newStatus) {
				if (oldStatus === 'draft') return input;
				if (oldStatus === 'issued') {
					assertOnlyFieldsChanged(
						input as Record<string, unknown>,
						existing as Record<string, unknown>,
						['notes', 'due_date'],
						oldStatus
					);
					return input;
				}
				throw new Error(
					`A ${oldStatus} invoice is immutable. Return the invoice to draft to edit it.`
				);
			}

			const allowed = VALID_TRANSITIONS[oldStatus];
			if (!allowed.includes(newStatus)) {
				throw new Error(
					`Invalid status transition: ${oldStatus} → ${newStatus}. Allowed: ${allowed.join(', ')}.`
				);
			}

			const updates: Record<string, unknown> = { ...input };
			const timestamp = new Date();

			if (newStatus === 'issued') {
				const lines = await api.db.query.invoice_lines.findMany({
					where: { invoice_id: { eq: existing.norbital_id } },
					limit: 1
				});
				if (lines.length === 0) {
					throw new Error('An invoice must have at least one line before it can be issued.');
				}
				if (existing.issued_at == null) updates.issued_at = timestamp;
			}

			if (newStatus === 'settled' && existing.settled_at == null) {
				updates.settled_at = timestamp;
			}

			if (newStatus === 'cancelled') {
				const cancelReason = input.cancel_reason ?? existing.cancel_reason;
				if (!cancelReason || String(cancelReason).trim() === '') {
					throw new Error('A cancellation reason is required.');
				}
				if (existing.cancelled_at == null) updates.cancelled_at = timestamp;
			}

			return updates;
		}
	}
} satisfies Hooks;
