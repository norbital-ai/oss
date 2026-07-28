import type { Hooks } from './$types.js';

export default {
	create: {
		before: async ({ input, api }) => {
			if (!input.account_id) throw new Error('A customer price must reference an account.');
			const account = await api.db.query.accounts.findFirst({
				where: { norbital_id: { eq: input.account_id } }
			});
			if (!account) throw new Error('Referenced account does not exist.');

			if (!input.product_id) throw new Error('A customer price must reference a product.');
			const product = await api.db.query.products.findFirst({
				where: { norbital_id: { eq: input.product_id } }
			});
			if (!product) throw new Error('Referenced product does not exist.');

			const existing = await api.db.query.customer_prices.findFirst({
				where: {
					account_id: { eq: input.account_id },
					product_id: { eq: input.product_id },
					active: { eq: true }
				}
			});
			if (existing) {
				throw new Error(
					'An active price already exists for this account and product. Deactivate the existing price first.'
				);
			}

			return { ...input, active: input.active ?? true };
		}
	}
} satisfies Hooks;
