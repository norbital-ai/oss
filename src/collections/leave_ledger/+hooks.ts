import { refuse } from '@norbital-ai/pod/authoring';
import type { Hooks } from './$types.js';

/**
 * Invariant L1 — the leave ledger is insert-only. A mistake is corrected by posting a compensating
 * ADJUSTMENT row, never by rewriting or removing history.
 */
const INSERT_ONLY =
	'leave_ledger is insert-only. Post a compensating ADJUSTMENT row instead of changing or removing an existing entry.';

export default {
	update: {
		before: async () => {
			refuse(INSERT_ONLY);
		}
	},
	delete: {
		before: async () => {
			refuse(INSERT_ONLY);
		}
	}
} satisfies Hooks;
