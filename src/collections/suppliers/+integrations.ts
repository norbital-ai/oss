import { defineConnection } from '@norbital-ai/pod/authoring';
import { z } from 'zod';
import type { Integrations } from './$types.js';

const erp = defineConnection({
	baseUrl: 'https://erp.internal.example/api/v1',
	authentication: { type: 'bearer', token: { env: 'EXTERNAL_SYSTEM_TOKEN' } }
});

/**
 * Inbound: the ERP syncs vendors into our table.
 *
 * The pull binding is a scheduled job. The host fetches changed vendors, parses the body against
 * `input`, hands it to this collection's `import` pipeline, and writes the rows the pipeline
 * returns — so `suppliers` *is* the mirror. The cursor is kept by the platform, so a missed window
 * resumes where it stopped.
 */
export default {
	erp: {
		connection: erp,
		receive: {
			vendors_changed: {
				pull: {
					schedule: '15 * * * *',
					method: 'GET',
					path: '/masters/vendors/changed',
					cursorQuery: 'since',
					nextCursorHeader: 'x-next-cursor'
				},
				input: z.object({
					vendors: z.array(
						z.object({
							external_code: z.string().trim().min(1),
							name: z.string().trim().min(1),
							currency: z.string().optional(),
							payment_terms_days: z.number().int().nonnegative().max(365).optional(),
							active: z.boolean().optional()
						})
					)
				})
			}
		}
	}
} satisfies Integrations;
