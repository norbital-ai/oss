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
			if (!account.active) {
				throw new Error('Cannot create a quote for an inactive account.');
			}
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
		before: async ({ input, existing, api }) => {
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

			if (newStatus === 'confirmed') {
				const account = await api.db.query.accounts.findFirst({
					where: { norbital_id: { eq: existing.account_id } }
				});
				if (!account) throw new Error('Referenced account does not exist.');
				if (!account.active) {
					throw new Error('Cannot confirm a quote for an inactive account.');
				}

				// Credit is warn-never-blocks: an adverse verdict does not refuse the confirm, it
				// demands an explicit acknowledgment that lands on the document and in its audit trail.
				const creditAdverse =
					account.credit_hold === true ||
					(account.credit_limit != null &&
						account.credit_used != null &&
						Number(account.credit_used) + Number(existing.gross ?? 0) >
							Number(account.credit_limit));
				const acknowledged =
					input.credit_acknowledged === true || existing.credit_acknowledged === true;
				if (creditAdverse && !acknowledged) {
					throw new Error(
						'Credit check is adverse (hold or over-limit). Set credit_acknowledged to confirm anyway.'
					);
				}

				const lines = await api.db.query.quote_lines.findMany({
					where: { quote_id: { eq: existing.norbital_id } },
					columns: { product_id: true },
					limit: 5000
				});
				if (lines.length === 0) {
					throw new Error('A quote must have at least one line before it can be confirmed.');
				}

				const productIds = [
					...new Set(
						lines
							.map((line) => line.product_id)
							.filter((id): id is string => typeof id === 'string')
					)
				];
				const products = await api.db.query.products.findMany({
					where: { norbital_id: { in: productIds } },
					columns: { name: true, active: true },
					limit: 5000
				});
				const inactiveProducts = products
					.filter((product) => !product.active)
					.map((product) => product.name);
				if (inactiveProducts.length > 0) {
					throw new Error(
						`Cannot confirm a quote with inactive products: ${inactiveProducts.join(', ')}.`
					);
				}
			}

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
