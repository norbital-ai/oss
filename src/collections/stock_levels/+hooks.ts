import type { Hooks } from './$types.js';

function validateNonNegative(value: unknown, label: string): void {
	if (value == null) return;
	const numeric = Number(value);
	if (Number.isNaN(numeric) || numeric < 0) {
		throw new Error(`${label} cannot be negative.`);
	}
}

export default {
	create: {
		before: async ({ input, api }) => {
			if (!input.product_id) throw new Error('A stock level must reference a product.');
			const product = await api.db.query.products.findFirst({
				where: { norbital_id: { eq: input.product_id } }
			});
			if (!product) throw new Error('Referenced product does not exist.');

			validateNonNegative(input.qty_on_hand, 'Quantity on hand');
			validateNonNegative(input.unit_cost, 'Unit cost');

			const now = new Date();
			return {
				...input,
				...(input.qty_on_hand != null && input.qty_as_of == null ? { qty_as_of: now } : {}),
				...(input.unit_cost != null && input.cost_as_of == null ? { cost_as_of: now } : {})
			};
		}
	},
	update: {
		before: async ({ input, existing }) => {
			if (input.product_id != null && input.product_id !== existing.product_id) {
				throw new Error('Product cannot be changed on a stock level.');
			}

			const resolved = { ...existing, ...input };
			validateNonNegative(resolved.qty_on_hand, 'Quantity on hand');
			validateNonNegative(resolved.unit_cost, 'Unit cost');

			const now = new Date();
			return {
				...input,
				...(input.qty_on_hand != null &&
				input.qty_on_hand !== existing.qty_on_hand &&
				input.qty_as_of == null
					? { qty_as_of: now }
					: {}),
				...(input.unit_cost != null &&
				input.unit_cost !== existing.unit_cost &&
				input.cost_as_of == null
					? { cost_as_of: now }
					: {})
			};
		}
	}
} satisfies Hooks;
