import type { Hooks } from './$types.js';

type QuoteStatus = 'draft' | 'sent' | 'won' | 'confirmed' | 'fulfilled' | 'cancelled' | 'lost';

const VALID_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
	draft: ['sent', 'won', 'lost', 'draft'],
	sent: ['draft', 'won', 'lost'],
	won: ['confirmed', 'cancelled', 'won'],
	confirmed: ['fulfilled', 'cancelled'],
	fulfilled: [],
	cancelled: [],
	lost: ['won']
};

const TERMINAL_STATES: readonly QuoteStatus[] = ['fulfilled', 'cancelled', 'lost'];

function nextDocNo(existingNumbers: string[], prefix: string, year: number): string {
	const yearStr = year.toString();
	const pattern = `${prefix}-${yearStr}-`;
	let maxSeq = 0;
	for (const num of existingNumbers) {
		if (!num.startsWith(pattern)) continue;
		const seqPart = num.slice(pattern.length);
		const seq = parseInt(seqPart, 10);
		if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq;
	}
	return `${pattern}${String(maxSeq + 1).padStart(4, '0')}`;
}

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
			if (input.project_id != null) {
				const project = await api.db.query.projects.findFirst({
					where: { norbital_id: { eq: input.project_id } }
				});
				if (!project) throw new Error('Referenced project does not exist.');
			}

			if (!input.doc_no) {
				const year = new Date().getFullYear();
				const existing = await api.db.query.quotes.findMany({
					where: { doc_no: { like: `QT-${year}-%` } },
					columns: { doc_no: true },
					limit: 5000
				});
				return {
					...input,
					doc_no: nextDocNo(
						existing.map((r) => r.doc_no),
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
				if (oldStatus !== 'draft') {
					throw new Error(
						`A ${oldStatus} document is immutable. Revise by reopening to draft status first.`
					);
				}
				return input;
			}

			const allowed = VALID_TRANSITIONS[oldStatus];
			if (!allowed.includes(newStatus)) {
				throw new Error(
					`Invalid status transition: ${oldStatus} → ${newStatus}. Allowed: ${allowed.join(', ')}.`
				);
			}

			const updates: Record<string, unknown> = { ...input };
			const timestamp = new Date();

			if (newStatus === 'confirmed' && existing.confirmed_at == null) {
				updates.confirmed_at = timestamp;
			}
			if (newStatus === 'fulfilled' && existing.fulfilled_at == null) {
				updates.fulfilled_at = timestamp;
			}
			if (newStatus === 'draft' && oldStatus === 'sent') {
				const currentRev = Number(existing.revision_number ?? 1);
				const originalId = existing.revision_of ?? existing.norbital_id;
				updates.revision_number = currentRev + 1;
				updates.revision_of = originalId;
			}
			if (TERMINAL_STATES.includes(newStatus) && newStatus === 'cancelled') {
				const payments = await api.db.query.payment_records.findMany({
					where: { quote_id: { eq: existing.norbital_id } },
					limit: 1
				});
				if (payments.length > 0) {
					throw new Error(
						'A document with recorded payments cannot be cancelled. Void the payments first.'
					);
				}
			}

			return updates;
		}
	}
} satisfies Hooks;
