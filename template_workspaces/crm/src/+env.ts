import { defineEnvVars } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

/**
 * Names only — values are pasted in Settings → Integrations and are always optional.
 * Read private keys from `$app/env/private` on the server.
 */
export const variables = defineEnvVars({
	EXTERNAL_SYSTEM_TOKEN: {
		description:
			'Bearer token for the external system of record reached by the external_synced_table integration.',
		schema: z.string().trim().min(1)
	}
});
