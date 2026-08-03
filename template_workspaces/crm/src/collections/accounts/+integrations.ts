import { defineConnection } from '@norbital-ai/pod/authoring';
import { z } from 'zod';
import type { Integrations } from './$types.js';

/**
 * The external system of record this workspace mirrors from.
 *
 * `baseUrl` is a deployment fact, so a template can only ship a placeholder — repoint it before
 * enabling the integration. The credential is a *reference*: the name is declared in `src/+env.ts`
 * and resolved by the host at call time, so no secret value ever lives in the workspace.
 */
const erp = defineConnection({
	baseUrl: 'https://erp.internal.example/api/v1',
	authentication: { type: 'bearer', token: { env: 'EXTERNAL_SYSTEM_TOKEN' } }
});

/**
 * Inbound: the ERP syncs customers into our table.
 *
 * The pull binding is a scheduled job. The host fetches changed customers, parses the body against
 * `input`, hands it to this collection's `import` pipeline, and writes the rows the pipeline
 * returns — so `accounts` *is* the mirror. The cursor is kept by the platform
 * (`integration_cursor`), so a missed window resumes where it stopped.
 */
export default {
	erp: {
		connection: erp,
		receive: {
			customers_changed: {
				pull: {
					schedule: '15 * * * *',
					method: 'GET',
					path: '/masters/customers/changed',
					cursorQuery: 'since',
					nextCursorHeader: 'x-next-cursor'
				},
				input: z.object({
					customers: z.array(
						z.object({
							external_code: z.string().trim().min(1),
							name: z.string().trim().min(1),
							currency: z.string().optional(),
							active: z.boolean().optional()
						})
					)
				})
			}
		}
	}
} satisfies Integrations;
