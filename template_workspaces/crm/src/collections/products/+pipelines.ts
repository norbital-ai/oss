import { z } from 'zod';
import type { Pipelines } from './$types.js';

const itemsSchema = z.object({
	items: z.array(
		z.object({
			external_code: z.string().trim().min(1),
			name: z.string().trim().min(1),
			unit: z.string().optional(),
			unit_price: z.number().nonnegative().optional(),
			active: z.boolean().optional()
		})
	)
});

/**
 * Import the ERP's changed items into `products`.
 *
 * The returned rows are written into this collection by the platform, which is what makes the
 * domain table the mirror. Rows already on file are skipped — the unique index on `external_code`
 * would reject them anyway, and a re-delivered page must be a skip, not a failed batch.
 */
export default {
	import: {
		description:
			'Mirrors the delivered ERP item feed into the product catalogue, skipping any item whose external_code is already on file.',
		input: itemsSchema,
		handler: async ({ input }, api) => {
			const items = itemsSchema.parse(input).items;
			const codes = items.map((item) => item.external_code);

			const existing = await api.db.query.products.findMany({
				where: { external_code: { in: codes } },
				columns: { external_code: true },
				limit: 20000
			});
			const known = new Set(existing.map((row) => row.external_code));

			return items
				.filter((item) => !known.has(item.external_code))
				.map((item) => ({
					external_code: item.external_code,
					// The ERP item code is the natural catalogue code; a tenant that uses its own
					// codes can set them here instead.
					code: item.external_code,
					name: item.name,
					description: null,
					unit: item.unit ?? null,
					unit_price: item.unit_price ?? null,
					active: item.active ?? true
				}));
		}
	}
} satisfies Pipelines;
