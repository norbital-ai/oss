import { defineEnv } from '@norbital-ai/pod/authoring';

/**
 * What this workspace needs from its host. Names only — a workspace never holds a secret value.
 *
 * The declaration is checked in both directions: referencing a name that is not here fails the build,
 * and declaring a name nothing references fails it too. So this file is a truthful answer to "what
 * must I provision to run this?" rather than a list that drifts.
 */
export default defineEnv({
	private: {
		EXTERNAL_SYSTEM_TOKEN: {
			description:
				'Bearer token for the external system of record reached by the external_synced_table integration.'
		}
	}
});
