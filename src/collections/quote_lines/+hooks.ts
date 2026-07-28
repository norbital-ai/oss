import type { Hooks } from './$types.js';

function computeLineTotal(
	quantity: number,
	unitPrice: number,
	discountPct: number,
	taxRate: number
): number {
	const net = Math.round(quantity * unitPrice * (1 - discountPct / 100) * 100) / 100;
	const tax = Math.round(net * (taxRate / 100) * 100) / 100;
	return Math.round((net + tax) * 100) / 100;
}

function validateLineFields(input: Record<string, unknown>): void {
	const quantity = Number(input.quantity);
	if (Number.isNaN(quantity) || quantity <= 0)
		throw new Error('Quantity must be greater than zero.');

	const unitPrice = Number(input.unit_price);
	if (Number.isNaN(unitPrice) || unitPrice < 0) throw new Error('Unit price cannot be negative.');

	const discountPct = Number(input.discount_pct ?? 0);
	if (discountPct < 0 || discountPct > 100)
		throw new Error('Discount percentage must be between 0 and 100.');

	const taxRate = Number(input.tax_rate ?? 0);
	if (taxRate < 0 || taxRate > 100) throw new Error('Tax rate must be between 0 and 100.');
}

export default {
	create: {
		before: async ({ input, api }) => {
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

			const accountId = quote.account_id;
			const customerPrice = await api.db.query.customer_prices.findFirst({
				where: {
					account_id: { eq: accountId },
					product_id: { eq: input.product_id },
					active: { eq: true }
				}
			});

			const cataloguePrice =
				input.unit_price ?? customerPrice?.unit_price ?? product.unit_price ?? 0;

			const resolved = {
				...input,
				product_code: input.product_code ?? product.code,
				product_name: input.product_name ?? product.name,
				product_unit: input.product_unit ?? product.unit ?? '',
				unit_price: cataloguePrice,
				discount_pct: input.discount_pct ?? 0,
				tax_rate: input.tax_rate ?? 0
			};
			validateLineFields(resolved);

			const quantity = Number(resolved.quantity);
			const unitPrice = Number(resolved.unit_price);
			const discountPct = Number(resolved.discount_pct);
			const taxRate = Number(resolved.tax_rate);

			return {
				...resolved,
				line_total: computeLineTotal(quantity, unitPrice, discountPct, taxRate)
			};
		}
	},
	update: {
		before: async ({ input, existing, api }) => {
			if (input.quote_id != null && input.quote_id !== existing.quote_id) {
				throw new Error('A line item cannot be moved to a different quote.');
			}
			const quoteId = (input.quote_id ?? existing.quote_id) as string;
			if (quoteId == null) return input;

			const quote = await api.db.query.quotes.findFirst({
				where: { norbital_id: { eq: quoteId } }
			});
			if (!quote) throw new Error('Referenced quote does not exist.');
			if (quote.status !== 'draft') {
				throw new Error('Line items can only be modified on draft quotes.');
			}

			const resolved = { ...existing, ...input };
			validateLineFields(resolved);
			return input;
		}
	}
} satisfies Hooks;
