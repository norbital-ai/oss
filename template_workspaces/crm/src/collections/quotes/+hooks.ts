import { docNoSeriesPattern, nextDocNo } from '../../lib/numbering.js';
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

const WON_CONFIRMED_EDITABLE = [
	'warehouse_id',
	'logistics_owner_id',
	'shipping_terms',
	'payment_terms_days',
	'description'
] as const;

const FULFILLED_EDITABLE = ['logistics_owner_id'] as const;

async function assertActiveWarehouse(
	api: Parameters<NonNullable<NonNullable<Hooks['create']>['before']>>[0]['api'],
	warehouseId: string
): Promise<void> {
	const warehouse = await api.db.query.warehouses.findFirst({
		where: { norbital_id: { eq: warehouseId } }
	});
	if (!warehouse) throw new Error('Referenced warehouse does not exist.');
	if (!warehouse.active) throw new Error('Referenced warehouse is not active.');
}

function assertOnlyFieldsChanged(
	input: Record<string, unknown>,
	existing: Record<string, unknown>,
	allowed: readonly string[],
	status: QuoteStatus
): void {
	for (const key of Object.keys(input)) {
		if (key === 'status') continue;
		if (input[key] === undefined) continue;
		if (allowed.includes(key)) continue;
		if (input[key] !== existing[key]) {
			throw new Error(
				`A ${status} document is immutable. Revise by reopening to draft status first.`
			);
		}
	}
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
			if (input.warehouse_id != null) {
				await assertActiveWarehouse(api, input.warehouse_id);
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
			if (input.warehouse_id != null) {
				await assertActiveWarehouse(api, input.warehouse_id);
			}

			const newStatus = (input.status ?? existing.status) as QuoteStatus;
			const oldStatus = existing.status as QuoteStatus;

			if (oldStatus === newStatus) {
				if (oldStatus === 'draft') return input;
				if (oldStatus === 'won' || oldStatus === 'confirmed') {
					assertOnlyFieldsChanged(
						input as Record<string, unknown>,
						existing as Record<string, unknown>,
						WON_CONFIRMED_EDITABLE,
						oldStatus
					);
					return input;
				}
				if (oldStatus === 'fulfilled') {
					assertOnlyFieldsChanged(
						input as Record<string, unknown>,
						existing as Record<string, unknown>,
						FULFILLED_EDITABLE,
						oldStatus
					);
					return input;
				}
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
			if (newStatus === 'cancelled') {
				const cancelReason = input.cancel_reason ?? existing.cancel_reason;
				if (!cancelReason || String(cancelReason).trim() === '') {
					throw new Error('A cancellation reason is required.');
				}
				const payments = await api.db.query.payment_records.findMany({
					where: { quote_id: { eq: existing.norbital_id } },
					limit: 1
				});
				if (payments.length > 0) {
					throw new Error(
						'A document with recorded payments cannot be cancelled. Void the payments first.'
					);
				}
				if (existing.cancelled_at == null) updates.cancelled_at = timestamp;
			}

			return updates;
		}
	}
} satisfies Hooks;
