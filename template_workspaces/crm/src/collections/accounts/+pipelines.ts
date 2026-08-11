import { z } from 'zod';
import type { Pipelines } from './$types.js';

const customersSchema = z.object({
	customers: z.array(
		z.object({
			external_code: z.string().trim().min(1),
			name: z.string().trim().min(1),
			currency: z.string().optional(),
			active: z.boolean().optional()
		})
	)
});

/**
 * Import the ERP's changed customers into `accounts`.
 *
 * The returned rows are written into this collection by the platform, which is what makes the
 * domain table the mirror. Rows already on file are skipped — the unique index on `external_code`
 * would reject them anyway, and a re-delivered page must be a skip, not a failed batch.
 */
export default {
	import: {
		description:
			'Mirrors the delivered ERP customer feed into accounts, skipping any customer whose external_code is already on file.',
		input: customersSchema,
		handler: async ({ input }, api) => {
			const customers = customersSchema.parse(input).customers;
			const codes = customers.map((customer) => customer.external_code);

			const existing = await api.db.query.accounts.findMany({
				where: { external_code: { in: codes } },
				columns: { external_code: true },
				limit: 20000
			});
			const known = new Set(existing.map((row) => row.external_code));

			return customers
				.filter((customer) => !known.has(customer.external_code))
				.map((customer) => ({
					external_code: customer.external_code,
					name: customer.name,
					industry: null,
					website: null,
					phone: null,
					currency: customer.currency ?? null,
					address: null,
					active: customer.active ?? true
				}));
		}
	}
} satisfies Pipelines;
