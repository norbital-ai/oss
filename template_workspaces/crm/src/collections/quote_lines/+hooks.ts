import { documentTotals, lineAmounts } from '../../lib/pricing.js';
import type { Hooks, WorkspaceRow } from './$types.js';

type AfterApi = Parameters<NonNullable<NonNullable<Hooks['create']>['after']>['handler']>[0]['api'];
type CreateInput = Parameters<
	NonNullable<NonNullable<Hooks['create']>['before']>['handler']
>[0]['input'];
type UpdateInput = Parameters<
	NonNullable<NonNullable<Hooks['update']>['before']>['handler']
>[0]['input'];

const LINE_LIMIT = 5000;

function requireCurrency(currency: string | null): string {
	if (!currency) throw new Error('Document currency is required.');
	return currency;
}

function validateLineFields(input: {
	readonly quantity: number;
	readonly unit_price: number;
	readonly discount_pct?: number | null;
	readonly tax_rate?: number | null;
}): void {
	if (Number.isNaN(input.quantity) || input.quantity <= 0) {
		throw new Error('Quantity must be greater than zero.');
	}
	if (Number.isNaN(input.unit_price) || input.unit_price < 0) {
		throw new Error('Unit price cannot be negative.');
	}
	const discountPct = Number(input.discount_pct ?? 0);
	if (discountPct < 0 || discountPct > 100) {
		throw new Error('Discount percentage must be between 0 and 100.');
	}
	const taxRate = Number(input.tax_rate ?? 0);
	if (taxRate < 0 || taxRate > 100) {
		throw new Error('Tax rate must be between 0 and 100.');
	}
}

function computeLineAmounts(
	quote: WorkspaceRow<'quotes'>,
	line: CreateInput | WorkspaceRow<'quote_lines'>
) {
	return lineAmounts({
		quantity: Number(line.quantity),
		unit_price: Number(line.unit_price),
		discount_pct: Number(line.discount_pct ?? 0),
		tax_rate: Number(line.tax_rate ?? 0),
		tax_inclusive: quote.tax_inclusive,
		currency: requireCurrency(quote.currency)
	});
}

async function rollupQuote(api: AfterApi, quoteId: string): Promise<void> {
	const quote = await api.db.query.quotes.findFirst({
		where: { norbital_id: { eq: quoteId } }
	});
	if (!quote) return;

	const lines = await api.db.query.quote_lines.findMany({
		where: { quote_id: { eq: quoteId } },
		columns: { net: true, tax: true, line_total: true },
		limit: LINE_LIMIT
	});

	const totals = documentTotals(
		lines.map((line) => ({
			net: Number(line.net ?? 0),
			tax: Number(line.tax ?? 0),
			gross: Number(line.line_total ?? 0)
		})),
		requireCurrency(quote.currency)
	);

	await api.db.mutate('quotes', [
		{
			norbital_id: quoteId,
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
	readonly record: { readonly quote_id: string };
	readonly api: AfterApi;
}) => {
	await rollupQuote(api, record.quote_id);
};

export default {
	create: {
		before: {
			description:
				'Adds a line only to a draft quote for an active product, fills the product code, name, unit and tax rate from the catalogue, and computes the line net, tax and total from quantity, unit price and discount.',
			handler: async ({ input, api }) => {
				if (!input.quote_id) throw new Error('A quote line must reference a quote.');
				const quote = await api.db.query.quotes.findFirst({
					where: { norbital_id: { eq: input.quote_id } }
				});
				if (!quote) throw new Error('Referenced quote does not exist.');
				if (quote.status !== 'draft') {
					throw new Error('Line items can only be added to draft quotes.');
				}

				if (!input.product_id) throw new Error('A quote line must reference a product.');
				const product = await api.db.query.products.findFirst({
					where: { norbital_id: { eq: input.product_id } }
				});
				if (!product) throw new Error('Referenced product does not exist.');
				if (!product.active) {
					throw new Error('Cannot add a line for an inactive product.');
				}

				const resolved = {
					...input,
					product_code: input.product_code ?? product.code,
					product_name: input.product_name ?? product.name,
					product_unit: input.product_unit ?? product.unit ?? '',
					unit_price: input.unit_price ?? product.unit_price ?? 0,
					discount_pct: input.discount_pct ?? 0,
					tax_rate: input.tax_rate ?? product.tax_rate ?? 0
				};
				validateLineFields(resolved);

				const amounts = computeLineAmounts(quote, resolved);

				return {
					...resolved,
					net: amounts.net,
					tax: amounts.tax,
					line_total: amounts.gross
				};
			}
		},
		after: {
			description: 'Recomputes the quote net, tax and gross from its lines after a line is added.',
			handler: afterRollup
		}
	},
	update: {
		before: {
			description:
				'Keeps a line on its own draft quote and recomputes its net, tax and total from the changed quantity, unit price or discount.',
			handler: async ({ input, existing, api }) => {
				if (input.quote_id != null && input.quote_id !== existing.quote_id) {
					throw new Error('A line item cannot be moved to a different quote.');
				}

				const quote = await api.db.query.quotes.findFirst({
					where: { norbital_id: { eq: existing.quote_id } }
				});
				if (!quote) throw new Error('Referenced quote does not exist.');
				if (quote.status !== 'draft') {
					throw new Error('Line items can only be modified on draft quotes.');
				}

				const resolved = { ...existing, ...input };
				validateLineFields(resolved);

				const amounts = computeLineAmounts(quote, resolved);

				return {
					...input,
					net: amounts.net,
					tax: amounts.tax,
					line_total: amounts.gross
				} satisfies UpdateInput;
			}
		},
		after: {
			description:
				'Recomputes the quote net, tax and gross from its lines after a line is changed.',
			handler: afterRollup
		}
	},
	delete: {
		after: {
			description:
				'Recomputes the quote net, tax and gross from its lines after a line is removed.',
			handler: afterRollup
		}
	}
} satisfies Hooks;
