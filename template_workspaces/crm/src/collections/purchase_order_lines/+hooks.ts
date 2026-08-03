import { documentTotals, lineAmounts } from '../../lib/pricing.js';
import type { Hooks, WorkspaceRow } from './$types.js';

type AfterApi = Parameters<NonNullable<NonNullable<Hooks['create']>['after']>>[0]['api'];

const LINE_LIMIT = 5000;

function requireCurrency(currency: string | null): string {
	if (!currency) throw new Error('Document currency is required.');
	return currency;
}

function validateLineFields(input: Record<string, unknown>): void {
	const quantity = Number(input.quantity);
	if (Number.isNaN(quantity) || quantity <= 0) {
		throw new Error('Quantity must be greater than zero.');
	}

	const unitCost = Number(input.unit_cost);
	if (input.unit_cost == null || Number.isNaN(unitCost)) {
		throw new Error('Unit cost is required.');
	}
	if (unitCost < 0) {
		throw new Error('Unit cost cannot be negative.');
	}

	const taxRate = Number(input.tax_rate ?? 0);
	if (taxRate < 0 || taxRate > 100) {
		throw new Error('Tax rate must be between 0 and 100.');
	}
}

function computeLineAmounts(order: WorkspaceRow<'purchase_orders'>, line: Record<string, unknown>) {
	return lineAmounts({
		quantity: Number(line.quantity),
		unit_price: Number(line.unit_cost),
		tax_rate: Number(line.tax_rate ?? 0),
		tax_inclusive: order.tax_inclusive,
		currency: requireCurrency(order.currency)
	});
}

async function rollupPurchaseOrder(api: AfterApi, purchaseOrderId: string): Promise<void> {
	const order = await api.db.query.purchase_orders.findFirst({
		where: { norbital_id: { eq: purchaseOrderId } }
	});
	if (!order) return;

	const lines = await api.db.query.purchase_order_lines.findMany({
		where: { purchase_order_id: { eq: purchaseOrderId } },
		columns: { net: true, tax: true, line_total: true },
		limit: LINE_LIMIT
	});

	const totals = documentTotals(
		lines.map((line) => ({
			net: Number(line.net ?? 0),
			tax: Number(line.tax ?? 0),
			gross: Number(line.line_total ?? 0)
		})),
		requireCurrency(order.currency)
	);

	await api.db.mutate('purchase_orders', [
		{
			norbital_id: purchaseOrderId,
			net: totals.net,
			tax: totals.tax,
			gross: totals.gross
		}
	]);
}

const afterRollup = async ({
	record,
	api
}: {
	readonly record: { readonly purchase_order_id: string };
	readonly api: AfterApi;
}) => {
	await rollupPurchaseOrder(api, record.purchase_order_id);
};

export default {
	create: {
		before: async ({ input, api }) => {
			if (!input.purchase_order_id) {
				throw new Error('A purchase order line must reference a purchase order.');
			}
			const order = await api.db.query.purchase_orders.findFirst({
				where: { norbital_id: { eq: input.purchase_order_id } }
			});
			if (!order) throw new Error('Referenced purchase order does not exist.');
			if (order.status !== 'draft') {
				throw new Error('Line items can only be added to draft purchase orders.');
			}

			if (!input.product_id) throw new Error('A purchase order line must reference a product.');
			const product = await api.db.query.products.findFirst({
				where: { norbital_id: { eq: input.product_id } }
			});
			if (!product) throw new Error('Referenced product does not exist.');

			const resolved = {
				...input,
				product_code: input.product_code ?? product.code,
				product_name: input.product_name ?? product.name,
				product_unit: input.product_unit ?? product.unit ?? '',
				unit_cost: input.unit_cost,
				tax_rate: input.tax_rate ?? 0
			};
			validateLineFields(resolved);

			const amounts = computeLineAmounts(order, resolved);
			return {
				...resolved,
				net: amounts.net,
				tax: amounts.tax,
				line_total: amounts.gross
			};
		},
		after: afterRollup
	},
	update: {
		before: async ({ input, existing, api }) => {
			if (
				input.purchase_order_id != null &&
				input.purchase_order_id !== existing.purchase_order_id
			) {
				throw new Error('A line item cannot be moved to a different purchase order.');
			}

			const order = await api.db.query.purchase_orders.findFirst({
				where: { norbital_id: { eq: existing.purchase_order_id } }
			});
			if (!order) throw new Error('Referenced purchase order does not exist.');
			if (order.status !== 'draft') {
				throw new Error('Line items can only be modified on draft purchase orders.');
			}

			const resolved = { ...existing, ...input };
			validateLineFields(resolved);

			const amounts = computeLineAmounts(order, resolved);
			return {
				...input,
				net: amounts.net,
				tax: amounts.tax,
				line_total: amounts.gross
			};
		},
		after: afterRollup
	},
	delete: {
		after: afterRollup
	}
} satisfies Hooks;
