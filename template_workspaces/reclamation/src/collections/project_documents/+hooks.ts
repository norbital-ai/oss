import type { Hooks } from './$types.js';

/**
 * Refuse a reconstruction document that does not say what it is.
 *
 * The engine acts on the role, not on the file name, so an unlabelled attachment would either be
 * guessed at or silently ignored. Rejecting it in `before` is the only same-transaction decision
 * this collection needs.
 *
 * Keeping the model in step with the documents is not a hook: it writes to `site_reconstructions`,
 * which is another collection, after this row is durable. The three
 * `src/automation/+reconstruct_*_document.ts` automations own that, and the input fingerprint keeps
 * a redelivered event from appending an identical revision.
 */
export default {
	create: {
		before: {
			description:
				'Rejects a reconstruction-category document that arrives without a document_role, since the stitch engine decides what to read from the role rather than the file name.',
			handler: async ({ input }) => {
				if (input.category === 'reconstruction' && input.document_role == null) {
					throw new Error(
						'A reconstruction document needs a role: additional sections, additional bathymetry, or supporting.'
					);
				}
				return input;
			}
		}
	}
} satisfies Hooks;
