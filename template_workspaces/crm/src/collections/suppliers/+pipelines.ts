import { z } from 'zod';
import type { Pipelines } from './$types.js';

const vendorsSchema = z.object({
	vendors: z.array(
		z.object({
			external_code: z.string().trim().min(1),
			name: z.string().trim().min(1),
			currency: z.string().optional(),
			payment_terms_days: z.number().int().nonnegative().max(365).optional(),
			active: z.boolean().optional()
		})
	)
});

/**
 * Import the ERP's changed vendors into `suppliers`.
 *
 * The returned rows are written into this collection by the platform, which is what makes the
 * domain table the mirror. Rows already on file are skipped — the unique index on `external_code`
 * would reject them anyway, and a re-delivered page must be a skip, not a failed batch.
 */
export default {
	import: {
		description:
			'Mirrors the delivered ERP vendor feed into suppliers, skipping any vendor whose external_code is already on file.',
		input: vendorsSchema,
		handler: async ({ input }, api) => {
			const vendors = vendorsSchema.parse(input).vendors;
			const codes = vendors.map((vendor) => vendor.external_code);

			const existing = await api.db.query.suppliers.findMany({
				where: { external_code: { in: codes } },
				columns: { external_code: true },
				limit: 20000
			});
			const known = new Set(existing.map((row) => row.external_code));

			return vendors
				.filter((vendor) => !known.has(vendor.external_code))
				.map((vendor) => ({
					external_code: vendor.external_code,
					code: vendor.external_code,
					name: vendor.name,
					category: null,
					currency: vendor.currency ?? null,
					payment_terms_days: vendor.payment_terms_days ?? null,
					phone: null,
					email: null,
					address: null,
					active: vendor.active ?? true
				}));
		}
	}
} satisfies Pipelines;
