import { docNoSeriesPattern, nextDocNo } from '../../lib/numbering.js';
import type { Hooks } from './$types.js';

type PurchaseOrderStatus = 'draft' | 'submitted' | 'confirmed' | 'received' | 'cancelled';

const VALID_TRANSITIONS: Record<PurchaseOrderStatus, readonly PurchaseOrderStatus[]> = {
	draft: ['submitted', 'cancelled', 'draft'],
	submitted: ['confirmed', 'cancelled', 'draft'],
	confirmed: ['received', 'cancelled'],
	received: [],
	cancelled: []
};

const SUBMITTED_CONFIRMED_EDITABLE = ['notes', 'warehouse_id', 'expected_date'] as const;

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
	status: PurchaseOrderStatus
): void {
	for (const key of Object.keys(input)) {
		if (key === 'status') continue;
		if (input[key] === undefined) continue;
		if (allowed.includes(key)) continue;
		if (input[key] !== existing[key]) {
			throw new Error(
				`A ${status} purchase order cannot change ${key}. Return the order to draft to edit it.`
			);
		}
	}
}

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

			if (input.warehouse_id != null) {
				await assertActiveWarehouse(api, input.warehouse_id);
			}

			const today = todayDateString();
			const resolved = {
				...input,
				supplier_code: supplier.code,
				supplier_name: supplier.name,
				currency: input.currency ?? supplier.currency,
				payment_terms_days: input.payment_terms_days ?? supplier.payment_terms_days,
				status: input.status ?? 'draft',
				tax_inclusive: input.tax_inclusive ?? true,
				net: input.net ?? 0,
				tax: input.tax ?? 0,
				gross: input.gross ?? 0,
				expected_date: input.expected_date ?? addDaysToDate(today, 14)
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
				if (oldStatus === 'submitted' || oldStatus === 'confirmed') {
					assertOnlyFieldsChanged(
						input as Record<string, unknown>,
						existing as Record<string, unknown>,
						SUBMITTED_CONFIRMED_EDITABLE,
						oldStatus
					);
					if (input.warehouse_id != null) {
						await assertActiveWarehouse(api, input.warehouse_id);
					}
					return input;
				}
				throw new Error(
					`A ${oldStatus} purchase order is immutable. Return the order to draft to edit it.`
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
				if (existing.submitted_at == null) updates.submitted_at = timestamp;
			}

			if (newStatus === 'confirmed' && existing.confirmed_at == null) {
				updates.confirmed_at = timestamp;
			}
			if (newStatus === 'received' && existing.received_at == null) {
				updates.received_at = timestamp;
			}

			if (newStatus === 'cancelled') {
				const cancelReason = input.cancel_reason ?? existing.cancel_reason;
				if (!cancelReason || String(cancelReason).trim() === '') {
					throw new Error('A cancellation reason is required.');
				}
				const payments = await api.db.query.payment_records.findMany({
					where: { purchase_order_id: { eq: existing.norbital_id } },
					limit: 1
				});
				if (payments.length > 0) {
					throw new Error(
						'A purchase order with recorded payments cannot be cancelled. Void the payments first.'
					);
				}
				if (existing.cancelled_at == null) updates.cancelled_at = timestamp;
			}

			return updates;
		}
	}
} satisfies Hooks;
