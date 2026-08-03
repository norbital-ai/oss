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

	const unitPrice = Number(input.unit_price);
	if (Number.isNaN(unitPrice) || unitPrice < 0) {
		throw new Error('Unit price cannot be negative.');
	}

	const taxRate = Number(input.tax_rate ?? 0);
	if (taxRate < 0 || taxRate > 100) {
		throw new Error('Tax rate must be between 0 and 100.');
	}
}

function computeLineAmounts(invoice: WorkspaceRow<'invoices'>, line: Record<string, unknown>) {
	return lineAmounts({
		quantity: Number(line.quantity),
		unit_price: Number(line.unit_price),
		tax_rate: Number(line.tax_rate ?? 0),
		tax_inclusive: invoice.tax_inclusive,
		currency: requireCurrency(invoice.currency)
	});
}

async function assertNotOverBilling(
	api: Parameters<NonNullable<NonNullable<Hooks['create']>['before']>>[0]['api'],
	quoteLineId: string,
	orderedQuantity: number,
	lineQuantity: number,
	excludeLineId?: string
): Promise<void> {
	const existingLines = await api.db.query.invoice_lines.findMany({
		where: { quote_line_id: { eq: quoteLineId } },
		columns: { norbital_id: true, invoice_id: true, quantity: true },
		limit: LINE_LIMIT
	});

	const relevantLines = excludeLineId
		? existingLines.filter((line) => line.norbital_id !== excludeLineId)
		: existingLines;

	const invoiceIds = [...new Set(relevantLines.map((line) => line.invoice_id))];
	const cancelledIds = new Set<string>();
	if (invoiceIds.length > 0) {
		const invoices = await api.db.query.invoices.findMany({
			where: { norbital_id: { in: invoiceIds } },
			columns: { norbital_id: true, status: true },
			limit: LINE_LIMIT
		});
		for (const invoice of invoices) {
			if (invoice.status === 'cancelled') cancelledIds.add(invoice.norbital_id);
		}
	}

	const alreadyBilled = relevantLines
		.filter((line) => !cancelledIds.has(line.invoice_id))
		.reduce((sum, line) => sum + Number(line.quantity), 0);

	const remaining = orderedQuantity - alreadyBilled;
	if (alreadyBilled + lineQuantity > orderedQuantity) {
		throw new Error(
			`Cannot bill ${lineQuantity}: ordered quantity is ${orderedQuantity}, already billed ${alreadyBilled}, remaining ${remaining}.`
		);
	}
}

async function rollupInvoice(api: AfterApi, invoiceId: string): Promise<void> {
	const invoice = await api.db.query.invoices.findFirst({
		where: { norbital_id: { eq: invoiceId } }
	});
	if (!invoice) return;

	const lines = await api.db.query.invoice_lines.findMany({
		where: { invoice_id: { eq: invoiceId } },
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

	await api.db.mutate('invoices', [
		{
			norbital_id: invoiceId,
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
	readonly record: { readonly invoice_id: string };
	readonly api: AfterApi;
}) => {
	await rollupInvoice(api, record.invoice_id);
};

export default {
	create: {
		before: async ({ input, api }) => {
			if (!input.invoice_id) throw new Error('An invoice line must reference an invoice.');
			const invoice = await api.db.query.invoices.findFirst({
				where: { norbital_id: { eq: input.invoice_id } }
			});
			if (!invoice) throw new Error('Referenced invoice does not exist.');
			if (invoice.status !== 'draft') {
				throw new Error('Line items can only be added to draft invoices.');
			}

			if (!input.quote_line_id) {
				throw new Error('An invoice line must reference a sales document line.');
			}
			const quoteLine = await api.db.query.quote_lines.findFirst({
				where: { norbital_id: { eq: input.quote_line_id } }
			});
			if (!quoteLine) throw new Error('Referenced sales document line does not exist.');
			if (quoteLine.quote_id !== invoice.quote_id) {
				throw new Error(
					'Invoice line must bill a line from the same sales document as the invoice.'
				);
			}

			const resolved = {
				...input,
				product_id: quoteLine.product_id,
				product_code: quoteLine.product_code,
				product_name: quoteLine.product_name,
				product_unit: quoteLine.product_unit ?? '',
				unit_price: input.unit_price ?? quoteLine.unit_price,
				tax_rate: input.tax_rate ?? quoteLine.tax_rate ?? 0,
				quantity: input.quantity
			};
			validateLineFields(resolved);
			await assertNotOverBilling(
				api,
				input.quote_line_id,
				Number(quoteLine.quantity),
				Number(resolved.quantity)
			);

			const amounts = computeLineAmounts(invoice, resolved);
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
			if (input.invoice_id != null && input.invoice_id !== existing.invoice_id) {
				throw new Error('An invoice line cannot be moved to a different invoice.');
			}
			if (input.quote_line_id != null && input.quote_line_id !== existing.quote_line_id) {
				throw new Error('Sales document line cannot be changed on an invoice line.');
			}

			const invoice = await api.db.query.invoices.findFirst({
				where: { norbital_id: { eq: existing.invoice_id } }
			});
			if (!invoice) throw new Error('Referenced invoice does not exist.');
			if (invoice.status !== 'draft') {
				throw new Error('Line items can only be modified on draft invoices.');
			}

			const quoteLine = await api.db.query.quote_lines.findFirst({
				where: { norbital_id: { eq: existing.quote_line_id } }
			});
			if (!quoteLine) throw new Error('Referenced sales document line does not exist.');

			const resolved = { ...existing, ...input };
			validateLineFields(resolved);
			await assertNotOverBilling(
				api,
				existing.quote_line_id,
				Number(quoteLine.quantity),
				Number(resolved.quantity),
				existing.norbital_id
			);

			const amounts = computeLineAmounts(invoice, resolved);
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
