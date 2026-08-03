import { docNoSeriesPattern, nextDocNo } from '../../lib/numbering.js';
import type { Hooks } from './$types.js';

type QuoteStatus = 'draft' | 'sent' | 'won' | 'confirmed' | 'lost' | 'cancelled';

const VALID_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
	draft: ['sent', 'won', 'lost', 'cancelled'],
	sent: ['draft', 'won', 'lost'],
	won: ['confirmed', 'lost', 'cancelled'],
	confirmed: [],
	lost: ['won'],
	cancelled: []
};

export default {
	create: {
		before: async ({ input, api }) => {
			if (!input.account_id) throw new Error('A quote must reference an account.');
			const account = await api.db.query.accounts.findFirst({
				where: { norbital_id: { eq: input.account_id } }
			});
			if (!account) throw new Error('Referenced account does not exist.');
			if (input.contact_id != null) {
				const contact = await api.db.query.contacts.findFirst({
					where: { norbital_id: { eq: input.contact_id } }
				});
				if (!contact) throw new Error('Referenced contact does not exist.');
			}

			if (!input.doc_no) {
				const year = new Date().getFullYear();
				const existing = await api.db.query.quotes.findMany({
					where: { doc_no: { like: docNoSeriesPattern('QT', year) } },
					columns: { doc_no: true },
					limit: 5000
				});
				return {
					...input,
					doc_no: nextDocNo(
						existing.map((row) => row.doc_no),
						'QT',
						year
					),
					status: input.status ?? 'draft',
					revision_number: input.revision_number ?? 1
				};
			}

			return {
				...input,
				status: input.status ?? 'draft',
				revision_number: input.revision_number ?? 1
			};
		}
	},
	update: {
		before: async ({ input, existing }) => {
			const newStatus = (input.status ?? existing.status) as QuoteStatus;
			const oldStatus = existing.status as QuoteStatus;

			if (oldStatus === newStatus) {
				if (oldStatus === 'draft') return input;
				throw new Error(
					`A ${oldStatus} document is immutable. Revise by reopening to draft status first.`
				);
			}

			const allowed = VALID_TRANSITIONS[oldStatus];
			if (!allowed.includes(newStatus)) {
				throw new Error(
					`Invalid status transition: ${oldStatus} → ${newStatus}. Allowed: ${allowed.join(', ')}.`
				);
			}

			const updates: Record<string, unknown> = { ...input };

			if (newStatus === 'confirmed' && existing.confirmed_at == null) {
				updates.confirmed_at = new Date();
			}

			if (newStatus === 'draft' && oldStatus === 'sent') {
				const currentRev = Number(existing.revision_number ?? 1);
				const originalId = existing.revision_of ?? existing.norbital_id;
				updates.revision_number = currentRev + 1;
				updates.revision_of = originalId;
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
