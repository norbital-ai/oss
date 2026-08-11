import { documentTotals, lineAmounts } from '../../lib/pricing.js';
import type { Hooks, WorkspaceRow } from './$types.js';

type AfterApi = Parameters<NonNullable<NonNullable<Hooks['create']>['after']>['handler']>[0]['api'];
type BeforeApi = Parameters<
	NonNullable<NonNullable<Hooks['create']>['before']>['handler']
>[0]['api'];

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
	if (unitCost < 0) throw new Error('Unit cost cannot be negative.');
	const taxRate = Number(input.tax_rate ?? 0);
	if (taxRate < 0 || taxRate > 100) {
		throw new Error('Tax rate must be between 0 and 100.');
	}
}

/** Invoiced quantity on live (non-cancelled) invoices for one order line. */
async function liveInvoicedQuantity(api: BeforeApi, orderLineId: string): Promise<number> {
	const lines = await api.db.query.purchase_invoice_lines.findMany({
		where: { purchase_order_line_id: { eq: orderLineId } },
		columns: { purchase_invoice_id: true, quantity: true },
		limit: LINE_LIMIT
	});
	const invoiceIds = [
		...new Set(
			lines
				.map((line) => line.purchase_invoice_id)
				.filter((id): id is string => typeof id === 'string')
		)
	];
	if (invoiceIds.length === 0) return 0;
	const invoices = await api.db.query.purchase_invoices.findMany({
		where: { norbital_id: { in: invoiceIds } },
		columns: { norbital_id: true, status: true },
		limit: LINE_LIMIT
	});
	const live = new Set(
		invoices
			.filter((invoice) => invoice.status !== 'cancelled')
			.map((invoice) => invoice.norbital_id)
	);
	return lines
		.filter((line) => live.has(line.purchase_invoice_id))
		.reduce((sum, line) => sum + Number(line.quantity ?? 0), 0);
}

function computeLineAmounts(
	invoice: WorkspaceRow<'purchase_invoices'>,
	line: Record<string, unknown>
) {
	return lineAmounts({
		quantity: Number(line.quantity),
		unit_price: Number(line.unit_cost),
		tax_rate: Number(line.tax_rate ?? 0),
		tax_inclusive: invoice.tax_inclusive,
		currency: requireCurrency(invoice.currency)
	});
}

async function rollupInvoice(api: AfterApi, invoiceId: string): Promise<void> {
	const invoice = await api.db.query.purchase_invoices.findFirst({
		where: { norbital_id: { eq: invoiceId } }
	});
	if (!invoice) return;

	const lines = await api.db.query.purchase_invoice_lines.findMany({
		where: { purchase_invoice_id: { eq: invoiceId } },
		columns: { net: true, tax: true, line_total: true },
		limit: LINE_LIMIT
	});

	const totals = documentTotals(
		lines.map((line) => ({
			net: Number(line.net ?? 0),
			tax: Number(line.tax ?? 0),
			gross: Number(line.line_total ?? 0)
		})),
		requireCurrency(invoice.currency)
	);

	await api.db.mutate('purchase_invoices', [
		{ norbital_id: invoiceId, net: totals.net, tax: totals.tax, gross: totals.gross }
	]);
}

const afterRollup = async ({
	record,
	api
}: {
	readonly record: { readonly purchase_invoice_id: string };
	readonly api: AfterApi;
}) => {
	await rollupInvoice(api, record.purchase_invoice_id);
};

export default {
	create: {
		before: {
			description:
				'Matches an invoice line to a purchase order line on the same order and refuses to invoice more than was ordered, counting only lines on invoices that are not cancelled.',
			handler: async ({ input, api }) => {
				if (!input.purchase_invoice_id) {
					throw new Error('A purchase invoice line must reference a purchase invoice.');
				}
				const invoice = await api.db.query.purchase_invoices.findFirst({
					where: { norbital_id: { eq: input.purchase_invoice_id } }
				});
				if (!invoice) throw new Error('Referenced purchase invoice does not exist.');
				if (invoice.status !== 'draft') {
					throw new Error('Lines can only be added to draft purchase invoices.');
				}

				if (!input.purchase_order_line_id) {
					throw new Error('A purchase invoice line must reference a purchase order line.');
				}
				const orderLine = await api.db.query.purchase_order_lines.findFirst({
					where: { norbital_id: { eq: input.purchase_order_line_id } }
				});
				if (!orderLine) throw new Error('Referenced purchase order line does not exist.');
				if (orderLine.purchase_order_id !== invoice.purchase_order_id) {
					throw new Error('The invoiced line belongs to a different purchase order.');
				}

				const resolved = {
					...input,
					product_code: input.product_code ?? orderLine.product_code,
					product_name: input.product_name ?? orderLine.product_name,
					unit_cost: input.unit_cost ?? orderLine.unit_cost,
					tax_rate: input.tax_rate ?? orderLine.tax_rate ?? 0
				};
				validateLineFields(resolved);

				const invoiced = await liveInvoicedQuantity(api, orderLine.norbital_id);
				const ordered = Number(orderLine.quantity ?? 0);
				if (invoiced + Number(resolved.quantity) > ordered) {
					throw new Error(
						`Over-invoice: ${invoiced} of ${ordered} invoiced so far; this line would exceed the ordered quantity.`
					);
				}

				const amounts = computeLineAmounts(invoice, resolved);
				return {
					...resolved,
					net: amounts.net,
					tax: amounts.tax,
					line_total: amounts.gross
				};
			}
		},
		after: {
			description:
				'Recomputes the purchase invoice net, tax and gross from its lines after a line is added.',
			handler: afterRollup
		}
	},
	update: {
		before: {
			description:
				'Keeps a line on its own draft invoice, re-prices it from the changed quantity or unit cost, and refuses to push the invoiced quantity past the quantity ordered.',
			handler: async ({ input, existing, api }) => {
				if (
					input.purchase_invoice_id != null &&
					input.purchase_invoice_id !== existing.purchase_invoice_id
				) {
					throw new Error('A line cannot be moved to a different purchase invoice.');
				}

				const invoice = await api.db.query.purchase_invoices.findFirst({
					where: { norbital_id: { eq: existing.purchase_invoice_id } }
				});
				if (!invoice) throw new Error('Referenced purchase invoice does not exist.');
				if (invoice.status !== 'draft') {
					throw new Error('Lines can only be modified on draft purchase invoices.');
				}

				const resolved = { ...existing, ...input };
				validateLineFields(resolved);

				const orderLine = await api.db.query.purchase_order_lines.findFirst({
					where: { norbital_id: { eq: existing.purchase_order_line_id } }
				});
				if (orderLine) {
					const invoiced = await liveInvoicedQuantity(api, orderLine.norbital_id);
					const ordered = Number(orderLine.quantity ?? 0);
					const own = Number(existing.quantity ?? 0);
					if (invoiced - own + Number(resolved.quantity) > ordered) {
						throw new Error(
							`Over-invoice: this line would push invoiced quantity past the ordered ${ordered}.`
						);
					}
				}

				const amounts = computeLineAmounts(invoice, resolved);
				return { ...input, net: amounts.net, tax: amounts.tax, line_total: amounts.gross };
			}
		},
		after: {
			description:
				'Recomputes the purchase invoice net, tax and gross from its lines after a line is changed.',
			handler: afterRollup
		}
	},
	delete: {
		after: {
			description:
				'Recomputes the purchase invoice net, tax and gross from its lines after a line is removed.',
			handler: afterRollup
		}
	}
} satisfies Hooks;
