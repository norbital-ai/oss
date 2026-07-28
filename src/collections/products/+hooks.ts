import type { Hooks } from './$types.js';

export default {
	update: {
		before: async ({ input, existing }) => {
			if (input.unit_price != null && input.unit_price !== existing.unit_price) {
				return { ...input, price_updated_at: new Date() };
			}
			return input;
		}
	}
} satisfies Hooks;
